import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProject } from '../project.ts';
import { createTask } from '../task.ts';
import { deriveSession } from '../session.ts';
import { asAgentId } from '../ids.ts';
import type { Principal } from '../account.ts';
import { DEFAULT_SETTINGS } from '../account.ts';
import type { AccessPolicy } from './authorization.ts';
import { prepareLongLivedWorkspaceUseCase, workspaceViewsUseCase } from './workspaces.ts';
import { deriveSessionUseCase } from './sessions.ts';
import {
  createTeamWorkspaceUseCase,
  deleteWorkspaceUseCase,
  linkWorkspaceUseCase,
  listTeamWorkspacesUseCase,
  transferWorkspaceUseCase,
  unlinkWorkspaceUseCase
} from './team-workspaces.ts';
import { newWorkspace, type ProjectWorkspaceLink, type Workspace } from '../workspace.ts';

import type { AgentDescriptor } from '../agent.ts';
import type { WorkdirSafety } from '../workdir-safety.ts';
import { ok } from '../result.ts';

function serialSafety() {
  let queue = Promise.resolve();
  let fenced = false;
  const safety: WorkdirSafety = {
    hasOutstanding: () => false,
    runExclusive<T>(fn: () => T | Promise<T>) { const next = queue.then(fn); queue = next.then(() => undefined, () => undefined); return next; },
    assertNoRemoval() { if (fenced) throw Error('fenced'); },
    assertUnoccupied() { if (fenced) throw Error('fenced'); }, assertProjectUnoccupied() {},
    beginRemoval() { if (fenced) throw Error('fenced'); fenced = true; return 'f'; }, finishRemoval() { fenced = false; }
  };
  return safety;
}

test('stale delete cannot remove a workdir transferred during status RPC', async () => {
  const w = await world();
  const made = newWorkspace({ projectId: w.a.id, teamId: 't1', workerId: 'remote-1', path: '/srv/work/race', kind: 'long_lived', source: 'cloned', isGit: true, now: 1 });
  assert.ok(made.ok);
  await w.deps.workspaces.save(made.value);
  await w.deps.workspaces.claim({ projectId: w.a.id, workspaceId: made.value.id, linkedBy: null, linkedAt: 1 });
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
  let removed = false;
  const git = { ...w.deps.git, status: async () => { entered(); await wait; return ok({ dirty: false, untracked: 0, unpushed: 0, branch: null, upstream: null }); }, remove: async () => { removed = true; return ok({ removed: true as const }); } };
  const deps = { ...w.deps, git, gateway: { ...w.deps.gateway, git: () => git }, workdirSafety: serialSafety() };
  const deletion = deleteWorkspaceUseCase(deps, { actor: alice, workspaceId: made.value.id, deleteDirectory: true });
  await started;
  assert.equal((await transferWorkspaceUseCase(deps, { actor: owner, projectId: w.b.id, workspaceId: made.value.id })).ok, true);
  release();
  assert.equal((await deletion).ok, false);
  assert.equal(removed, false);
  assert.equal((await deps.workspaces.linksOf(made.value.id))[0]?.projectId, w.b.id);
});

test('link cannot claim while physical removal fence is in flight', async () => {
  const w = await world();
  const made = newWorkspace({ projectId: null, teamId: 't1', workerId: 'remote-1', path: '/srv/work/unclaimed', kind: 'long_lived', source: 'cloned', isGit: true, now: 1 });
  assert.ok(made.ok); await w.deps.workspaces.save(made.value);
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
  const git = { ...w.deps.git, remove: async () => { entered(); await wait; return ok({ removed: true as const }); } };
  const deps = { ...w.deps, git, gateway: { ...w.deps.gateway, git: () => git }, workdirSafety: serialSafety() };
  const deletion = deleteWorkspaceUseCase(deps, { actor: owner, workspaceId: made.value.id, deleteDirectory: true, force: true });
  await started;
  assert.equal((await linkWorkspaceUseCase(deps, { actor: alice, projectId: w.a.id, workspaceId: made.value.id })).ok, false);
  assert.equal((await deps.workspaces.linksOf(made.value.id)).length, 0);
  release(); assert.equal((await deletion).ok, true);
});
const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: {
    prompt: { state: 'available' },
    interrupt: { state: 'available' },
    fork: { state: 'available' },
    resume: { state: 'available' },
    tool_calls: { state: 'available' },
    artifacts: { state: 'available' },
    structured_events: { state: 'available' },
    attachments: { state: 'available' }
  },
  models: [],
  defaultModel: '',
  options: []
};


