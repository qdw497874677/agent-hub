import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProject } from '../project.ts';
import { createTask } from '../task.ts';
import { deriveSession } from '../session.ts';
import { asAgentId, type SessionId } from '../ids.ts';
import type { Principal, Role, User, UserId } from '../account.ts';
import type { AgentRole } from '../messaging.ts';
import type { GroupStore } from '../ports/group-store.ts';
import type { Group, GroupDelivery, GroupPost, GroupThread } from '../groups.ts';
import {
  groupProblem,
  parseMentions,
  parseStopCommand,
  isSilent,
  parseBid,
  pickVolunteer,
  parseHostText,
  validateDispatch,
  HOST_UNAVAILABLE_LINE,
  HOST_TIMEOUT_MS
} from '../groups.ts';
import { recordEvent } from './sessions.ts';
import { createGroupChat } from './groups.ts';
import { createPersistentAgents } from './persistent-agents.ts';
import { configProblem, type MessagingConfig } from '../messaging.ts';

function memoryGroups(): GroupStore & { deliveriesAll: () => GroupDelivery[] } {
  const groups = new Map<string, Group>();
  const posts: GroupPost[] = [];
  const threads = new Map<string, GroupThread>();
  const deliveries = new Map<string, GroupDelivery>();
  const sessions: { groupId: string; role: string; sessionId: SessionId }[] = [];
  const ds = () => [...deliveries.values()].sort((a, b) => a.createdAt - b.createdAt);
  return {
    deliveriesAll: ds,
    saveGroup: async (g) => void groups.set(g.id, g),
    group: async (id) => groups.get(id) ?? null,
    groupsOf: async (p) => [...groups.values()].filter((g) => g.projectId === p),
    appendPost: async (p) => {
      const post = { ...p, seq: posts.filter((x) => x.groupId === p.groupId).length + 1 };
      posts.push(post);
      return post;
    },
    posts: async (g, after, limit) => {
      const mine = posts.filter((p) => p.groupId === g);
      return after === null ? mine.slice(-limit) : mine.filter((p) => p.seq > after).slice(0, limit);
    },
    saveThread: async (t) => void threads.set(t.id, t),
    thread: async (id) => threads.get(id) ?? null,
    threads: async (g, limit) => [...threads.values()].filter((t) => t.groupId === g).reverse().slice(0, limit),
    runningThreads: async (g) => [...threads.values()].filter((t) => t.groupId === g && t.status === 'running'),
    saveDelivery: async (d) => void deliveries.set(d.id, d),
    deliveries: async (t) => ds().filter((d) => d.threadId === t),
    queuedFor: async (s) => ds().filter((d) => d.sessionId === s && d.status === 'queued'),
    deliveredTo: async (s) => ds().filter((d) => d.sessionId === s && d.status === 'delivered'),
    openBefore: async (before) => ds().filter((d) => (d.status === 'queued' || d.status === 'delivered') && d.createdAt < before),
    sessionFor: async (g, r) => sessions.find((s) => s.groupId === g && s.role === r)?.sessionId ?? null,
    setSession: async (g, r, s) => {
      const i = sessions.findIndex((x) => x.groupId === g && x.role === r);
      if (i >= 0) sessions.splice(i, 1);
      sessions.push({ groupId: g, role: r, sessionId: s });
    },
    sessionsOf: async (g) => sessions.filter((s) => s.groupId === g).map(({ role, sessionId }) => ({ role, sessionId })),
    memberOfSession: async (s) => {
      const found = sessions.find((x) => x.sessionId === s);
      return found ? { groupId: found.groupId, role: found.role } : null;
    }
  };
}

const user = (id: string, role: Role): User =>
  ({ id: id as UserId, email: `${id}@x.test`, displayName: id, role, passwordHash: null, emailVerifiedAt: 1, disabledAt: null, createdAt: 1, teamId: 'T', clusterAdmin: false, deletedAt: null }) as unknown as User;

