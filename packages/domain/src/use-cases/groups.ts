import type { Principal } from '../account.ts';
import { forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import {
  effectiveGroupLimits,
  groupProblem,
  hostPrompt,
  bidPrompt,
  memberPrompt,
  isDeliveryOpen,
  isHeld,
  isSilent,
  parseBid,
  parseHostText,
  parseMentions,
  parseStopCommand,
  pickVolunteer,
  validateDispatch,
  HOST_PER_MINUTE,
  HOST_TIMEOUT_MS,
  HOST_UNAVAILABLE_LINE,
  MAX_POST_CHARS,
  MEMBER_TIMEOUT_MS,
  type DeliveryPurpose,
  type Group,
  type GroupDelivery,
  type GroupInput,
  type GroupPost,
  type GroupThread,
  type HostDecision,
  type PostAuthor,
  type PromptContext,
  type ThreadStatus
} from '../groups.ts';
import { newId, type ProjectId, type SessionId } from '../ids.ts';
import { createSessionLane, type SessionLane } from '../session-lane.ts';
import type { AgentRole } from '../messaging.ts';
import type { GroupStore } from '../ports/group-store.ts';
import type { Project } from '../project.ts';
import { err, ok, type Result } from '../result.ts';
import { isBusy, type Session } from '../session.ts';
import { authorizeProject, type AccessPolicy } from './authorization.ts';
import type { Deps } from './deps.ts';

/**
 * 群聊调度（ADR 0018 · IM 与群组）。
 *
 * 一条人类消息开一段「对话」（GroupThread）。对话按轮推进：
 * - 第 0 轮：主持人分派（host 策略、消息没 @ 人时）。
 * - 第 1..maxRounds 轮：被叫到的成员各回一条，回复里 @ 到的其他成员进下一轮；volunteer 策略每轮全员竞价、只有一人发言。
 * 整轮都 [SILENT] / 没人被叫到 / 到轮数或条数上限 / 人按了停止，对话就结束。
 *
 * 每个群每个角色一条常驻会话（第一次叫到时用发消息的人的身份派生）。投递按会话排队：会话忙就等它这一轮结束。
 * 所有状态变化按群串行。
 */
export interface GroupChatDeps extends Pick<Deps, 'now' | 'sessions' | 'tasks' | 'projects'> {
  readonly groups: GroupStore;
  readonly policy?: AccessPolicy;
  /** 项目里配置的角色（agent 消息设置里的那份）。 */
  readonly roles: (projectId: ProjectId) => Promise<readonly AgentRole[]>;
  readonly deliver: (sessionId: SessionId, text: string, author: { id: string; name: string; via: string }) => Promise<Result<unknown, DomainError>>;
  readonly spawn: (input: { project: Project; role: AgentRole; actor: Principal; title: string }) => Promise<Result<Session, DomainError>>;
  readonly principalOf: (userId: string) => Promise<Principal | null>;
  /** 停止时尽量打断正在跑的回合（可选）。 */
  readonly interrupt?: (sessionId: SessionId) => Promise<unknown>;
  /** 同一条会话的投递闸（组合根里两边共用一个）；occupied = 别的通道在这条会话上还有没收尾的投递。 */
  readonly lane?: SessionLane;
  readonly occupied?: (sessionId: SessionId) => Promise<boolean>;
}

export interface GroupView {
  readonly group: Group;
  readonly sessions: readonly { role: string; sessionId: SessionId; status: string }[];
  readonly running: readonly GroupThread[];
}

export interface ChainView {
  readonly thread: GroupThread;
  readonly deliveries: readonly GroupDelivery[];
}

export interface GroupChat {
  list(actor: Principal, projectId: ProjectId): Promise<Result<Group[], DomainError>>;
  create(actor: Principal, projectId: ProjectId, input: GroupInput): Promise<Result<Group, DomainError>>;
  update(actor: Principal, groupId: string, input: GroupInput): Promise<Result<Group, DomainError>>;
  view(actor: Principal, groupId: string): Promise<Result<GroupView, DomainError>>;
  posts(actor: Principal, groupId: string, afterSeq: number | null, limit: number): Promise<Result<GroupPost[], DomainError>>;
  chains(actor: Principal, groupId: string, limit: number): Promise<Result<ChainView[], DomainError>>;
  post(actor: Principal, groupId: string, body: string): Promise<Result<GroupPost, DomainError>>;
  stop(actor: Principal, groupId: string): Promise<Result<Group, DomainError>>;
  /** 主持人工具 group_dispatch。 */
  dispatch(sessionId: SessionId, input: Record<string, unknown>): Promise<Result<{ assignees: readonly string[] } | { declined: true }, DomainError>>;
  /** 会话一轮结束（组合根接 hub.stream 'ended'）。 */
  turnEnded(sessionId: SessionId): Promise<void>;
  /** 超时扫一遍（组合根定时调）。 */
  sweep(): Promise<number>;
  /** 这条会话是不是群成员会话（给工具判断用）。 */
  memberOf(sessionId: SessionId): Promise<{ groupId: string; role: string } | null>;
}

const summary = (text: string): string => (text.length > 60 ? `${text.slice(0, 60)}…` : text).replaceAll('\n', ' ');

export function createGroupChat(deps: GroupChatDeps): GroupChat {
  const lane = deps.lane ?? createSessionLane();
  const locks = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.then(work, work);
    const tail = next.catch(() => undefined);
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return next;
  };

  /** 串行跑一段状态变化；跑完再把这段里排进队的会话挨个泵一下。 */
  const run = async <T>(groupId: string, work: (pending: Set<SessionId>) => Promise<T>): Promise<T> => {
    const pending = new Set<SessionId>();
    const out = await serial(groupId, () => work(pending));
    for (const sid of pending) await pumpSession(groupId, sid);
    return out;
  };

  const projectOf = async (projectId: ProjectId) => deps.projects.byId(projectId);

  const authorize = async (actor: Principal, group: Group | null, permission: 'project.read' | 'group.post' | 'group.manage'): Promise<Result<{ group: Group; project: Project }, DomainError>> => {
    if (!group) return err(notFound('群不存在'));
    const project = await projectOf(group.projectId);
    const allowed = await authorizeProject(deps.policy, actor, project, permission);
    if (!allowed.ok) return allowed.error.code === 'not_found' ? err(notFound('群不存在')) : allowed;
    return ok({ group, project: allowed.value });
  };

  const author = (a: PostAuthor): string => (a.kind === 'user' ? a.name : a.kind === 'agent' ? `@${a.role}` : '系统');

  const append = async (group: Group, thread: GroupThread | null, round: number, a: PostAuthor, body: string): Promise<GroupPost> => {
    const mentions = parseMentions(body, group.members);
    return deps.groups.appendPost({
      id: newId(),
      groupId: group.id,
      threadId: thread?.id ?? null,
      round,
      author: a,
      body,
      mentions: mentions.members,
      needsUser: a.kind === 'agent' && mentions.user,
      createdAt: deps.now()
    });
  };
  const system = (group: Group, thread: GroupThread | null, body: string) => append(group, thread, thread?.round ?? 0, { kind: 'system' }, body);

  const saveGroup = async (group: Group, patch: Partial<Group>): Promise<Group> => {
    const next: Group = { ...group, ...patch, updatedAt: deps.now() };
    await deps.groups.saveGroup(next);
    return next;
  };

  const saveThread = async (thread: GroupThread, patch: Partial<GroupThread>): Promise<GroupThread> => {
    const next: GroupThread = { ...thread, ...patch, updatedAt: deps.now() };
    await deps.groups.saveThread(next);
    return next;
  };

  const end = async (group: Group, thread: GroupThread, status: ThreadStatus, line: string | null): Promise<GroupThread> => {
    if (thread.status !== 'running') return thread;
    const next = await saveThread(thread, { status });
    for (const d of await deps.groups.deliveries(thread.id)) if (d.status === 'queued') await settle(d, 'canceled', null);
    if (line) await system(group, next, line);
    return next;
  };

  const settle = async (d: GroupDelivery, status: GroupDelivery['status'], result: string | null, score: number | null = null): Promise<GroupDelivery> => {
    const next: GroupDelivery = { ...d, status, result: result ?? d.result, score: score ?? d.score, updatedAt: deps.now() };
    await deps.groups.saveDelivery(next);
    return next;
  };

  const history = async (group: Group, beforeSeq: number | null): Promise<{ author: string; body: string }[]> =>
    (await deps.groups.posts(group.id, null, 30))
      .filter((p) => p.author.kind !== 'system' && (beforeSeq === null || p.seq < beforeSeq))
      .map((p) => ({ author: author(p.author), body: p.body }));

  /** 角色在这个群里的常驻会话：有就用，没有（或已结束）就用 actor 的身份派生一条。 */
  const ensureSession = async (group: Group, roleName: string, actor: Principal): Promise<Result<SessionId, DomainError>> => {
    const existing = await deps.groups.sessionFor(group.id, roleName);
    if (existing) {
      const session = await deps.sessions.byId(existing);
      if (session && session.status !== 'failed') return ok(existing);
    }
    const roles = await deps.roles(group.projectId);
    const role = roles.find((r) => r.name === roleName);
    if (!role) return err(invalid(`项目里已经没有角色 ${roleName}`));
    const project = await projectOf(group.projectId);
    if (!project) return err(notFound('项目不存在'));
    const spawned = await deps.spawn({ project, role, actor, title: `群「${group.name}」· ${roleName}` });
    if (!spawned.ok) return spawned;
    await deps.groups.setSession(group.id, roleName, spawned.value.id);
    return ok(spawned.value.id);
  };

  const actorOf = async (thread: GroupThread): Promise<Principal | null> => {
    const root = (await deps.groups.posts(thread.groupId, null, 200)).find((p) => p.id === thread.rootPostId);
    return root?.author.kind === 'user' ? deps.principalOf(root.author.id) : null;
  };

  /** 给这几个角色建这一轮的投递。被暂停的跳过；会话起不来的记一行系统消息。返回建了几条。 */
  const schedule = async (
    group: Group,
    thread: GroupThread,
    round: number,
    purpose: DeliveryPurpose,
    roles: readonly string[],
    trigger: { author: string; body: string; seq: number | null },
    pending: Set<SessionId>,
    note = ''
  ): Promise<number> => {
    const actor = await actorOf(thread);
    if (!actor) return 0;
    const roleList = await deps.roles(group.projectId);
    const past = await history(group, trigger.seq);
    let count = 0;
    for (const role of roles) {
      if (isHeld(group, role)) continue;
      const sid = await ensureSession(group, role, actor);
      if (!sid.ok) {
        await system(group, thread, `@${role} 起不来：${sid.error.message}`);
        continue;
      }
      const ctx: PromptContext = { group, role, roles: roleList, history: past, trigger };
      let prompt: string;
      if (purpose === 'host') {
        const status = [];
        for (const m of group.members.filter((x) => x !== role)) {
          const s = await deps.groups.sessionFor(group.id, m);
          const session = s ? await deps.sessions.byId(s) : null;
          status.push({ role: m, busy: session ? isBusy(session) : false, held: isHeld(group, m) });
        }
        prompt = hostPrompt(ctx, status);
      } else prompt = purpose === 'bid' ? bidPrompt(ctx) : memberPrompt(ctx, note);
      const now = deps.now();
      await deps.groups.saveDelivery({
        id: newId(),
        groupId: group.id,
        threadId: thread.id,
        round,
        purpose,
        role,
        sessionId: sid.value,
        status: 'queued',
        result: null,
        score: null,
        prompt,
        note,
        createdAt: now,
        deliveredAt: null,
        updatedAt: now
      });
      pending.add(sid.value);
      count++;
    }
    return count;
  };

  const pumpSession = (groupId: string, sid: SessionId): Promise<void> =>
    run(groupId, (pending) => lane.run(sid, async () => {
      const session = await deps.sessions.byId(sid);
      if (!session || isBusy(session)) return;
      if ((await deps.groups.deliveredTo(sid)).length > 0) return;
      if (await deps.occupied?.(sid)) return;
      const next = (await deps.groups.queuedFor(sid))[0];
      if (!next) return;
      const group = await deps.groups.group(next.groupId);
      const thread = await deps.groups.thread(next.threadId);
      if (!group || !thread || thread.status !== 'running') {
        await settle(next, 'canceled', null);
        pending.add(sid);
        return;
      }
      const now = deps.now();
      const delivering: GroupDelivery = { ...next, status: 'delivered', deliveredAt: now, updatedAt: now };
      await deps.groups.saveDelivery(delivering);
      const sent = await deps.deliver(sid, next.prompt, { id: `group:${group.id}`, name: `群「${group.name}」`, via: 'group' });
      if (!sent.ok) {
        const current = (await deps.groups.deliveries(thread.id)).find((d) => d.id === delivering.id);
        if (current?.status === 'delivered') await failed(group, thread, current, sent.error.message, pending);
      }
    }));

  const failed = async (group: Group, thread: GroupThread, d: GroupDelivery, reason: string, pending: Set<SessionId>): Promise<void> => {
    await settle(d, 'failed', reason);
    if (d.purpose === 'host') {
      await end(group, thread, 'fallback', `${HOST_UNAVAILABLE_LINE}（${summary(reason)}）`);
      return;
    }
    await closeRound(group, thread.id, d.round, pending);
  };

  /** 主持人的决定生效。 */
  const applyHost = async (group: Group, thread: GroupThread, d: GroupDelivery, decision: HostDecision, pending: Set<SessionId>): Promise<void> => {
    if (decision.kind === 'invalid') {
      await settle(d, 'failed', decision.reason);
      await end(group, thread, 'fallback', `${HOST_UNAVAILABLE_LINE}（${decision.reason}）`);
      return;
    }
    if (decision.kind === 'decline') {
      await settle(d, 'done', JSON.stringify({ decline: true, reply: decision.reply }));
      if (decision.reply && !isSilent(decision.reply)) {
        await append(group, thread, 0, { kind: 'agent', role: d.role, sessionId: d.sessionId ?? '' }, decision.reply);
        await end(group, await saveThread(thread, { messages: thread.messages + 1 }), 'done', null);
      } else await end(group, thread, 'silent', null);
      return;
    }
    await settle(d, 'done', JSON.stringify({ assignees: decision.assignees, note: decision.note }));
    await system(group, thread, `主持人 @${d.role} 派给 ${decision.assignees.map((a) => `@${a}`).join('、')}${decision.note ? `：${decision.note}` : ''}`);
    const root = (await deps.groups.posts(group.id, null, 200)).find((p) => p.id === thread.rootPostId);
    const next = await saveThread(thread, { round: 1 });
    const n = await schedule(group, next, 1, 'member', decision.assignees, { author: root ? author(root.author) : '用户', body: root?.body ?? '', seq: root?.seq ?? null }, pending, decision.note);
    if (n === 0) await end(group, next, 'done', '派到的成员都暂停或起不来，没人回');
  };

  /** 一轮的投递都有结果了：决定结束还是开下一轮。 */
  const closeRound = async (group: Group, threadId: string, round: number, pending: Set<SessionId>): Promise<void> => {
    let thread = await deps.groups.thread(threadId);
    if (!thread || thread.status !== 'running' || thread.round !== round) return;
    const ds = (await deps.groups.deliveries(threadId)).filter((d) => d.round === round && d.purpose !== 'host');
    if (ds.some(isDeliveryOpen)) return;
    const limits = effectiveGroupLimits(group.limits);
    group = (await deps.groups.group(group.id)) ?? group;

    if (ds.some((d) => d.purpose === 'bid')) {
      const posts = await deps.groups.posts(group.id, null, 50);
      const lastSpeaker = [...posts].reverse().find((p) => p.threadId === threadId && p.author.kind === 'agent');
      const winner = pickVolunteer(
        ds.map((d) => ({ role: d.role, bid: d.status === 'done' && d.result ? parseBid(d.result) : null })),
        lastSpeaker?.author.kind === 'agent' ? lastSpeaker.author.role : null
      );
      if (!winner) {
        await end(group, thread, 'silent', round === 1 ? '没有成员愿意接话' : null);
        return;
      }
      if (thread.messages >= limits.maxMessages) {
        await end(group, thread, 'limit', `已到 ${limits.maxMessages} 条消息上限，停下来等你`);
        return;
      }
      const d = ds.find((x) => x.role === winner.role)!;
      const post = await append(group, thread, round, { kind: 'agent', role: winner.role, sessionId: d.sessionId ?? '' }, winner.bid.message);
      if (post.needsUser) group = await saveGroup(group, { needsUser: true });
      thread = await saveThread(thread, { messages: thread.messages + 1 });
      if (round + 1 > limits.maxRounds || thread.messages >= limits.maxMessages) {
        await end(group, thread, 'limit', `已到上限（${limits.maxRounds} 轮 / ${limits.maxMessages} 条），停下来等你`);
        return;
      }
      if (post.needsUser) {
        await end(group, thread, 'done', null);
        return;
      }
      thread = await saveThread(thread, { round: round + 1 });
      const n = await schedule(group, thread, round + 1, 'bid', group.members, { author: `@${winner.role}`, body: winner.bid.message, seq: post.seq }, pending);
      if (n === 0) await end(group, thread, 'done', null);
      return;
    }

    const spoke = ds.filter((d) => d.status === 'done');
    if (spoke.length === 0) {
      await end(group, thread, 'silent', '这一轮大家都没说话，对话结束');
      return;
    }
    const posts = (await deps.groups.posts(group.id, null, 100)).filter((p) => p.threadId === threadId && p.round === round && p.author.kind === 'agent');
    const next: string[] = [];
    for (const p of posts) {
      const me = p.author.kind === 'agent' ? p.author.role : '';
      for (const m of p.mentions) if (m !== me && !next.includes(m) && !isHeld(group, m)) next.push(m);
    }
    if (next.length === 0 || posts.some((p) => p.needsUser)) {
      await end(group, thread, 'done', null);
      return;
    }
    if (round + 1 > limits.maxRounds) {
      await end(group, thread, 'limit', `已到 ${limits.maxRounds} 轮上限，停下来等你`);
      return;
    }
    if (thread.messages >= limits.maxMessages) {
      await end(group, thread, 'limit', `已到 ${limits.maxMessages} 条消息上限，停下来等你`);
      return;
    }
    thread = await saveThread(thread, { round: round + 1 });
    const last = posts[posts.length - 1]!;
    const trigger = { author: posts.map((p) => author(p.author)).join('、'), body: posts.map((p) => `[${author(p.author)}] ${p.body}`).join('\n\n'), seq: last.seq };
    const n = await schedule(group, thread, round + 1, 'member', next, trigger, pending);
    if (n === 0) await end(group, thread, 'done', null);
  };

  /** 一条投递拿到了回复文字。 */
  const handleResult = async (d: GroupDelivery, text: string, pending: Set<SessionId>): Promise<void> => {
    let group = await deps.groups.group(d.groupId);
    let thread = await deps.groups.thread(d.threadId);
    if (!group || !thread) return;
    if (thread.status !== 'running') {
      await settle(d, 'canceled', text);
      return;
    }
    if (d.purpose === 'host') {
      await applyHost(group, thread, d, parseHostText(text, group.members, d.role), pending);
      return;
    }
    if (d.purpose === 'bid') {
      const bid = parseBid(text);
      await settle(d, bid ? 'done' : 'silent', text, bid?.score ?? null);
      await closeRound(group, thread.id, d.round, pending);
      return;
    }
    if (isSilent(text) || isHeld(group, d.role)) {
      await settle(d, 'silent', text);
    } else {
      const limits = effectiveGroupLimits(group.limits);
      if (thread.messages >= limits.maxMessages) {
        await settle(d, 'silent', text);
        await end(group, thread, 'limit', `已到 ${limits.maxMessages} 条消息上限，停下来等你`);
        return;
      }
      const post = await append(group, thread, d.round, { kind: 'agent', role: d.role, sessionId: d.sessionId ?? '' }, text);
      if (post.needsUser) group = await saveGroup(group, { needsUser: true });
      thread = await saveThread(thread, { messages: thread.messages + 1 });
      await settle(d, 'done', text);
    }
    await closeRound(group, thread.id, d.round, pending);
  };

  const lastTurnText = async (sessionId: SessionId): Promise<string> => {
    const entries = await deps.sessions.tail(sessionId, 500);
    let lastPrompt = -1;
    entries.forEach((entry, index) => {
      if (entry.event.kind === 'prompt') lastPrompt = index;
    });
    return entries
      .slice(lastPrompt + 1)
      .map((entry) => (entry.event.kind === 'text' ? entry.event.delta : ''))
      .join('')
      .trim();
  };

  const chat: GroupChat = {
    async list(actor, projectId) {
      const project = await authorizeProject(deps.policy, actor, await projectOf(projectId), 'project.read');
      if (!project.ok) return project;
      return ok(await deps.groups.groupsOf(projectId));
    },

    async create(actor, projectId, input) {
      const project = await authorizeProject(deps.policy, actor, await projectOf(projectId), 'group.manage');
      if (!project.ok) return project;
      const problem = groupProblem(input, await deps.roles(projectId));
      if (problem) return err(invalid(problem));
      const now = deps.now();
      const group: Group = {
        id: newId(),
        projectId,
        name: input.name.trim(),
        members: [...input.members],
        hostRole: input.hostRole ?? null,
        speakingStrategy: input.speakingStrategy ?? 'host',
        limits: effectiveGroupLimits(input.limits),
        held: [],
        needsUser: false,
        createdBy: actor.user.id,
        createdAt: now,
        updatedAt: now
      };
      await deps.groups.saveGroup(group);
      await system(group, null, `${actor.user.displayName || actor.user.email} 建了群，成员 ${group.members.map((m) => `@${m}`).join('、')}${group.hostRole ? `，主持人 @${group.hostRole}` : '，没有主持人'}`);
      return ok(group);
    },

    async update(actor, groupId, input) {
      const found = await authorize(actor, await deps.groups.group(groupId), 'group.manage');
      if (!found.ok) return found;
      const problem = groupProblem(input, await deps.roles(found.value.group.projectId));
      if (problem) return err(invalid(problem));
      return run(groupId, async () => {
        const group = (await deps.groups.group(groupId))!;
        const next = await saveGroup(group, {
          name: input.name.trim(),
          members: [...input.members],
          hostRole: input.hostRole ?? null,
          speakingStrategy: input.speakingStrategy ?? group.speakingStrategy,
          limits: effectiveGroupLimits(input.limits ?? group.limits)
        });
        await system(next, null, `${actor.user.displayName || actor.user.email} 改了群设置`);
        return ok(next);
      });
    },

    async view(actor, groupId) {
      const found = await authorize(actor, await deps.groups.group(groupId), 'project.read');
      if (!found.ok) return found;
      const sessions = [];
      for (const s of await deps.groups.sessionsOf(groupId)) {
        const session = await deps.sessions.byId(s.sessionId);
        sessions.push({ ...s, status: session ? (isBusy(session) ? 'busy' : session.status) : 'missing' });
      }
      return ok({ group: found.value.group, sessions, running: await deps.groups.runningThreads(groupId) });
    },

    async posts(actor, groupId, afterSeq, limit) {
      const found = await authorize(actor, await deps.groups.group(groupId), 'project.read');
      if (!found.ok) return found;
      return ok(await deps.groups.posts(groupId, afterSeq, Math.min(Math.max(limit, 1), 200)));
    },

    async chains(actor, groupId, limit) {
      const found = await authorize(actor, await deps.groups.group(groupId), 'project.read');
      if (!found.ok) return found;
      const threads = await deps.groups.threads(groupId, Math.min(Math.max(limit, 1), 50));
      const out: ChainView[] = [];
      for (const thread of threads) out.push({ thread, deliveries: await deps.groups.deliveries(thread.id) });
      return ok(out);
    },

    async post(actor, groupId, body) {
      const text = typeof body === 'string' ? body.trim() : '';
      if (!text) return err(invalid('消息不能为空'));
      if (text.length > MAX_POST_CHARS) return err(invalid(`消息太长（最多 ${MAX_POST_CHARS} 字符）`));
      const found = await authorize(actor, await deps.groups.group(groupId), 'group.post');
      if (!found.ok) return found;
      return run(groupId, async (pending) => {
        let group = (await deps.groups.group(groupId))!;
        const me: PostAuthor = { kind: 'user', id: actor.user.id, name: actor.user.displayName || actor.user.email };

        // 「停止 @x」：只暂停点名的成员，不开新对话
        const stopped = parseStopCommand(text, group.members);
        if (stopped) {
          const post = await append(group, null, 0, me, text);
          group = await saveGroup(group, { held: [...new Set([...group.held, ...stopped])], needsUser: false });
          for (const thread of await deps.groups.runningThreads(groupId)) {
            for (const d of await deps.groups.deliveries(thread.id)) {
              if (stopped.includes(d.role) && isDeliveryOpen(d)) {
                await settle(d, 'canceled', null);
                if (d.status === 'delivered' && d.sessionId) await deps.interrupt?.(d.sessionId);
                if (d.purpose === 'host') await end(group, thread, 'stopped', null);
                else await closeRound(group, thread.id, d.round, pending);
              }
            }
          }
          await system(group, null, `已暂停 ${stopped.map((s) => `@${s}`).join('、')}，你下次发言时恢复`);
          return ok(post);
        }

        // 人说话了：解除暂停、清掉「需要你」
        group = await saveGroup(group, { held: [], needsUser: false });
        const now = deps.now();
        const root = await append(group, null, 0, me, text);
        let thread: GroupThread = { id: newId(), groupId, rootPostId: root.id, status: 'running', round: 0, messages: 0, createdAt: now, updatedAt: now };
        await deps.groups.saveThread(thread);
        const mentions = parseMentions(text, group.members);
        if (mentions.outsiders.length > 0) await system(group, thread, `${mentions.outsiders.map((o) => `@${o}`).join('、')} 不在这个群里`);
        const trigger = { author: me.name, body: text, seq: root.seq };

        if (mentions.members.length > 0) {
          thread = await saveThread(thread, { round: 1 });
          const n = await schedule(group, thread, 1, 'member', mentions.members, trigger, pending);
          if (n === 0) await end(group, thread, 'done', '点名的成员都起不来');
          return ok(root);
        }

        if (group.speakingStrategy === 'volunteer') {
          thread = await saveThread(thread, { round: 1 });
          const n = await schedule(group, thread, 1, 'bid', group.members, trigger, pending);
          if (n === 0) await end(group, thread, 'done', '没有可以接话的成员');
          return ok(root);
        }

        // 主持人：没配 / 限流 → 只记录不分派
        if (!group.hostRole || !group.members.includes(group.hostRole)) {
          await end(group, thread, 'fallback', `${HOST_UNAVAILABLE_LINE}（没有设置主持人，@ 成员可以直接叫人）`);
          return ok(root);
        }
        const recent = (await deps.groups.threads(groupId, HOST_PER_MINUTE + 5)).filter((t) => t.id !== thread.id && t.createdAt > now - 60_000 && t.status !== 'rate_limited');
        if (recent.length >= HOST_PER_MINUTE) {
          await end(group, thread, 'rate_limited', `这一分钟消息太多（上限 ${HOST_PER_MINUTE} 条），只记录不分派`);
          return ok(root);
        }
        const n = await schedule(group, thread, 0, 'host', [group.hostRole], trigger, pending);
        if (n === 0) await end(group, thread, 'fallback', HOST_UNAVAILABLE_LINE);
        return ok(root);
      });
    },

    async stop(actor, groupId) {
      const found = await authorize(actor, await deps.groups.group(groupId), 'group.post');
      if (!found.ok) return found;
      return run(groupId, async () => {
        let group = (await deps.groups.group(groupId))!;
        group = await saveGroup(group, { held: ['*'] });
        let canceled = 0;
        for (const thread of await deps.groups.runningThreads(groupId)) {
          for (const d of await deps.groups.deliveries(thread.id)) {
            if (!isDeliveryOpen(d)) continue;
            await settle(d, 'canceled', null);
            canceled++;
            if (d.status === 'delivered' && d.sessionId) await deps.interrupt?.(d.sessionId);
          }
          await saveThread(thread, { status: 'stopped' });
        }
        await system(group, null, `${actor.user.displayName || actor.user.email} 按了停止${canceled ? `，取消了 ${canceled} 个待办` : ''}；成员暂停到你再次发言`);
        return ok(group);
      });
    },

    async dispatch(sessionId, input) {
      const member = await deps.groups.memberOfSession(sessionId);
      if (!member) return err(forbidden('这条会话不在任何群里'));
      return run(member.groupId, async (pending) => {
        const d = (await deps.groups.deliveredTo(sessionId)).find((x) => x.purpose === 'host');
        if (!d) return err(invalid('你现在没有要分派的群消息'));
        const group = await deps.groups.group(d.groupId);
        const thread = await deps.groups.thread(d.threadId);
        if (!group || !thread || thread.status !== 'running') return err(invalid('这段对话已经结束'));
        const decision = validateDispatch(input, group.members, d.role);
        if (decision.kind === 'invalid') return err(invalid(decision.reason));
        await applyHost(group, thread, d, decision, pending);
        return ok(decision.kind === 'assign' ? { assignees: decision.assignees } : { declined: true as const });
      });
    },

    async turnEnded(sessionId) {
      const member = await deps.groups.memberOfSession(sessionId);
      if (!member) return;
      await run(member.groupId, async (pending) => {
        pending.add(sessionId);
        const open = await deps.groups.deliveredTo(sessionId);
        if (open.length === 0) return;
        const text = await lastTurnText(sessionId);
        for (const d of open) await handleResult(d, text, pending);
      });
    },

    async sweep() {
      const now = deps.now();
      let n = 0;
      for (const d of await deps.groups.openBefore(now - HOST_TIMEOUT_MS)) {
        const timeout = d.purpose === 'host' ? HOST_TIMEOUT_MS : MEMBER_TIMEOUT_MS;
        if (d.createdAt > now - timeout) continue;
        n++;
        await run(d.groupId, async (pending) => {
          const current = (await deps.groups.deliveries(d.threadId)).find((x) => x.id === d.id);
          const group = await deps.groups.group(d.groupId);
          const thread = await deps.groups.thread(d.threadId);
          if (!current || !isDeliveryOpen(current) || !group || !thread) return;
          if (thread.status !== 'running') {
            await settle(current, 'canceled', null);
            return;
          }
          await failed(group, thread, current, d.purpose === 'host' ? `${Math.round(HOST_TIMEOUT_MS / 60_000)} 分钟没有结果` : '超时没回', pending);
        });
      }
      return n;
    },

    memberOf: (sessionId) => deps.groups.memberOfSession(sessionId)
  };
  return chat;
}