const who = (id: string, role: string) =>
  ({ user: { id, email: `${id}@b.co`, role, disabledAt: null, deletedAt: null, teamId: 't1', clusterAdmin: false }, loginId: `l-${id}` }) as unknown as Principal;
const owner = who('boss', 'owner');
const alice = who('alice', 'member');
const bob = who('bob', 'member');

async function world() {
  const w = inMemoryDeps();
  w.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const policy: AccessPolicy = {
    context: async () => ({ hubTeamId: 't1', settings: DEFAULT_SETTINGS }),
    worker: async (id) => ({ kind: 'worker', id: id ?? 'local', teamId: 't1', createdBy: null })
  };
  const deps = { ...w.deps, access: policy };
  const mk = async (name: string, by: string) => {
    const p = createProject({ name, now: 1, teamId: 't1', createdBy: by });
    assert.ok(p.ok);
    await deps.projects.save(p.value);
    return p.value;
  };
  const a = await mk('alpha', 'alice');
  const b = await mk('beta', 'bob');
  return { ...w, deps, a, b };
}

test('occupied workdir blocks transfer and unlink before ownership changes', async () => {
  const w = await world();
  const made = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.a.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/a' }, home: '/h', actor: alice });
  assert.ok(made.ok);
  const seen: string[] = [];
  const safety: WorkdirSafety = {
    hasOutstanding: () => false,
    runExclusive: async (fn) => fn(), assertNoRemoval() {},
    assertUnoccupied(target) { seen.push(target.workspaceId); throw new Error('occupied'); },
    assertProjectUnoccupied() {}, beginRemoval: () => 'fence', finishRemoval() {}
  };
  const deps = { ...w.deps, workdirSafety: safety };
  assert.equal((await transferWorkspaceUseCase(deps, { actor: owner, projectId: w.b.id, workspaceId: made.value.id })).ok, false);
  assert.equal((await unlinkWorkspaceUseCase(deps, { actor: owner, projectId: w.a.id, workspaceId: made.value.id })).ok, false);
  assert.deepEqual(seen, [made.value.id, made.value.id]);
  assert.equal((await w.deps.workspaces.linksOf(made.value.id))[0]?.projectId, w.a.id);
});