const ROLES: AgentRole[] = [
  { name: 'host', description: '分派', agentId: 'pi', model: 'm-host', reuse: 'sticky' },
  { name: 'coder', description: '写代码', agentId: 'pi', model: '', reuse: 'sticky' },
  { name: 'reviewer', description: '审代码', agentId: 'pi', model: '', reuse: 'sticky' },
  { name: 'nomodel', description: '', agentId: 'pi', model: '', reuse: 'sticky' }
];

async function world() {
  const busyElsewhere = new Set<string>();
  const roleList: AgentRole[] = [...ROLES];
  let clock = 1000;
  const memory = inMemoryDeps({ now: () => clock });
  const deps = memory.deps;
  const groups = memoryGroups();
  const users = new Map<string, User>([
    ['alice', user('alice', 'member')],
    ['vicky', user('vicky', 'viewer')],
    ['mallory', user('mallory', 'member')],
    ['olga', user('olga', 'owner')]
  ]);
  const principal = (id: string): Principal | null => {
    const u = users.get(id);
    return u ? ({ user: u, loginId: 'l' } as unknown as Principal) : null;
  };
  const project = createProject({ name: 'p', now: 1, teamId: 'T', createdBy: 'alice' });
  assert.ok(project.ok);
  await deps.projects.save({ ...project.value, members: ['vicky'] } as never);
  const delivered: { sessionId: SessionId; text: string }[] = [];
  const interrupted: SessionId[] = [];
  const chat = createGroupChat({
    now: () => clock,
    sessions: deps.sessions,
    projects: deps.projects,
    tasks: deps.tasks,
    groups,
    policy: { context: async () => ({ hubTeamId: 'T', settings: { membersCanAddMachines: false } }), worker: async () => ({}) as never } as never,
    roles: async () => roleList,
    principalOf: async (id) => principal(id),
    deliver: async (sessionId, text) => {
      delivered.push({ sessionId, text });
      await recordEvent(deps, { sessionId, event: { kind: 'prompt', text } });
      return { ok: true, value: null } as never;
    },
    spawn: async ({ project: p, role, actor }) => {
      const t = createTask({ projectId: p.id, title: 'g', goal: '', now: clock });
      assert.ok(t.ok);
      await deps.tasks.save(t.value);
      const s = deriveSession({ task: t.value, agentId: asAgentId(role.agentId), model: role.model, now: clock, createdBy: actor.user.id });
      assert.ok(s.ok);
      await deps.sessions.save(s.value);
      return s;
    },
    interrupt: async (sid) => void interrupted.push(sid),
    occupied: async (sid) => busyElsewhere.has(sid)
  });
  const alice = principal('alice')!;
  const sessionOf = async (groupId: string, role: string) => (await groups.sessionFor(groupId, role))!;
  const finish = async (sessionId: SessionId, text: string) => {
    if (text) await recordEvent(deps, { sessionId, event: { kind: 'text', delta: text } });
    await recordEvent(deps, { sessionId, event: { kind: 'ended', outcome: 'done' } as never });
    await chat.turnEnded(sessionId);
  };
  const posts = async (groupId: string) => {
    const r = await chat.posts(alice, groupId, 0, 200);
    assert.ok(r.ok);
    return r.value;
  };
  const lastDelivery = (sid: SessionId) => [...delivered].reverse().find((d) => d.sessionId === sid);
  return { recordPrompt: async (sid: SessionId, text: string) => {
      await recordEvent(deps, { sessionId: sid, event: { kind: 'prompt', text } });
      const s = (await deps.sessions.byId(sid))!;
      await deps.sessions.save({ ...s, status: 'running' });
    }, roleList, deps, busyElsewhere, chat, groups, alice, principal, project: project.value, delivered, interrupted, sessionOf, finish, posts, lastDelivery, tick: (ms: number) => void (clock += ms) };
}