test('团队页：owner 新建（不关联），成员看不见没关联的；为项目新建会关联、成员只看见自己项目关联的', async () => {
  const w = await world();
  const denied = await createTeamWorkspaceUseCase(w.deps, { actor: alice, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/x' }, home: '/h' });
  assert.equal(denied.ok, false);
  const made = await createTeamWorkspaceUseCase(w.deps, { actor: owner, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/x' }, home: '/h' });
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.equal(made.value.projectId, null);
  assert.equal(made.value.teamId, 't1');
  assert.deepEqual(await listTeamWorkspacesUseCase(w.deps, owner), { ok: true, value: [{ workspace: made.value, projects: [], hiddenProjects: 0, runningSessions: 0 }] });
  const forAlice = await listTeamWorkspacesUseCase(w.deps, alice);
  assert.ok(forAlice.ok);
  assert.equal(forAlice.value.length, 1, '未认领的目录团队里谁都看得见（要能认领）');
  assert.deepEqual(forAlice.value[0]!.projects, []);

  const own = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.a.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/a' }, home: '/h', actor: alice });
  assert.ok(own.ok);
  const listed = await listTeamWorkspacesUseCase(w.deps, alice);
  assert.ok(listed.ok);
  assert.deepEqual(
    listed.value.map((v) => [v.workspace.path, v.projects.map((p) => p.name)]).sort(),
    [['/srv/work/a', ['alpha']], ['/srv/work/x', []]].sort()
  );
  const forBob = await listTeamWorkspacesUseCase(w.deps, bob);
  assert.ok(forBob.ok);
  assert.equal(forBob.value.length, 1, '未认领的那个也看得见');
});

test('独占归属：别的项目不能直接关联（conflict 不泄露现任项目名）；同一项目重复关联幂等；视图带认领者', async () => {
  const w = await world();
  const ws = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.a.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/a' }, home: '/h', actor: alice });
  assert.ok(ws.ok);
  // bob 看不见 alpha 的工作空间 → 不能关联到 beta
  assert.equal((await linkWorkspaceUseCase(w.deps, { actor: bob, projectId: w.b.id, workspaceId: ws.value.id })).ok, false);
  // alice 不能改 beta → 授权先挡住
  assert.equal((await linkWorkspaceUseCase(w.deps, { actor: alice, projectId: w.b.id, workspaceId: ws.value.id })).ok, false);
  // owner 能改 beta、也看得见工作空间：被独占拦下；错误信息不点名现任（可能对失败方不可见）
  const taken = await linkWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id });
  assert.equal(taken.ok ? '' : taken.error.code, 'conflict');
  assert.match(taken.ok ? '' : taken.error.message, /已经分配给其他项目/);
  assert.doesNotMatch(taken.ok ? '' : taken.error.message, /alpha/);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [w.a.id]);

  // 同一个项目重复关联幂等；登记还是只有一条，保留首次自动认领的元数据（#233）
  assert.ok((await linkWorkspaceUseCase(w.deps, { actor: owner, projectId: w.a.id, workspaceId: ws.value.id })).ok);
  const links = await w.deps.workspaces.linksOf(ws.value.id);
  assert.deepEqual(links.map((l) => [l.projectId, l.linkedBy]), [[w.a.id, null]]);

  // 运行面板 / 项目设置里带认领者；bob 在团队页看不到它
  const views = await workspaceViewsUseCase(w.deps, w.a.id);
  assert.ok(views.ok);
  assert.deepEqual(views.value.map((v) => [v.ownerProjectId, v.ownerProjectName]), [[w.a.id, 'alpha']]);
  const forBob = await listTeamWorkspacesUseCase(w.deps, bob);
  assert.ok(forBob.ok);
  assert.deepEqual(forBob.value, []);

  // 独占后只有一个认领者：对 alpha 有 project.update 的 alice 一个人就能删（只移除登记）
  assert.ok((await deleteWorkspaceUseCase(w.deps, { actor: alice, workspaceId: ws.value.id, deleteDirectory: false })).ok);
});

test('历史重复登记：关联/转移都报重复，保留老行不覆盖（#233）', async () => {
  const w = await world();
  const ws = await createTeamWorkspaceUseCase(w.deps, { actor: owner, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/dup' }, home: '/h' });
  assert.ok(ws.ok, ws.ok ? '' : ws.error.message);
  const duplicate = newWorkspace({ projectId: null, teamId: 't1', workerId: 'remote-1', path: '/srv/work/dup', kind: 'long_lived', source: 'linked', now: 5 });
  assert.ok(duplicate.ok);
  const store = w.deps.workspaces as typeof w.deps.workspaces & { rows: Map<string, Workspace> };
  store.rows.set(duplicate.value.id, duplicate.value);

  const linked = await linkWorkspaceUseCase(w.deps, { actor: alice, projectId: w.a.id, workspaceId: ws.value.id });
  assert.equal(linked.ok, false);
  if (!linked.ok) assert.match(linked.error.message, /重复的工作空间登记/);
  assert.deepEqual(await w.deps.workspaces.linksOf(ws.value.id), []);

  const moved = await transferWorkspaceUseCase(w.deps, { actor: alice, projectId: w.a.id, workspaceId: ws.value.id });
  assert.equal(moved.ok, false);
  if (!moved.ok) assert.match(moved.error.message, /重复的工作空间登记/);
  assert.deepEqual(await w.deps.workspaces.linksOf(ws.value.id), []);

  // 已经是当前项目的唯一认领：历史重复行不应把幂等关联/转移变成冲突。
  const links = w.deps.workspaces as typeof w.deps.workspaces & { links: ProjectWorkspaceLink[] };
  links.links.push({ projectId: w.a.id, workspaceId: ws.value.id, linkedBy: 'legacy', linkedAt: 1 });
  assert.ok((await linkWorkspaceUseCase(w.deps, { actor: alice, projectId: w.a.id, workspaceId: ws.value.id })).ok);
  assert.ok((await transferWorkspaceUseCase(w.deps, { actor: alice, projectId: w.a.id, workspaceId: ws.value.id })).ok);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => [l.projectId, l.linkedBy]), [[w.a.id, 'legacy']]);
  assert.equal(store.rows.size, 2);
});

test('并发认领：预检查看到空目录，claim 时已被别人抢先 → conflict，不挤掉新认领（#233）', async () => {
  const w = await world();
  const ws = await createTeamWorkspaceUseCase(w.deps, { actor: owner, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/race' }, home: '/h' });
  assert.ok(ws.ok, ws.ok ? '' : ws.error.message);
  const c = createProject({ name: 'gamma', now: 1, teamId: 't1', createdBy: 'boss' });
  assert.ok(c.ok);
  await w.deps.projects.save(c.value);
  // linkWorkspaceUseCase 先 linksOf 做可见性预检查；这里在它返回后、claim 之前让另一个项目抢先认领。
  const linksOf = w.deps.workspaces.linksOf.bind(w.deps.workspaces);
  let raced = false;
  w.deps.workspaces.linksOf = async (workspaceId) => {
    const seen = await linksOf(workspaceId);
    if (!raced) {
      raced = true;
      const winner = await w.deps.workspaces.claim({
        projectId: c.value.id,
        workspaceId: ws.value.id,
        linkedBy: 'racer',
        linkedAt: 2
      });
      assert.equal(winner.status, 'claimed');
    }
    return seen;
  };
  const claimed = await linkWorkspaceUseCase(w.deps, { actor: bob, projectId: w.b.id, workspaceId: ws.value.id });
  assert.equal(claimed.ok ? '' : claimed.error.code, 'conflict');
  assert.match(claimed.ok ? '' : claimed.error.message, /已经分配给其他项目/);
  assert.doesNotMatch(claimed.ok ? '' : claimed.error.message, /gamma/);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [c.value.id]);
});

test('转移：A→B 成功，登记只剩 B；对已经属于本项目的空间再转移是幂等的', async () => {
  const w = await world();
  const ws = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.a.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/a' }, home: '/h', actor: alice });
  assert.ok(ws.ok);
  // owner 能同时改 alpha / beta
  const moved = await transferWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id });
  assert.ok(moved.ok, moved.ok ? '' : moved.error.message);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [w.b.id]);
  const again = await transferWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id });
  assert.ok(again.ok, again.ok ? '' : again.error.message);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [w.b.id]);
  const views = await workspaceViewsUseCase(w.deps, w.b.id);
  assert.ok(views.ok);
  assert.deepEqual(views.value.map((v) => [v.ownerProjectId, v.ownerProjectName]), [[w.b.id, 'beta']]);
});

test('转移：没有源项目 project.update 的人不能转（forbidden），登记保持原样', async () => {
  const w = await world();
  const ws = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.a.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/a' }, home: '/h', actor: alice });
  assert.ok(ws.ok);
  // eve：自定义角色读全团队、只改共享给自己的项目；beta 的成员列表里有他，alpha 没有
  await w.deps.projects.save({ ...w.b, members: ['eve'] });
  const eve = {
    user: { id: 'eve', email: 'eve@b.co', role: 'custom:limited', disabledAt: null, deletedAt: null, teamId: 't1', clusterAdmin: false },
    loginId: 'l-eve',
    customRole: {
      id: 'limited',
      teamId: 't1',
      name: 'Limited',
      permissions: { 'project.read': 'team', 'project.update': 'own' },
      createdBy: 'boss',
      createdAt: 1,
      updatedAt: 1
    }
  } as unknown as Principal;
  const moved = await transferWorkspaceUseCase(w.deps, { actor: eve, projectId: w.b.id, workspaceId: ws.value.id });
  assert.equal(moved.ok ? '' : moved.error.code, 'forbidden');
  assert.match(moved.ok ? '' : moved.error.message, /同时能改这两个项目/);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [w.a.id]);
});

test('转移：源项目还有会话在这个目录里跑 → conflict，停了才能转', async () => {
  const w = await world();
  const ws = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.a.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/a' }, home: '/h', actor: alice });
  assert.ok(ws.ok);
  const task = createTask({ projectId: w.a.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  await w.deps.tasks.save(task.value);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1 });
  assert.ok(session.ok);
  await w.deps.sessions.save({ ...session.value, status: 'running', workspaceId: ws.value.id });
  const blocked = await transferWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id });
  assert.equal(blocked.ok ? '' : blocked.error.code, 'conflict');
  assert.match(blocked.ok ? '' : blocked.error.message, /先停掉再转移/);
  await w.deps.sessions.save({ ...session.value, status: 'stopped', workspaceId: ws.value.id });
  assert.ok((await transferWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id })).ok);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [w.b.id]);
});