test('纯函数：@ 提及忽略代码块和引用；停止命令；[SILENT]；竞价', () => {
  const members = ['coder', 'reviewer'];
  assert.deepEqual(parseMentions('请 @coder 看看，@REVIEWER 也看', members).members, ['coder', 'reviewer']);
  assert.deepEqual(parseMentions('```\n@coder\n```\n> @reviewer 说过\n`@coder`', members).members, []);
  assert.equal(parseMentions('邮件 a@coder.com', members).members.length, 0);
  assert.deepEqual(parseMentions('@all 开会', members).members, members);
  assert.equal(parseMentions('@user 你定', members).user, true);
  assert.deepEqual(parseMentions('@perf 来', members).outsiders, ['perf']);
  assert.deepEqual(parseStopCommand('停止 @coder', members), ['coder']);
  assert.deepEqual(parseStopCommand('stop @coder @reviewer', members), ['coder', 'reviewer']);
  assert.equal(parseStopCommand('```\n停止 @coder\n```', members), null);
  assert.equal(parseStopCommand('> stop @coder', members), null);
  assert.equal(parseStopCommand('@coder 停止这个循环', members), null);
  assert.ok(isSilent('[SILENT]') && isSilent(' `[silent]` ') && isSilent('') && !isSilent('[SILENT] 不过……'));
  assert.deepEqual(parseBid('{"score":0.8,"message":"我来"}'), { score: 0.8, message: '我来' });
  assert.equal(parseBid('[SILENT]'), null);
  assert.equal(parseBid('{"score":1.5,"message":"x"}'), null);
  const bids = [
    { role: 'coder', bid: { score: 0.65, message: 'a' } },
    { role: 'reviewer', bid: { score: 0.6, message: 'b' } }
  ];
  assert.equal(pickVolunteer(bids, null)?.role, 'coder');
  assert.equal(pickVolunteer(bids, 'coder')?.role, 'reviewer', '刚说过的减 0.2');
  assert.equal(pickVolunteer([{ role: 'coder', bid: { score: 0.4, message: 'a' } }], null), null, '门槛 0.5');
});

test('纯函数：主持人分派只能派群成员、最多 3 个、不能派自己', () => {
  const members = ['host', 'a', 'b', 'c', 'd'];
  assert.deepEqual(validateDispatch({ assignees: ['a', '@b'] }, members, 'host'), { kind: 'assign', assignees: ['a', 'b'], note: '' });
  assert.equal(validateDispatch({ assignees: ['a', 'b', 'c', 'd'] }, members, 'host').kind, 'invalid');
  assert.equal(validateDispatch({ assignees: ['zed'] }, members, 'host').kind, 'invalid');
  assert.equal(validateDispatch({ assignees: ['host'] }, members, 'host').kind, 'invalid');
  assert.equal(validateDispatch({ decline: true, reply: 'hi' }, members, 'host').kind, 'decline');
  assert.deepEqual(parseHostText('好的\n```json\n{"assignees":["a"]}\n```', members, 'host'), { kind: 'assign', assignees: ['a'], note: '' });
  assert.equal(parseHostText('交给 @b 吧', members, 'host').kind, 'assign');
  assert.equal(parseHostText('嗯……', members, 'host').kind, 'invalid');
});

test('纯函数：建群校验——主持人要显式模型、上限 5 轮 / 20 条', () => {
  const base = { name: 'g', members: ['host', 'coder'], hostRole: 'host' };
  assert.equal(groupProblem(base, ROLES), null);
  assert.match(groupProblem({ ...base, members: ['host', 'nomodel'], hostRole: 'nomodel' }, ROLES) ?? '', /显式/);
  assert.match(groupProblem({ ...base, hostRole: 'reviewer' }, ROLES) ?? '', /群成员/);
  assert.match(groupProblem({ ...base, members: ['ghost'], hostRole: null }, ROLES) ?? '', /没有角色/);
  assert.match(groupProblem({ ...base, limits: { maxRounds: 6 } }, ROLES) ?? '', /最多 5/);
  assert.match(groupProblem({ ...base, limits: { maxMessages: 21 } }, ROLES) ?? '', /最多 20/);
  assert.equal(groupProblem({ ...base, limits: { maxRounds: 5, maxMessages: 20 } }, ROLES), null);
});

test('权限：viewer 能看不能建群、不能说话；外人看不到', async () => {
  const w = await world();
  const denied = await w.chat.create(w.principal('vicky')!, w.project.id, { name: 'g', members: ['coder'], hostRole: null });
  assert.ok(!denied.ok);
  const g = await w.chat.create(w.alice, w.project.id, { name: 'g', members: ['coder'], hostRole: null });
  assert.ok(g.ok);
  assert.ok((await w.chat.view(w.principal('vicky')!, g.value.id)).ok);
  assert.ok(!(await w.chat.post(w.principal('vicky')!, g.value.id, 'hi')).ok);
  const outsider = await w.chat.view(w.principal('mallory')!, g.value.id);
  assert.ok(!outsider.ok && outsider.error.code === 'not_found');
});

test('@ 成员直接投递、跳过主持人；常驻会话复用；[SILENT] 记下但不贴', async () => {
  const w = await world();
  const g = await w.chat.create(w.alice, w.project.id, { name: 'g', members: ['host', 'coder', 'reviewer'], hostRole: 'host' });
  assert.ok(g.ok);
  await w.chat.post(w.alice, g.value.id, '@coder 写个函数');
  assert.equal(await w.groups.sessionFor(g.value.id, 'host'), null, '没叫主持人');
  const coder = await w.sessionOf(g.value.id, 'coder');
  assert.match(w.lastDelivery(coder)!.text, /写个函数/);
  await w.finish(coder, '写好了');
  let posts = await w.posts(g.value.id);
  assert.ok(posts.some((p) => p.author.kind === 'agent' && p.author.role === 'coder' && p.body === '写好了'));

  await w.chat.post(w.alice, g.value.id, '@coder 还有吗');
  assert.equal(await w.sessionOf(g.value.id, 'coder'), coder, '同一个群同一个角色同一条会话');
  await w.finish(coder, '[SILENT]');
  posts = await w.posts(g.value.id);
  assert.ok(!posts.some((p) => p.body === '[SILENT]'), '[SILENT] 不贴');
  assert.ok(posts.some((p) => p.author.kind === 'system' && /都没说话/.test(p.body)), '整轮沉默结束');
  const chains = await w.chat.chains(w.alice, g.value.id, 10);
  assert.ok(chains.ok);
  assert.ok(chains.value.some((c) => c.deliveries.some((d) => d.status === 'silent' && d.result === '[SILENT]')), '调用链里记下了 [SILENT]');
});

test('主持人：工具分派 → 成员回复 → @ 接力；没配主持人走兜底', async () => {
  const w = await world();
  const g = await w.chat.create(w.alice, w.project.id, { name: 'g', members: ['host', 'coder', 'reviewer'], hostRole: 'host' });
  assert.ok(g.ok);
  await w.chat.post(w.alice, g.value.id, '帮我加个登录页');
  const host = await w.sessionOf(g.value.id, 'host');
  assert.match(w.lastDelivery(host)!.text, /group_dispatch/);
  assert.ok(!(await w.chat.dispatch(host, { assignees: ['a', 'b', 'c', 'd'] })).ok, '超过 3 个被拒');
  assert.ok(!(await w.chat.dispatch(host, { assignees: ['outsider'] })).ok, '非成员被拒');
  const r = await w.chat.dispatch(host, { assignees: ['coder'], note: '先写' });
  assert.ok(r.ok);
  await w.finish(host, '');
  const coder = await w.sessionOf(g.value.id, 'coder');
  assert.match(w.lastDelivery(coder)!.text, /先写/);
  await w.finish(coder, '写好了，@reviewer 帮我看看');
  const reviewer = await w.sessionOf(g.value.id, 'reviewer');
  assert.match(w.lastDelivery(reviewer)!.text, /帮我看看/);
  await w.finish(reviewer, '没问题 @user 可以合并了');
  const view = await w.chat.view(w.alice, g.value.id);
  assert.ok(view.ok && view.value.group.needsUser, '@user 亮「需要你」');
  await w.chat.post(w.alice, g.value.id, '好的');
  const after = await w.chat.view(w.alice, g.value.id);
  assert.ok(after.ok && !after.value.group.needsUser, '人回复后清掉');

  const g2 = await w.chat.create(w.alice, w.project.id, { name: 'g2', members: ['coder'], hostRole: null });
  assert.ok(g2.ok);
  await w.chat.post(w.alice, g2.value.id, '有人吗');
  assert.ok((await w.posts(g2.value.id)).some((p) => p.author.kind === 'system' && p.body.startsWith(HOST_UNAVAILABLE_LINE)));
});