test('转移/取消关联：团队级工作空间上的容器会话按 originProjectId 判定，来源项目在跑就拦（#233）', async () => {
  const w = await world();
  const ws = await createTeamWorkspaceUseCase(w.deps, { actor: owner, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/team' }, home: '/h' });
  assert.ok(ws.ok, ws.ok ? '' : ws.error.message);
  assert.equal(ws.value.projectId, null, '团队页新建的长期空间没有登记项目');
  assert.ok((await linkWorkspaceUseCase(w.deps, { actor: owner, projectId: w.a.id, workspaceId: ws.value.id })).ok);
  // 容器会话：出生来源是 alpha；工作空间自己的 project_id 仍是 null，旧的宽松判定会漏掉它。
  const session = deriveSession({ task: null, agentId: asAgentId('pi'), model: 'm', now: 1, workspaceId: ws.value.id, originProjectId: w.a.id });
  assert.ok(session.ok);
  await w.deps.sessions.save(session.value);
  const blocked = await transferWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id });
  assert.equal(blocked.ok ? '' : blocked.error.code, 'conflict');
  assert.match(blocked.ok ? '' : blocked.error.message, /源项目还有会话/);
  const unlinkBlocked = await unlinkWorkspaceUseCase(w.deps, { actor: owner, projectId: w.a.id, workspaceId: ws.value.id });
  assert.equal(unlinkBlocked.ok ? '' : unlinkBlocked.error.code, 'conflict');
  assert.match(unlinkBlocked.ok ? '' : unlinkBlocked.error.message, /本项目还有会话/);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [w.a.id]);
  await w.deps.sessions.save({ ...session.value, status: 'stopped' });
  assert.ok((await transferWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id })).ok);
});

test('转移/取消关联：来源不明的运行中会话保守拦截，不因判不出归属而放行（#233）', async () => {
  const w = await world();
  const ws = await createTeamWorkspaceUseCase(w.deps, { actor: owner, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/unknown' }, home: '/h' });
  assert.ok(ws.ok, ws.ok ? '' : ws.error.message);
  assert.ok((await linkWorkspaceUseCase(w.deps, { actor: owner, projectId: w.a.id, workspaceId: ws.value.id })).ok);
  // 老容器会话：没有 originProjectId、没有组，长期工作空间自己的 project_id 也不作来源。
  const session = deriveSession({ task: null, agentId: asAgentId('pi'), model: 'm', now: 1, workspaceId: ws.value.id });
  assert.ok(session.ok);
  await w.deps.sessions.save(session.value);
  const blocked = await transferWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id });
  assert.equal(blocked.ok ? '' : blocked.error.code, 'conflict');
  assert.match(blocked.ok ? '' : blocked.error.message, /来源不明的运行中会话/);
  const unlinkBlocked = await unlinkWorkspaceUseCase(w.deps, { actor: owner, projectId: w.a.id, workspaceId: ws.value.id });
  assert.equal(unlinkBlocked.ok ? '' : unlinkBlocked.error.code, 'conflict');
  assert.match(unlinkBlocked.ok ? '' : unlinkBlocked.error.message, /来源不明的运行中会话/);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [w.a.id]);
});