test('主持人 2 分钟没结果 → 兜底系统行；文字回复也能认出分派', async () => {
  const w = await world();
  const g = await w.chat.create(w.alice, w.project.id, { name: 'g', members: ['host', 'coder'], hostRole: 'host' });
  assert.ok(g.ok);
  await w.chat.post(w.alice, g.value.id, '一');
  w.tick(HOST_TIMEOUT_MS + 1);
  assert.equal(await w.chat.sweep(), 1);
  assert.ok((await w.posts(g.value.id)).some((p) => p.body.startsWith(HOST_UNAVAILABLE_LINE)));
  const host = await w.sessionOf(g.value.id, 'host');
  await w.finish(host, '{"assignees":["coder"]}');
  assert.equal(await w.groups.sessionFor(g.value.id, 'coder'), null, '超时之后的结果不再生效');

  await w.chat.post(w.alice, g.value.id, '二');
  await w.finish(host, '{"assignees":["coder"]}');
  assert.ok(await w.groups.sessionFor(g.value.id, 'coder'), '文字 JSON 也能分派');
});

test('防失控：轮数上限、条数上限', async () => {
  const w = await world();
  const g = await w.chat.create(w.alice, w.project.id, { name: 'g', members: ['coder', 'reviewer'], hostRole: null, limits: { maxRounds: 2 } });
  assert.ok(g.ok);
  await w.chat.post(w.alice, g.value.id, '@coder 开始');
  const coder = await w.sessionOf(g.value.id, 'coder');
  await w.finish(coder, '@reviewer 你说');
  const reviewer = await w.sessionOf(g.value.id, 'reviewer');
  const before = w.delivered.length;
  await w.finish(reviewer, '@coder 你说');
  assert.equal(w.delivered.length, before, '第 3 轮不再投递');
  assert.ok((await w.posts(g.value.id)).some((p) => /2 轮上限/.test(p.body)));

  const g2 = await w.chat.create(w.alice, w.project.id, { name: 'g2', members: ['coder', 'reviewer'], hostRole: null, limits: { maxMessages: 1 } });
  assert.ok(g2.ok);
  await w.chat.post(w.alice, g2.value.id, '@all 说话');
  const c2 = await w.sessionOf(g2.value.id, 'coder');
  const r2 = await w.sessionOf(g2.value.id, 'reviewer');
  await w.finish(c2, '一');
  await w.finish(r2, '二');
  const agentPosts = (await w.posts(g2.value.id)).filter((p) => p.author.kind === 'agent');
  assert.equal(agentPosts.length, 1, '超过条数上限的不贴');
});

test('停止：取消排队、暂停全部到人再发言；「停止 @x」只暂停 x', async () => {
  const w = await world();
  const g = await w.chat.create(w.alice, w.project.id, { name: 'g', members: ['coder', 'reviewer'], hostRole: null });
  assert.ok(g.ok);
  await w.chat.post(w.alice, g.value.id, '@all 开始');
  const stopped = await w.chat.stop(w.alice, g.value.id);
  assert.ok(stopped.ok && stopped.value.held.includes('*'));
  assert.equal(w.interrupted.length, 2, '正在跑的回合尽量打断');
  const coder = await w.sessionOf(g.value.id, 'coder');
  await w.finish(coder, '迟到的回复');
  assert.ok(!(await w.posts(g.value.id)).some((p) => p.body === '迟到的回复'), '停止后迟到的回复不贴');

  await w.chat.post(w.alice, g.value.id, '停止 @reviewer');
  let view = await w.chat.view(w.alice, g.value.id);
  assert.ok(view.ok && view.value.group.held.includes('reviewer') && view.value.group.held.includes('*'), '停止命令不解除暂停');
  await w.chat.post(w.alice, g.value.id, '@all 继续');
  view = await w.chat.view(w.alice, g.value.id);
  assert.ok(view.ok && view.value.group.held.length === 0, '人正常发言后恢复');
  const reviewer = await w.sessionOf(g.value.id, 'reviewer');
  await w.chat.post(w.alice, g.value.id, '停止 @reviewer');
  await w.finish(reviewer, '我还在说');
  assert.ok(!(await w.posts(g.value.id)).some((p) => p.body === '我还在说'));
  await w.finish(coder, '我说完了');
  assert.ok((await w.posts(g.value.id)).some((p) => p.body === '我说完了'), 'coder 不受影响');
  await w.chat.post(w.alice, g.value.id, '```\n停止 @coder\n```');
  view = await w.chat.view(w.alice, g.value.id);
  assert.ok(view.ok && !view.value.group.held.includes('coder'), '代码块里的停止不算');
});

test('volunteer：并行竞价，过门槛的最高分发言，一轮一条；都不竞价就结束', async () => {
  const w = await world();
  const g = await w.chat.create(w.alice, w.project.id, { name: 'g', members: ['coder', 'reviewer'], hostRole: null, speakingStrategy: 'volunteer', limits: { maxRounds: 1 } });
  assert.ok(g.ok);
  await w.chat.post(w.alice, g.value.id, '谁来看看');
  const coder = await w.sessionOf(g.value.id, 'coder');
  const reviewer = await w.sessionOf(g.value.id, 'reviewer');
  assert.match(w.lastDelivery(coder)!.text, /score/);
  await w.finish(coder, '{"score":0.4,"message":"我不太行"}');
  await w.finish(reviewer, '{"score":0.9,"message":"我来看"}');
  const agentPosts = (await w.posts(g.value.id)).filter((p) => p.author.kind === 'agent');
  assert.deepEqual(agentPosts.map((p) => p.body), ['我来看']);

  await w.chat.post(w.alice, g.value.id, '还有吗');
  await w.finish(coder, '[SILENT]');
  await w.finish(reviewer, '[SILENT]');
  assert.ok((await w.posts(g.value.id)).some((p) => /没有成员愿意接话/.test(p.body)));
});

test('同一条会话被 P2P 消息占着时，群投递排队，对方收尾后再投（不交错）', async () => {
  const w = await world();
  const g = await w.chat.create(w.alice, w.project.id, { name: 'g', members: ['coder'], hostRole: null });
  assert.ok(g.ok);
  await w.chat.post(w.alice, g.value.id, '@coder 第一件');
  const coder = await w.sessionOf(g.value.id, 'coder');
  await w.finish(coder, '好');
  w.busyElsewhere.add(coder);
  const before = w.delivered.length;
  await w.chat.post(w.alice, g.value.id, '@coder 第二件');
  assert.equal(w.delivered.length, before, '别的通道在等回复，先不投');
  w.busyElsewhere.delete(coder);
  await w.chat.turnEnded(coder);
  assert.match(w.lastDelivery(coder)!.text, /第二件/);
});