test('转移：临时工作空间只属于一个任务，不能转移（invalid）', async () => {
  const w = await world();
  const task = createTask({ projectId: w.a.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  await w.deps.tasks.save(task.value);
  const temp = newWorkspace({ projectId: w.a.id, teamId: 't1', workerId: 'remote-1', path: '/srv/work/t1', kind: 'temporary', source: 'worktree', ownerTaskId: task.value.id, now: 2 });
  assert.ok(temp.ok);
  await w.deps.workspaces.save(temp.value);
  // alice 不能改 beta，先被目标项目授权挡住；owner 才走到「临时空间不能转移」
  assert.equal((await transferWorkspaceUseCase(w.deps, { actor: alice, projectId: w.b.id, workspaceId: temp.value.id })).ok, false);
  const moved = await transferWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: temp.value.id });
  assert.equal(moved.ok ? '' : moved.error.code, 'invalid');
  assert.match(moved.ok ? '' : moved.error.message, /临时工作空间/);
});

test('转移：会话检查期间别人抢先完成 A→C，原转移 stale 且 C 的认领不被删（#233）', async () => {
  const w = await world();
  const ws = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.a.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/a' }, home: '/h', actor: alice });
  assert.ok(ws.ok);
  const c = createProject({ name: 'gamma', now: 1, teamId: 't1', createdBy: 'boss' });
  assert.ok(c.ok);
  await w.deps.projects.save(c.value);
  // 转移在检查运行中会话时会让出事件循环；这里确定性地模拟另一个并发转移 A→C 抢先完成
  const list = w.deps.sessions.listByWorkspace.bind(w.deps.sessions);
  let raced = false;
  w.deps.sessions.listByWorkspace = async (workspaceId) => {
    if (!raced) {
      raced = true;
      const winner = await w.deps.workspaces.transfer({
        projectId: c.value.id,
        workspaceId: ws.value.id,
        linkedBy: 'racer',
        linkedAt: 2,
        expectedProjectIds: [w.a.id]
      });
      assert.equal(winner.status, 'transferred');
    }
    return list(workspaceId);
  };
  const moved = await transferWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id });
  assert.equal(moved.ok ? '' : moved.error.code, 'conflict');
  assert.match(moved.ok ? '' : moved.error.message, /归属刚刚变了/);
  assert.doesNotMatch(moved.ok ? '' : moved.error.message, /gamma/);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [c.value.id]);
});

test('团队页新建（还没分配）的长期工作空间可以被项目认领', async () => {
  const w = await world();
  const ws = await createTeamWorkspaceUseCase(w.deps, { actor: owner, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/shared' }, home: '/h' });
  assert.ok(ws.ok);
  assert.equal(ws.value.projectId, null);
  assert.deepEqual(await w.deps.workspaces.linksOf(ws.value.id), []);
  // 没认领的目录：项目 owner 有 project.update 就能认领，不需要 workspace.manage
  const claimed = await linkWorkspaceUseCase(w.deps, { actor: bob, projectId: w.b.id, workspaceId: ws.value.id });
  assert.ok(claimed.ok, claimed.ok ? '' : claimed.error.message);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => [l.projectId, l.linkedBy]), [[w.b.id, 'bob']]);
});

test('在关联的团队工作空间里开会话（projectId 为 null 也认关联表）；没关联的项目不认', async () => {
  const w = await world();
  w.agents.push(fake);
  const ws = await createTeamWorkspaceUseCase(w.deps, { actor: owner, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/shared' }, home: '/h' });
  assert.ok(ws.ok);
  assert.equal(ws.value.projectId, null);
  const linked = await linkWorkspaceUseCase(w.deps, { actor: owner, projectId: w.a.id, workspaceId: ws.value.id });
  assert.ok(linked.ok, linked.ok ? '' : linked.error.message);
  const mkTask = async (projectId: typeof w.a.id) => {
    const t = createTask({ projectId, title: 't', goal: '', now: 1 });
    assert.ok(t.ok);
    await w.deps.tasks.save(t.value);
    return t.value;
  };
  const started = await deriveSessionUseCase(w.deps, { taskId: (await mkTask(w.a.id)).id, agentId: 'fake', model: '', workspaceId: ws.value.id, actor: owner });
  assert.ok(started.ok, started.ok ? '' : started.error.message);
  assert.equal(started.value.workspaceId, ws.value.id);
  const foreign = await deriveSessionUseCase(w.deps, { taskId: (await mkTask(w.b.id)).id, agentId: 'fake', model: '', workspaceId: ws.value.id, actor: owner });
  assert.equal(foreign.ok, false);
});