test('只能 @ 群成员：@ 群外角色只给提示、不派生；有 group.manage 的人把它加进群，加完不重放', async () => {
  const w = await world();
  const g = await w.chat.create(w.alice, w.project.id, { name: 'g', members: ['host', 'coder'], hostRole: 'host' });
  assert.ok(g.ok);
  const root = await w.chat.post(w.alice, g.value.id, '@reviewer 帮忙看下 @nobody');
  assert.ok(root.ok);
  assert.equal(await w.groups.sessionFor(g.value.id, 'host'), null, '有 @ 的消息不经过主持人');
  let posts = await w.posts(g.value.id);
  assert.ok(posts.some((p) => p.author.kind === 'system' && /@reviewer 不在这个群里，只能 @ 群成员/.test(p.body)));
  assert.ok(posts.some((p) => p.author.kind === 'system' && /@nobody 不在这个群里，也不是这个项目的 bot/.test(p.body)));
  assert.equal(await w.groups.sessionFor(g.value.id, 'reviewer'), null, '不派生');

  const vicky = w.principal('vicky')!;
  const vv = await w.chat.view(vicky, g.value.id);
  assert.ok(vv.ok && vv.value.canManage === false, 'viewer 看不到加入按钮');
  assert.ok(!(await w.chat.addMember(vicky, g.value.id, 'reviewer')).ok, 'viewer 不能加');
  const av = await w.chat.view(w.alice, g.value.id);
  assert.ok(av.ok && av.value.canManage === true);
  assert.ok(!(await w.chat.addMember(w.alice, g.value.id, 'nobody')).ok, '不是项目角色');
  assert.ok(!(await w.chat.addMember(w.alice, g.value.id, 'coder')).ok, '已经是成员');
  const added = await w.chat.addMember(w.alice, g.value.id, 'reviewer');
  assert.ok(added.ok && added.value.members.includes('reviewer'), added.ok ? '' : added.error.message);
  assert.equal(await w.groups.sessionFor(g.value.id, 'reviewer'), null, '加完不自动重放');
  posts = await w.posts(g.value.id);
  assert.ok(posts.some((p) => p.author.kind === 'system' && /把 @reviewer 加进了群/.test(p.body)));

  await w.chat.post(w.alice, g.value.id, '@reviewer 再看下');
  const reviewer = await w.sessionOf(g.value.id, 'reviewer');
  assert.match(w.lastDelivery(reviewer)!.text, /再看下/);
});

test('硬停：停止也打断群会话里没有群投递、但还在跑的回合', async () => {
  const w = await world();
  const g = await w.chat.create(w.alice, w.project.id, { name: 'g', members: ['coder', 'reviewer'], hostRole: null });
  assert.ok(g.ok);
  await w.chat.post(w.alice, g.value.id, '@coder 开始');
  const coder = await w.sessionOf(g.value.id, 'coder');
  await w.finish(coder, '好');
  let before = w.interrupted.length;
  await w.chat.stop(w.alice, g.value.id);
  assert.equal(w.interrupted.length - before, 0, '都闲着就不打断');
  // coder 的会话又被别的途径开了一轮（不是群投递）
  await w.recordPrompt(coder, '别处来的追问');
  before = w.interrupted.length;
  const r = await w.chat.stop(w.alice, g.value.id);
  assert.ok(r.ok);
  assert.deepEqual(w.interrupted.slice(before), [coder]);
  assert.ok((await w.posts(g.value.id)).some((p) => p.author.kind === 'system' && /打断了 1 个/.test(p.body)));
  before = w.interrupted.length;
  await w.chat.post(w.alice, g.value.id, '停止 @reviewer');
  assert.equal(w.interrupted.length - before, 0, '「停止 @x」只打断 x');
  await w.chat.post(w.alice, g.value.id, '停止 @coder');
  assert.deepEqual(w.interrupted.slice(before), [coder]);
});

test('成员管理：一次加多个、移出（主持人和最后一个不能移）、viewer 不能动', async () => {
  const w = await world();
  const g = await w.chat.create(w.alice, w.project.id, { name: 'g', members: ['host'], hostRole: 'host' });
  assert.ok(g.ok);
  const added = await w.chat.addMembers(w.alice, g.value.id, ['coder', 'reviewer', 'coder']);
  assert.ok(added.ok);
  assert.deepEqual(added.value.members, ['host', 'coder', 'reviewer']);
  assert.ok(!(await w.chat.addMembers(w.alice, g.value.id, ['coder'])).ok, '都已在群里');
  assert.ok(!(await w.chat.addMembers(w.alice, g.value.id, ['ghost'])).ok, '项目里没有');
  const vicky = w.principal('vicky')!;
  assert.ok(!(await w.chat.removeMember(vicky, g.value.id, 'coder')).ok, 'viewer 不能移');
  const host = await w.chat.removeMember(w.alice, g.value.id, 'host');
  assert.ok(!host.ok && /主持人/.test(host.error.message));
  const removed = await w.chat.removeMember(w.alice, g.value.id, 'coder');
  assert.ok(removed.ok);
  assert.deepEqual(removed.value.members, ['host', 'reviewer']);
  assert.ok(!(await w.chat.removeMember(w.alice, g.value.id, 'coder')).ok, '已经不在');
  const posts = await w.posts(g.value.id);
  assert.ok(posts.some((p) => p.author.kind === 'system' && /把 @coder、@reviewer 加进了群/.test(p.body)));
  assert.ok(posts.some((p) => p.author.kind === 'system' && /把 @coder 移出了群/.test(p.body)));
});

test('持久智能体：按条增删改，@id 不可改，职责 4000 字；删除时从群移出并清主持人', async () => {
  const w = await world();
  let config: MessagingConfig = { projectId: w.project.id, roles: w.roleList, limits: {}, updatedAt: 0 };
  const agents = createPersistentAgents({
    projects: w.deps.projects,
    policy: { context: async () => ({ hubTeamId: 'T', settings: { membersCanAddMachines: false } }), worker: async () => ({}) as never } as never,
    config: async () => config,
    saveConfig: async (_p, input) => {
      const problem = configProblem(input);
      if (problem) return { ok: false, error: { code: 'invalid', message: problem } } as never;
      config = { ...config, roles: input.roles, limits: input.limits };
      w.roleList.splice(0, w.roleList.length, ...input.roles);
      return { ok: true, value: config };
    },
    groupsOf: (p) => w.groups.groupsOf(p),
    detach: (actor, p, name) => w.chat.detachAgent(actor, p, name)
  });
  const vicky = w.principal('vicky')!;
  assert.ok(!(await agents.create(vicky, w.project.id, { name: 'qa', agentId: 'pi' })).ok, 'viewer 不能建');
  assert.ok(!(await agents.create(w.alice, w.project.id, { name: 'QA 测试', agentId: 'pi' })).ok, '@id 不合法');
  assert.ok(!(await agents.create(w.alice, w.project.id, { name: 'coder', agentId: 'pi' })).ok, '@id 重复');
  assert.ok(!(await agents.create(w.alice, w.project.id, { name: 'qa', agentId: 'pi', description: 'x'.repeat(4001) })).ok, '职责太长');
  const qa = await agents.create(w.alice, w.project.id, { name: 'qa', displayName: '  测试  ', color: 'rose', agentId: 'hermes', description: 'y'.repeat(4000) });
  assert.ok(qa.ok, qa.ok ? '' : qa.error.message);
  assert.equal(qa.value.displayName, '测试');
  const edited = await agents.update(w.alice, w.project.id, 'qa', { displayName: '质检', model: 'm1', name: 'renamed' } as never);
  assert.ok(edited.ok);
  assert.equal(edited.value.name, 'qa', '@id 不随 patch 改');
  assert.equal(edited.value.displayName, '质检');
  assert.ok(!(await agents.update(w.alice, w.project.id, 'nope', {})).ok);

  const g = await w.chat.create(w.alice, w.project.id, { name: '评审群', members: ['host', 'coder'], hostRole: 'host' });
  assert.ok(g.ok);
  const listed = await agents.list(w.alice, w.project.id);
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.find((a) => a.name === 'host')?.groups, [{ id: g.value.id, name: '评审群', host: true }]);
  const gone = await agents.remove(w.alice, w.project.id, 'host');
  assert.ok(gone.ok);
  assert.deepEqual(gone.value.removedFrom, [{ id: g.value.id, name: '评审群' }]);
  const after = (await w.groups.group(g.value.id))!;
  assert.deepEqual(after.members, ['coder']);
  assert.equal(after.hostRole, null);
  assert.ok(!config.roles.some((r) => r.name === 'host'));
  assert.ok((await w.posts(g.value.id)).some((p) => p.author.kind === 'system' && /删除了 bot @host/.test(p.body)));
});

test('职责说明作为系统提示放在群消息最前面', async () => {
  const { memberPrompt } = await import('../groups.ts');
  const text = memberPrompt({ group: { name: 'g', members: ['coder'], hostRole: null }, role: 'coder', roles: ROLES, history: [], trigger: { author: 'alice', body: 'hi' } });
  assert.ok(text.startsWith('<agent-instructions>\n写代码\n</agent-instructions>'));
});
