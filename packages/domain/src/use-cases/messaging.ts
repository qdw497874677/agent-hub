import { decide, type Permission } from '../access.ts';
import { validateAgentRef } from '../agent-ref.ts';
import { botIdFrom, type PersistentAgent, type PersistentAgentDefinition } from '../bot.ts';
import type { Principal } from '../account.ts';
import { conflict, forbidden, invalid, notFound, unavailable, type DomainError } from '../errors.ts';
import { newId, type ProjectId, type SessionId, type TaskId } from '../ids.ts';
import { requestReplayKey } from '../request-replay.ts';
import { createSessionLane, type SessionLane } from '../session-lane.ts';
import {
  DEFAULT_ASK_TIMEOUT_MS,
  MAX_ASK_TIMEOUT_SEC,
  MAX_BODY_CHARS,
  STORM_LIMITS,
  HANDOFF_BUS_ORIGIN,
  defaultHandle,
  isHandle,
  externalAddress,
  isExternalSender,
  privilegeTierFor,
  validateParts,
  type MessagePart,
  type ReplyStatus,
  configProblem,
  effectiveLimits,
  isActive,
  newMessageId,
  newTraceId,
  addressName,
  botAddress,
  parseAddress,
  wrapUntrusted,
  type AgentMessage,
  type FailureCode,
  type MessageAuditAction,
  type MessageKind,
  type MessageLimits,
  type MessagingConfig,
  type SpawnRecord
} from '../messaging.ts';
import type { MessageStore } from '../ports/message-store.ts';
import type { SessionLinkRepository } from '../ports/session-link-repository.ts';
import type { Project } from '../project.ts';
import { err, ok, type Result } from '../result.ts';
import { isBusy, type Session } from '../session.ts';
import { otherEnd } from '../session-link.ts';
import { projectAsResource, projectOfSessionOrigin, authorizeSession, type AccessPolicy } from './authorization.ts';
import type { Subject } from '../access.ts';
import type { Deps } from './deps.ts';
import { loadBotConfig } from './bots.ts';
import {
  inSameTaskTree,
  lineageTaskId,
  sameTaskTreeRoot,
  taskTreeIndex,
  taskTreeRoot,
  type TaskTreeIndex
} from './message-reachability.ts';

/**
 * 消息总线（ADR 0018 · P2P 内核）：
 * 接收（权限 ∩、限额、幂等、审计）→ 解析地址 → 对方空闲就投、忙就排队 → 回合结束时收回复（agent_reply 优先，最后一轮文字兜底）并投下一条。
 * 派生新会话要 agent.spawn，且要人批。
 */
export interface MessageBusDeps extends Pick<Deps, 'now' | 'sessions' | 'projects' | 'tasks' | 'bots' | 'workspaces' | 'workspaceGroups'> {
  readonly messages: MessageStore;
  readonly policy?: AccessPolicy;
  /** userId → 带上自定义角色和显式授权的 Principal；停用 / 不存在是 null。 */
  readonly principalOf: (userId: string) => Promise<Principal | null>;
  /** 把一段话作为一轮提问送进会话（组合根接到 promptSessionUseCase）。 */
  readonly deliver: (sessionId: SessionId, text: string, author: { id: string; name: string; via: string }) => Promise<Result<unknown, DomainError>>;
  /** 按 bot 开一条新会话（组合根：建任务 + 派生会话）。actor 是批准的人。 */
  readonly spawn: (input: { project: Project; role: PersistentAgent; actor: Principal; title: string }) => Promise<Result<Session, DomainError>>;
  readonly askTimeoutMs?: number;
  /** 同一条会话的投递闸（组合根里两边共用一个）；occupied = 别的通道在这条会话上还有没收尾的投递。 */
  readonly lane?: SessionLane;
  readonly occupied?: (sessionId: SessionId) => Promise<boolean>;
  /** 会话连线。给了就收紧成“只有连过的会话能互发/互相看见”；不给 = 旧的全项目可见。 */
  readonly links?: SessionLinkRepository;
}

export interface SendCommand {
  readonly fromSessionId: SessionId;
  readonly kind: Exclude<MessageKind, 'reply'>;
  readonly to: string;
  readonly body: string;
  readonly idempotencyKey?: string;
  /** 人在界面里替这条会话发起（链头）：代的就是这个人，不是会话主人。agent 经工具发的不填。 */
  readonly onBehalfOf?: string;
  /** 结构化附件（data / ref / file / link），domain 里校验。 */
  readonly parts?: unknown;
  /** 只有 send 可以设 false：进对方收件箱，不唤醒。 */
  readonly wake?: boolean;
  /** 只用于 ask：多久没回算超时（秒），默认 1800，最多 14400。 */
  readonly timeoutSec?: number;
}

/** 外部 agent 经开放 API 发消息（P1d）：令牌即身份，收件箱 = 令牌 id。 */
export interface ExternalSendCommand {
  readonly inboxId: string;
  /** 署名，例如「外部 · ci-bot」。 */
  readonly label: string;
  /** 令牌背后的账号（链头那个人）。 */
  readonly onBehalfOf: string;
  readonly targetSessionId: SessionId;
  readonly kind: Exclude<MessageKind, 'reply'>;
  readonly body: string;
  readonly parts?: unknown;
  readonly wake?: boolean;
  readonly timeoutSec?: number;
  readonly idempotencyKey?: string;
}

export const PROJECT_HANDOFF_OPERATION = 'message.handoff';

/**
 * 可信的项目内交接（docs/design/project-session-mcp.md）。
 *
 * 和 agent.send 不是同一条入口：项目由服务器按会话的不可变来源解析，调用方不能传 projectId 绕过；
 * 只放宽「必须显式连线」这一条旧规则，派生隔离、权限、限额、收起状态仍然照常检查。
 */
export interface ProjectHandoffCommand {
  readonly fromSessionId: SessionId;
  /** 服务器 grant 绑定的人；不是消息正文里的自称。 */
  readonly actorId: string;
  readonly targetSessionId: SessionId;
  readonly body: string;
  /** 持久请求键：按 actor + 来源会话 + 项目 + 操作隔离，重试回放原结果。 */
  readonly requestKey: string;
  readonly parts?: unknown;
  /** 默认 false：只进对方收件箱，不唤醒、不自动投递。true 才排队并尝试唤醒一轮。 */
  readonly wake?: boolean;
}

export interface ReplyExtra {
  readonly status?: ReplyStatus;
  readonly parts?: unknown;
}

export interface Accepted {
  readonly messageId: string;
  readonly traceId: string;
  readonly status: AgentMessage['status'];
  readonly targetSessionId: SessionId | null;
  readonly holdReason?: AgentMessage['holdReason'];
}

export interface AgentDirectoryEntry {
  readonly address: string;
  readonly label: string;
  readonly status: string;
  readonly description?: string;
  /** 是否通过画布/对话页显式连接（派生关系不算）。 */
  readonly connected?: boolean;
  /**
   * 这条目录项为什么能联系：显式连线 > 派生父子 > 同一棵顶层任务树。
   * 只解释已有可达性，不参与判定；没有可解释关系的旧目录项不带这个字段。
   */
  readonly relation?: 'explicit' | 'task_tree' | 'spawn';
  /** 会话通信 P1a：同伴的短名、落点和仓库。 */
  readonly handle?: string;
  readonly workerId?: string | null;
  readonly repo?: string | null;
  readonly branch?: string | null;
  readonly title?: string | null;
  /** 发给我、还没读的通知（wake=false）。 */
  readonly unread?: number;
}

/**
 * 发现同任务树新增同伴时的查看者。
   * 不给 = 用当前消息代理人（没有入站消息时用会话主人）；HTTP 则传当前登录主体；
 * 显式 `null` = 不推断新同伴，只保留旧的显式 / 派生关系。
 */
export interface PeerDiscoveryOptions {
  readonly viewer?: Subject | null;
}

export interface MessageBus {
  accept(command: SendCommand): Promise<Result<Accepted, DomainError>>;
  /**
   * 可信项目内交接：同一项目、明确目标会话、默认只进收件箱。
   * 只绕过「必须显式连线」；其他检查和普通发送一致（见 ProjectHandoffCommand）。
   */
  handoff(command: ProjectHandoffCommand): Promise<Result<Accepted, DomainError>>;
  /** agent_reply：回答投给自己的 ask。messageId 不给 = 当前唯一在处理的那条 ask。 */
  reply(fromSessionId: SessionId, body: string, messageId?: string, extra?: ReplyExtra): Promise<Result<{ messageId: string; replyTo: string }, DomainError>>;
  /** 会话一轮结束（journal 里出现 ended）。 */
  turnEnded(sessionId: SessionId, outcome: 'done' | 'stopped' | 'interrupted' | 'failed'): Promise<void>;
  /** 人批 / 拒一条派生请求。 */
  decideSpawn(messageId: string, actor: Principal, approve: boolean): Promise<Result<AgentMessage, DomainError>>;
  directory(fromSessionId: SessionId, options?: PeerDiscoveryOptions): Promise<Result<AgentDirectoryEntry[], DomainError>>;
  /** 只列能直接联系的会话：显式连线、派生父子、同一棵顶层任务树（不含角色）。 */
  peers(fromSessionId: SessionId, options?: PeerDiscoveryOptions): Promise<Result<AgentDirectoryEntry[], DomainError>>;
  status(fromSessionId: SessionId, messageId: string): Promise<Result<AgentMessage, DomainError>>;
  inbox(sessionId: SessionId, limit: number, options?: { unreadOnly?: boolean; markRead?: boolean }): Promise<AgentMessage[]>;
  /** 人放行 / 拒绝一条被拦下（held）的消息。 */
  decideHeld(messageId: string, actor: Principal, approve: boolean): Promise<Result<AgentMessage, DomainError>>;
  /** 设置任务内短名（peer:<handle>）。 */
  setHandle(sessionId: SessionId, handle: string, actor: string): Promise<Result<{ handle: string }, DomainError>>;
  /** 有效短名：设过的，或默认 <agentId>-<id 尾 4 位>。 */
  handleOf(session: Session): Promise<string>;
  /** 同伴简报：同伴集合或状态变了才返回文字，否则 null（省 token）。 */
  briefing(sessionId: SessionId): Promise<string | null>;
  /**
   * 只读看同伴（P1c）：把 `session:<id>` / `peer:<短名>` 解析成能到达的会话 id（同项目、连线或派生父子；自己也行）。
   * 用在 workspace.list / read / changes 与 git.state 的 session 参数上。
   */
  resolvePeer(fromSessionId: SessionId, address: string): Promise<Result<SessionId, DomainError>>;
  /** 外部发送（P1d）：权限（对目标会话 session.prompt）由开放 API 的守门先查过。 */
  acceptExternal(command: ExternalSendCommand): Promise<Result<Accepted, DomainError>>;
  /** 外部查一条自己发的消息（或发给自己的回复）与它的回复。 */
  externalMessage(inboxId: string, messageId: string): Promise<Result<{ message: AgentMessage; reply: AgentMessage | null }, DomainError>>;
  /** 外部收件箱：回复（含失败通知），createdAt > after，正序。 */
  externalInbox(inboxId: string, after: number, limit: number): Promise<AgentMessage[]>;
  /** 超时扫一遍（组合根定时调）。 */
  sweep(): Promise<number>;
  config(projectId: ProjectId): Promise<MessagingConfig>;
  saveConfig(projectId: ProjectId, input: { roles: readonly PersistentAgentDefinition[]; limits: Partial<MessageLimits>; trustPeers?: boolean }, actor?: string): Promise<Result<MessagingConfig, DomainError>>;
}

const summary = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}…` : text).replaceAll('\n', ' ');

export function createMessageBus(deps: MessageBusDeps): MessageBus {
  const askTimeout = deps.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  // 同一个目标会话的投递串行：避免两条消息同时判断「空闲」然后都投进去
  const locks = new Map<string, Promise<unknown>>();
  const lane = deps.lane ?? createSessionLane();
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

  const audit = async (message: Pick<AgentMessage, 'id' | 'traceId' | 'projectId' | 'onBehalfOf'> | null, base: { traceId: string; projectId: ProjectId; onBehalfOf: string }, action: MessageAuditAction, actor: string, detail: string) =>
    deps.messages.audit({
      id: newId(),
      traceId: message?.traceId ?? base.traceId,
      messageId: message?.id ?? null,
      projectId: message?.projectId ?? base.projectId,
      action,
      actor,
      onBehalfOf: message?.onBehalfOf ?? base.onBehalfOf,
      detail: detail.slice(0, 300),
      at: deps.now()
    });

  const ownerOf = (session: Session, project: Project): string | null => session.createdBy ?? project.createdBy ?? null;

  const allowed = async (userId: string | null, permission: Permission, project: Project): Promise<boolean> => {
    if (!userId) return false;
    const principal = await deps.principalOf(userId);
    if (!principal) return false;
    if (!deps.policy) return true;
    const ctx = await deps.policy.context();
    return decide(principal, permission, projectAsResource(project, ctx), ctx).allow;
  };

  /**
   * 一次发现 / 一次发送内复用的关系缓存。
   * 同一次操作里目录可能有很多会话：派生记录、连线、任务树、主人权限都只查一次，
   * 避免每个候选都重新走父链或重复打策略。
   */
  type ReachContext = {
    readonly project: Project;
    readonly spawns: Map<SessionId, Promise<SpawnRecord | null>>;
    readonly linked: Map<SessionId, Promise<boolean>>;
    readonly owners: Map<string, Promise<boolean>>;
    /** 本次操作里同一个查看者对候选会话的 session.read 判定。 */
    readonly visible: Map<SessionId, Promise<boolean>>;
    tree?: TaskTreeIndex;
  };

  const reachContext = (project: Project): ReachContext => ({
    project,
    spawns: new Map(),
    linked: new Map(),
    owners: new Map(),
    visible: new Map()
  });

  const spawnOfCached = (ctx: ReachContext, sessionId: SessionId): Promise<SpawnRecord | null> => {
    const cached = ctx.spawns.get(sessionId);
    if (cached) return cached;
    const pending = deps.messages.spawnOf(sessionId);
    ctx.spawns.set(sessionId, pending);
    return pending;
  };

  const linkedCached = (ctx: ReachContext, from: Session, target: Session): Promise<boolean> => {
    if (!deps.links) return Promise.resolve(false);
    const cached = ctx.linked.get(target.id);
    if (cached) return cached;
    const pending = deps.links.areLinked(from.id, target.id);
    ctx.linked.set(target.id, pending);
    return pending;
  };

  /** 目录 / 同伴列表用：本项目任务列表只建一次索引。发送两端则走下面的单链推导，不扫项目。 */
  const treeIndexFor = async (ctx: ReachContext): Promise<TaskTreeIndex> => {
    if (ctx.tree) return ctx.tree;
    const tasks = await deps.tasks.listByProject(ctx.project.id);
    const built = taskTreeIndex(tasks, ctx.project.id);
    ctx.tree = built;
    return built;
  };

  const sameTreeOf = async (from: Session, target: Session, ctx: ReachContext): Promise<boolean> => {
    if (!deps.links) return false;
    const fromTask = lineageTaskId(from, ctx.project.id);
    const targetTask = lineageTaskId(target, ctx.project.id);
    if (!fromTask || !targetTask) return false;
    // 同一个 taskId 不代表血缘可用：缺父、跨项目父、环都仍要失败关闭。
    if (ctx.tree) return inSameTaskTree(ctx.tree, fromTask, targetTask);
    // 发送只有两端：各自沿父链走到根，最多 MAX_LINEAGE_DEPTH 步，不扫整个项目。
    const load = (id: TaskId) => deps.tasks.byId(id);
    if (fromTask === targetTask) return (await taskTreeRoot(fromTask, ctx.project.id, load)) !== null;
    const [fromRoot, targetRoot] = await Promise.all([
      taskTreeRoot(fromTask, ctx.project.id, load),
      taskTreeRoot(targetTask, ctx.project.id, load)
    ]);
    return sameTaskTreeRoot(fromRoot, targetRoot);
  };

  /** 旧规则：显式连线或同一条派生链（父 ↔ 子）；没配 links 时保持旧行为。 */
  const legacyReach = async (from: Session, target: Session, ctx?: ReachContext): Promise<boolean> => {
    if (!deps.links) return true;
    const [fromSpawn, targetSpawn] = ctx
      ? await Promise.all([spawnOfCached(ctx, from.id), spawnOfCached(ctx, target.id)])
      : await Promise.all([deps.messages.spawnOf(from.id), deps.messages.spawnOf(target.id)]);
    if (fromSpawn?.spawnerSessionId === target.id || targetSpawn?.spawnerSessionId === from.id) return true;
    return ctx ? linkedCached(ctx, from, target) : deps.links.areLinked(from.id, target.id);
  };

  /** 默认通信范围 = 旧规则（显式连线 / 派生父子）∪ 同一棵顶层任务树。 */
  const canReach = async (from: Session, target: Session, ctx: ReachContext): Promise<boolean> => {
    if (await legacyReach(from, target, ctx)) return true;
    return sameTreeOf(from, target, ctx);
  };

  /** 隔离：消息派生出来的任务会话只能和派生它的会话来往。 */
  const isolationProblem = async (from: Session, target: Session, ctx?: ReachContext): Promise<string | null> => {
    const [fromSpawn, targetSpawn] = ctx
      ? await Promise.all([spawnOfCached(ctx, from.id), spawnOfCached(ctx, target.id)])
      : await Promise.all([deps.messages.spawnOf(from.id), deps.messages.spawnOf(target.id)]);
    if (fromSpawn && fromSpawn.spawnerSessionId !== target.id) return '派生出来的任务会话默认隔离：只能回给派生它的会话';
    if (targetSpawn && targetSpawn.spawnerSessionId !== from.id) return '那是别的会话派生的任务会话（默认隔离），不能直接找它';
    return null;
  };

  const linkProblem = async (from: Session, target: Session, ctx: ReachContext): Promise<string | null> =>
    (await canReach(from, target, ctx)) ? null : '只有明确连接或同一任务树的会话才能互相发消息';

  const handleOf = async (session: Session): Promise<string> => (await deps.messages.handleOf(session.id)) ?? defaultHandle(session);

  const ownerCanReceive = (ctx: ReachContext, session: Session): Promise<boolean> => {
    const owner = ownerOf(session, ctx.project);
    const key = owner ?? '';
    const cached = ctx.owners.get(key);
    if (cached) return cached;
    const pending = !owner
      ? Promise.resolve(false)
      // 能看到 / 能联系 = 至少有一种消息权限；具体 kind 的权限仍由 accept 按旧规则交集检查。
      : (async () => (await allowed(owner, 'agent.message.send', ctx.project)) || (await allowed(owner, 'agent.ask', ctx.project)))();
    ctx.owners.set(key, pending);
    return pending;
  };

  /** 同树新增同伴和发送共用同一轮的代理人；HTTP 可显式传当前登录主体。 */
  const defaultViewer = async (from: Session, project: Project): Promise<Subject | null> => {
    if (!deps.policy) return null;
    const userId = (await incomingContext(from.id))?.onBehalfOf ?? ownerOf(from, project);
    return userId ? deps.principalOf(userId) : null;
  };

  /** 新推断的同树同伴必须真的能被查看者 session.read；旧显式 / 派生关系不经过这里。 */
  const canView = (ctx: ReachContext, viewer: Subject | null, target: Session): Promise<boolean> => {
    if (!deps.policy) return Promise.resolve(true);
    if (!viewer) return Promise.resolve(false);
    const cached = ctx.visible.get(target.id);
    if (cached) return cached;
    const pending = authorizeSession(deps.policy, viewer, ctx.project, target, 'session.read').then((result) => result.ok);
    ctx.visible.set(target.id, pending);
    return pending;
  };

  /** 任务树新增的同伴：隔离不放松，不把主人没有任何消息权限的会话暴露出来，也不越过查看者的 session.read。 */
  const sameTreePeer = async (from: Session, target: Session, ctx: ReachContext, viewer: Subject | null): Promise<boolean> => {
    if (!(await sameTreeOf(from, target, ctx))) return false;
    if ((await isolationProblem(from, target, ctx)) !== null) return false;
    if (!(await ownerCanReceive(ctx, target))) return false;
    return canView(ctx, viewer, target);
  };

  /** 旧同伴集合：显式连线 + 派生父会话。 */
  const legacyPeerSessions = async (from: Session, ctx?: ReachContext): Promise<Session[]> => {
    const ids = new Set<SessionId>();
    if (deps.links) for (const link of await deps.links.forSession(from.id)) {
      const other = otherEnd(link, from.id);
      if (other) ids.add(other);
    }
    const spawn = ctx ? await spawnOfCached(ctx, from.id) : await deps.messages.spawnOf(from.id);
    if (spawn) ids.add(spawn.spawnerSessionId);
    const out: Session[] = [];
    for (const id of ids) {
      const session = await deps.sessions.byId(id);
      if (session && session.status !== 'failed') out.push(session);
    }
    return out;
  };

  /**
   * 能直接说话的同伴：显式连线 + 派生父会话 + 同一棵顶层任务树（后者仅在严格模式）。
   * 同树扩展只加可见、未隔离的会话；旧有连线/派生条目保持原样（包括已收起的状态展示）。
   */
  const peerSessions = async (
    from: Session,
    project: Project,
    ctx: ReachContext = reachContext(project),
    viewer?: Subject | null
  ): Promise<Session[]> => {
    const out = await legacyPeerSessions(from, ctx);
    if (!deps.links || !lineageTaskId(from, project.id)) return out;
    await treeIndexFor(ctx);
    const actualViewer = viewer === undefined ? await defaultViewer(from, project) : viewer;
    const seen = new Set(out.map((session) => session.id));
    for (const session of await deps.sessions.listByProject(project.id)) {
      if (session.id === from.id || session.status === 'failed' || seen.has(session.id)) continue;
      if (!(await sameTreePeer(from, session, ctx, actualViewer))) continue;
      seen.add(session.id);
      out.push(session);
    }
    return out;
  };

  type HandleLookup =
    | { readonly kind: 'found'; readonly session: Session }
    | { readonly kind: 'none' }
    | { readonly kind: 'ambiguous'; readonly sessions: readonly Session[] };

  /**
   * peer:<handle> → 会话（普通发送用）。
   * 优先级：同任务显式短名 > 其他显式短名 > 默认短名；同一优先级有多个就是歧义，
   * 只回可联系同伴的 session id，不替调用方猜。
   */
  const resolveHandleForSend = async (
    from: Session,
    project: Project,
    handle: string,
    ctx: ReachContext,
    viewer: Subject | null
  ): Promise<HandleLookup> => {
    const explicitSameTask: Session[] = [];
    const explicitOtherTree: Session[] = [];
    const defaults: Session[] = [];
    for (const peer of await peerSessions(from, project, ctx, viewer)) {
      const stored = await deps.messages.handleOf(peer.id);
      if (stored !== null) {
        if (stored !== handle) continue;
        if (from.taskId && peer.taskId === from.taskId) explicitSameTask.push(peer);
        else explicitOtherTree.push(peer);
      } else if (defaultHandle(peer) === handle) {
        defaults.push(peer);
      }
    }
    for (const tier of [explicitSameTask, explicitOtherTree, defaults]) {
      if (tier.length === 1) return { kind: 'found', session: tier[0]! };
      if (tier.length > 1) return { kind: 'ambiguous', sessions: [...tier].sort((a, b) => a.id.localeCompare(b.id)) };
    }
    return { kind: 'none' };
  };

  /** 旧解析（工作空间 resolvePeer 专用）：任务内设过的短名直查 + 旧同伴集合，不扩任务树。 */
  const resolveHandleLegacy = async (from: Session, handle: string): Promise<Session | null> => {
    if (from.taskId) {
      const id = await deps.messages.sessionByHandle(from.taskId, handle);
      if (id) {
        const found = await deps.sessions.byId(id);
        if (found) return found;
      }
    }
    for (const peer of await legacyPeerSessions(from)) if ((await handleOf(peer)) === handle) return peer;
    return null;
  };

  const sessionAndProject = async (sessionId: SessionId): Promise<{ session: Session; project: Project } | null> => {
    const session = await deps.sessions.byId(sessionId);
    if (!session) return null;
    // #243：身份只认不可变来源（任务 / originProjectId / 组 / 临时空间），不按放置反推。
    const project = await projectOfSessionOrigin(deps, session);
    if (!project || project.deletedAt !== null) return null;
    return { session, project };
  };

  /**
   * 交接用的项目解析：只认会话的不可变来源。
   * 有任务时必须和任务项目一致；没有任务的会话必须明确带 originProjectId。
   * 这比 projectOfSessionOrigin 更严——后者缺来源时会回落分组/临时空间，交接必须失败关闭。
   */
  const canonicalProjectOf = async (session: Session): Promise<Result<Project, DomainError>> => {
    let projectId: ProjectId;
    if (session.taskId) {
      const task = await deps.tasks.byId(session.taskId);
      if (!task) return err(forbidden('会话的任务不存在，无法确认项目'));
      if (session.originProjectId != null && session.originProjectId !== task.projectId) {
        return err(forbidden('会话的项目来源与任务项目冲突'));
      }
      projectId = task.projectId;
    } else {
      if (!session.originProjectId) return err(forbidden('无任务会话没有不可变的项目来源'));
      projectId = session.originProjectId;
    }
    const project = await deps.projects.byId(projectId);
    if (!project || project.deletedAt !== null) return err(notFound('项目不存在'));
    return ok(project);
  };

  // bot 列表从 bots 表读（表空时回落旧 roles JSON）；限额仍来自旧的配置行。
  const loadConfig = async (projectId: ProjectId): Promise<MessagingConfig> => loadBotConfig({ bots: deps.bots, messages: deps.messages }, projectId);

  const labelOf = (session: Session, bot: string | null): string => `${bot ?? session.agentId}（会话 #${session.id.slice(0, 6)}）`;

  const nameOf = async (userId: string): Promise<string> => {
    const principal = await deps.principalOf(userId);
    return principal ? principal.user.displayName || principal.user.email : userId;
  };

  /** 这条会话这一轮是被哪条消息叫起来的：它决定继承的 trace、深度和 onBehalfOf。 */
  const incomingContext = async (sessionId: SessionId): Promise<AgentMessage | null> => {
    const delivered = await deps.messages.deliveredTo(sessionId);
    return delivered.sort((a, b) => (b.deliveredAt ?? 0) - (a.deliveredAt ?? 0))[0] ?? null;
  };

  /** 对方空闲就投下一条排队的。 */
  const pump = (targetId: SessionId): Promise<void> =>
    serial(targetId, () => lane.run(targetId, async () => {
      const target = await deps.sessions.byId(targetId);
      if (!target) return;
      if (target.settledAt) {
        await drainArchived(target);
        return;
      }
      if (isBusy(target)) return;
      if ((await deps.messages.deliveredTo(targetId)).length > 0) return;
      if (await deps.occupied?.(targetId)) return;
      const next = (await deps.messages.queuedFor(targetId))[0];
      if (!next) return;
      const from = isExternalSender(next.fromSessionId) ? null : await deps.sessions.byId(next.fromSessionId);
      const fromLabel = next.fromLabel ?? (from ? labelOf(from, (await deps.messages.spawnOf(from.id))?.role ?? null) : next.fromSessionId);
      const text = wrapUntrusted({
        message: next,
        fromLabel,
        fromSessionId: next.fromSessionId,
        onBehalfOfName: await nameOf(next.onBehalfOf)
      });
      const author = {
        id: `agent:${next.fromSessionId}`,
        name: `${fromLabel} 代 ${await nameOf(next.onBehalfOf)}`,
        via: 'agent'
      };
      const now = deps.now();
      const delivering: AgentMessage = { ...next, status: 'delivered', deliveredAt: now, readAt: now, updatedAt: now };
      // 先条件认领再投递：另一个入口（另一个 pump / 进程）已经抢走时就别再投第二次。
      const claimed = deps.messages.claimDelivered
        ? await deps.messages.claimDelivered(next.id, now)
        : (await deps.messages.save(delivering), true);
      if (!claimed) return;
      const sent = await deps.deliver(targetId, text, author);
      if (!sent.ok) {
        // 派发失败时 prompt 用例自己也会记一个 ended(failed)，turnEnded 可能已经把它判了失败：只判一次。
        const current = await deps.messages.byId(delivering.id);
        if (current?.status === 'delivered') await fail(current, 'target_offline', sent.error.message);
        return;
      }
      await audit(delivering, delivering, 'delivered', 'hub', `→ ${targetId}`);
    }));

  /** 失败：标记、审计；ask 失败要告诉提问方（以一条带 failure 的 reply 回去）。 */
  const fail = async (message: AgentMessage, code: FailureCode, detail: string): Promise<void> => {
    const now = deps.now();
    await deps.messages.save({ ...message, status: 'failed', failure: code, failureDetail: detail.slice(0, 500), updatedAt: now });
    await audit(message, message, 'failed', 'hub', `${code}: ${detail}`);
    if (message.kind === 'ask') await enqueueReply(message, null, null, { code, detail });
  };

  /** 把回复（或失败通知）排进提问方的队列。 */
  const enqueueReply = async (
    ask: AgentMessage,
    body: string | null,
    fromSessionId: SessionId | null,
    failure?: { code: FailureCode; detail: string },
    extra?: { status?: ReplyStatus; parts?: readonly MessagePart[] }
  ): Promise<AgentMessage> => {
    const now = deps.now();
    const reply: AgentMessage = {
      id: newMessageId(),
      traceId: ask.traceId,
      depth: ask.depth,
      projectId: ask.projectId,
      kind: 'reply',
      fromSessionId: fromSessionId ?? ask.targetSessionId ?? ask.fromSessionId,
      onBehalfOf: ask.onBehalfOf,
      to: `session:${ask.fromSessionId}`,
      targetSessionId: ask.fromSessionId,
      role: null,
      replyTo: ask.id,
      body: body ?? '',
      status: 'queued',
      failure: failure?.code ?? null,
      failureDetail: failure?.detail ?? null,
      replyBody: null,
      replySource: null,
      idempotencyKey: null,
      createdAt: now,
      updatedAt: now,
      deliveredAt: null,
      deadlineAt: null,
      parts: extra?.parts ?? [],
      wake: true,
      replyStatus: failure ? 'failed' : (extra?.status ?? 'ok'),
      replyParts: [],
      readAt: null,
      holdReason: null
    };
    if (isExternalSender(ask.fromSessionId)) {
      // 外部提问方：回复不唤醒任何会话，直接进外部收件箱（message_inbox / message_get 取）。
      const boxed: AgentMessage = { ...reply, to: ask.fromSessionId, targetSessionId: null, status: 'done', deliveredAt: now };
      await deps.messages.save(boxed);
      await audit(boxed, boxed, 'delivered', boxed.fromSessionId, `reply → ${ask.fromSessionId}（外部收件箱）`);
      return boxed;
    }
    await deps.messages.save(reply);
    await audit(reply, reply, 'queued', reply.fromSessionId, `reply → ${ask.fromSessionId}`);
    await pump(ask.fromSessionId);
    return reply;
  };

  /** 最后一轮的文字：最后一条 prompt 之后的 text 增量拼起来。 */
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

  const peerFacts = async (session: Session, project: Project) => {
    const workspace = session.workspaceId ? await deps.workspaces.byId(session.workspaceId) : null;
    const repoUrl = workspace?.repoUrl ?? null;
    const repo = session.groupId
      ? '组合'
      : repoUrl
        ? (project.repos.find((r) => r.url === repoUrl)?.name ?? repoUrl.replace(/\.git$/, '').split('/').pop() ?? null)
        : null;
    return { workerId: session.workerId ?? workspace?.workerId ?? null, repo, branch: workspace?.branch ?? null };
  };

  const unreadFor = async (sessionId: SessionId): Promise<AgentMessage[]> =>
    (await deps.messages.forSession(sessionId, 200)).filter((m) => m.targetSessionId === sessionId && m.wake === false && !m.readAt);

  const statusLabel = (session: Session): string => (session.settledAt ? 'archived' : isBusy(session) ? 'busy' : session.status === 'running' ? 'idle' : session.status);
  const STATUS_TEXT: Record<string, string> = { archived: '已收起', busy: '工作中', idle: '空闲', done: '空闲', stopped: '已停止', interrupted: '被打断' };

  const briefingMemo = new Map<string, string>();

  /** 防风暴（§8）：按对限速、相同内容、收件队列、每链唤醒；来回打转返回 'hold'。 */
  const stormCheck = async (
    from: Session,
    target: Session,
    body: string,
    parts: readonly MessagePart[],
    trace: readonly AgentMessage[]
  ): Promise<{ code: FailureCode; message: string } | 'hold' | null> => {
    const now = deps.now();
    const sent = (await deps.messages.forSession(from.id, 200)).filter((m) => m.fromSessionId === from.id && m.targetSessionId === target.id && m.kind !== 'reply');
    if (sent.filter((m) => m.createdAt > now - 60_000).length >= STORM_LIMITS.pairPerMinute) {
      return { code: 'rate_limited', message: `1 分钟内已给这个会话发了 ${STORM_LIMITS.pairPerMinute} 条：合并成一条，或稍后再发` };
    }
    const sameParts = JSON.stringify(parts);
    if (sent.some((m) => m.createdAt > now - STORM_LIMITS.duplicateWindowMs && m.status !== 'failed' && m.status !== 'denied' && m.body === body && JSON.stringify(m.parts ?? []) === sameParts)) {
      return { code: 'duplicate', message: '10 分钟内已经发过完全一样的内容' };
    }
    const inbound = (await deps.messages.forSession(target.id, 200)).filter((m) => m.targetSessionId === target.id && (m.status === 'queued' || m.status === 'held'));
    if (inbound.length >= STORM_LIMITS.inboxMax) return { code: 'busy', message: `对方收件队列已满（${STORM_LIMITS.inboxMax} 条）` };
    if (trace.filter((m) => m.deliveredAt !== null).length >= STORM_LIMITS.traceWakeMax) {
      return { code: 'rate_limited', message: `这条协作链由消息唤醒的轮次已到上限 ${STORM_LIMITS.traceWakeMax}；请人接手` };
    }
    const pair = (m: AgentMessage) =>
      m.kind !== 'reply' &&
      ((m.fromSessionId === from.id && m.targetSessionId === target.id) || (m.fromSessionId === target.id && m.targetSessionId === from.id));
    const released = trace.filter((m) => pair(m) && m.holdReason === 'pingpong' && m.status !== 'held').map((m) => m.createdAt);
    const since = released.length > 0 ? Math.max(...released) : -Infinity;
    if (trace.filter((m) => pair(m) && m.createdAt > since && m.status !== 'denied').length >= STORM_LIMITS.pingpongMax) return 'hold';
    return null;
  };

  /** 已收起的会话：排队 / 拦下的消息一律失败（ask 会告诉提问方）。 */
  const drainArchived = async (target: Session): Promise<void> => {
    const pending = (await deps.messages.forSession(target.id, 500)).filter((m) => m.targetSessionId === target.id && (m.status === 'queued' || m.status === 'held'));
    for (const message of pending) await fail(message, 'archived', '对方会话已收起；要先重开才能收消息');
  };

  const bus: MessageBus = {
    async accept(command) {
      const body = command.body;
      if (typeof body !== 'string' || body.trim() === '') return err(invalid('消息不能为空'));
      if (body.length > MAX_BODY_CHARS) return err(invalid(`消息太长（最多 ${MAX_BODY_CHARS} 字符）`));
      const address = parseAddress(command.to);
      if (!address) return err(invalid('地址要写成 session:<id>、peer:<短名> 或 bot:<name>（旧写法 role:<name> 仍然认）'));
      if (command.wake === false && command.kind !== 'send') return err(invalid('只有 send 可以 wake=false'));
      if (command.timeoutSec !== undefined && (command.kind !== 'ask' || !Number.isInteger(command.timeoutSec) || command.timeoutSec < 30 || command.timeoutSec > MAX_ASK_TIMEOUT_SEC)) {
        return err(invalid(`timeoutSec 只用于 ask，范围 30–${MAX_ASK_TIMEOUT_SEC} 秒`));
      }
      const here = await sessionAndProject(command.fromSessionId);
      if (!here) return err(notFound('发送方会话不存在'));
      const { session: from, project } = here;
      const reach = reachContext(project);
      const checkedParts = validateParts(command.parts, project.repos.map((r) => r.name));
      if (!checkedParts.ok) return err(invalid(checkedParts.problem));
      const parts = checkedParts.parts;

      if (command.idempotencyKey) {
        const seen = await deps.messages.byIdempotencyKey(from.id, command.idempotencyKey);
        if (seen) return ok({ messageId: seen.id, traceId: seen.traceId, status: seen.status, targetSessionId: seen.targetSessionId });
      }

      const incoming = await incomingContext(from.id);
      const traceId = incoming?.traceId ?? newTraceId();
      const depth = (incoming?.depth ?? 0) + 1;
      const caller = ownerOf(from, project);
      const onBehalfOf = incoming?.onBehalfOf ?? command.onBehalfOf ?? caller;
      if (!onBehalfOf) return err(forbidden('这条会话没有主人，不能代人发消息'));
      // 任务树推断出来的新同伴按实际调用 / 代理人的 session.read 判断可见性；旧关系不经过这个检查。
      const viewer = deps.policy && onBehalfOf ? await deps.principalOf(onBehalfOf) : null;
      const base = { traceId, projectId: project.id, onBehalfOf };
      const deny = async (code: FailureCode, message: string): Promise<Result<never, DomainError>> => {
        await audit(null, base, 'denied', from.id, `${code}: ${command.kind} ${command.to} — ${message}`);
        return err(code === 'rate_limited' || code === 'depth_exceeded' ? conflict(`${code}: ${message}`) : forbidden(`${code}: ${message}`));
      };

      // 权限：发送方会话主人 ∩ onBehalfOf ∩ 被调方
      const permission: Permission = command.kind === 'ask' ? 'agent.ask' : 'agent.message.send';
      if (!(await allowed(caller, permission, project))) return deny('denied', `会话主人没有 ${permission}`);
      if (onBehalfOf !== caller && !(await allowed(onBehalfOf, permission, project))) return deny('denied', `代理的人没有 ${permission}`);

      const config = await loadConfig(project.id);
      const limits = effectiveLimits(config.limits);
      if (depth > limits.maxDepth) return deny('depth_exceeded', `协作链深度 ${depth} 超过上限 ${limits.maxDepth}`);
      const trace = incoming ? await deps.messages.byTrace(traceId) : [];
      if (trace.filter((m) => isActive(m) && m.kind !== 'reply').length >= limits.maxConcurrent) {
        return deny('rate_limited', `这条协作链同时进行中的消息已到上限 ${limits.maxConcurrent}`);
      }
      if (trace.filter((m) => m.fromSessionId === from.id && m.kind !== 'reply').length >= limits.maxFanOut) {
        return deny('rate_limited', `这一跳往外发的消息已到上限 ${limits.maxFanOut}`);
      }

      let target: Session | null = null;
      let bot: PersistentAgent | null = null;
      if (address.kind === 'session' || address.kind === 'peer') {
        if (address.kind === 'peer') {
          const found = await resolveHandleForSend(from, project, address.handle, reach, viewer);
          if (found.kind === 'ambiguous') {
            const ids = found.sessions.map((peer) => `session:${peer.id}`).join('、');
            return deny('unresolvable', `有多个同伴叫 ${address.handle}（${ids}）；请直接用 session:<id> 指定`);
          }
          if (found.kind === 'none') {
            const known = await Promise.all((await peerSessions(from, project, reach, viewer)).map(async (peer) => `peer:${await handleOf(peer)}`));
            return deny('unresolvable', `没有叫 ${address.handle} 的同伴${known.length > 0 ? `；可用：${known.join('、')}` : '；还没有能联系的同任务树会话'}`);
          }
          target = found.session;
        } else {
          target = (await sessionAndProject(address.sessionId))?.session ?? null;
        }
        const there = target ? await sessionAndProject(target.id) : null;
        if (!target || there?.project.id !== project.id) return deny('unresolvable', '同一个项目里没有这条会话');
        if (target.id === from.id) return err(invalid('不能给自己发消息'));
      } else {
        const name = addressName(address);
        bot = config.roles.find((r) => r.name === name) ?? null;
        if (!bot) return deny('unresolvable', `项目里没有定义 bot ${name}`);
        if (bot.reuse !== 'always-new') {
          const spawns = (await deps.messages.spawnsForRole(project.id, bot.name)).filter((s) => bot!.reuse === 'sticky' || s.traceId === traceId);
          for (const spawn of spawns.sort((a, b) => b.createdAt - a.createdAt)) {
            const candidate = await deps.sessions.byId(spawn.sessionId);
            if (candidate && candidate.status !== 'failed' && !candidate.settledAt && (await isolationProblem(from, candidate, reach)) === null && (await legacyReach(from, candidate, reach))) {
              target = candidate;
              break;
            }
          }
        }
      }
      if (target) {
        const inferred = !(await legacyReach(from, target, reach));
        // 不给不可见的直接地址返回接收方权限、状态或隔离详情。旧关系不改变。
        if (inferred && !(await canView(reach, viewer, target))) return deny('unresolvable', '同一个项目里没有这条会话');
        const callee = ownerOf(target, project);
        if (!(await allowed(callee, permission, project))) return deny('denied', `被调会话的主人没有 ${permission}`);
        const isolated = await isolationProblem(from, target, reach);
        if (isolated) return deny('denied', isolated);
        const unlinked = await linkProblem(from, target, reach);
        if (unlinked) return deny('denied', unlinked);
        if (target.settledAt) return deny('archived', '对方会话已收起；要先重开才能收消息');
      } else if (!(await allowed(onBehalfOf, 'agent.spawn', project)) || !(await allowed(caller, 'agent.spawn', project))) {
        return deny('denied', `没有现成的 ${addressName(address)} 会话，派生新会话要 agent.spawn 权限`);
      }

      // 防风暴计数、权限分档、落库必须同一把串行锁（LOW4）：先数后写放在锁外，
      // 并发 accept 同一对时会同时读到同一份计数，全都过线。投递（pump）在锁释放后排同一条串行队，
      // 不能在锁内调 pump——它会再入 serial(target.id)，排在还没结东的当前链后面，直接死锁。
      const commit = async (): Promise<Result<AgentMessage, DomainError>> => {
        let holdReason: AgentMessage['holdReason'] = null;
        if (target) {
          const storm = await stormCheck(from, target, body, parts, trace);
          if (storm === 'hold') holdReason = 'pingpong';
          else if (storm) return deny(storm.code, storm.message);
        }
        // P1f 权限档位：guarded → auto 先拦下（不能借自动批准的会话做自己要审批的事）；项目 trustPeers 可关。
        // 分档看整个会话：强制 yolo 的运行时（grok 固定 yoloMode 开会话）按 auto 分档（MED3）。
        const tiers = target ? { from: privilegeTierFor(from), to: privilegeTierFor(target) } : null;
        if (target && tiers && !holdReason && tiers.from === 'guarded' && tiers.to === 'auto' && config.trustPeers !== true) holdReason = 'privilege';
        const wake = command.wake !== false;
        const now = deps.now();
        const message: AgentMessage = {
          id: newMessageId(),
          traceId,
          depth,
          projectId: project.id,
          kind: command.kind,
          fromSessionId: from.id,
          onBehalfOf,
          to: command.to.trim(),
          targetSessionId: target?.id ?? null,
          role: bot?.name ?? null,
          replyTo: null,
          body,
          status: !target ? 'awaiting_approval' : holdReason ? 'held' : wake ? 'queued' : 'done',
          failure: null,
          failureDetail: null,
          replyBody: null,
          replySource: null,
          idempotencyKey: command.idempotencyKey ?? null,
          createdAt: now,
          updatedAt: now,
          deliveredAt: null,
          deadlineAt: command.kind === 'ask' ? now + (command.timeoutSec !== undefined ? command.timeoutSec * 1000 : askTimeout) : null,
          parts,
          wake,
          replyStatus: null,
          replyParts: [],
          readAt: null,
          holdReason
        };
        await deps.messages.save(message);
        const tierNote = tiers && (tiers.from === 'unknown' || tiers.to === 'unknown') ? ` tier=${tiers.from}→${tiers.to}` : '';
        await audit(message, message, 'accepted', from.id, `${command.kind} ${message.to} depth=${depth}${parts.length > 0 ? ` parts=${parts.length}` : ''}${wake ? '' : ' wake=false'}${tierNote} ${summary(body)}`);
        if (holdReason === 'privilege') {
          await audit(message, message, 'held', 'hub', '权限档位升级：要审批的会话（guarded）发给自动批准的会话（auto），等发起人或项目管理员放行');
        } else if (holdReason) {
          await audit(message, message, 'held', 'hub', `同一条链里和对方来回已到 ${STORM_LIMITS.pingpongMax} 次，等人放行`);
        } else if (!target) {
          await audit(message, message, 'spawn_requested', from.id, `${bot ? botAddress(bot.name) : 'bot'}（${bot?.ref.runtime}）等人批准`);
        }
        return ok(message);
      };
      const committed = target ? await serial(target.id, commit) : await commit();
      if (!committed.ok) return committed;
      // wake 且没人拦下才投递；状态里已经编好了这个条件（queued = 有目标、没被拦、要唤醒）
      if (committed.value.status === 'queued' && target) await pump(target.id);
      const saved = (await deps.messages.byId(committed.value.id)) ?? committed.value;
      return ok({ messageId: saved.id, traceId, status: saved.status, targetSessionId: saved.targetSessionId, ...(saved.holdReason ? { holdReason: saved.holdReason } : {}) });
    },

    async handoff(command) {
      const body = command.body;
      if (typeof body !== 'string' || body.trim() === '') return err(invalid('消息不能为空'));
      if (body.length > MAX_BODY_CHARS) return err(invalid(`消息太长（最多 ${MAX_BODY_CHARS} 字符）`));
      const actorId = command.actorId.trim();
      if (!actorId) return err(forbidden('当前账号不可用'));
      const requestKey = command.requestKey.trim();
      if (!requestKey || requestKey.length > 200) return err(invalid('请求键不合法'));
      if (command.wake !== undefined && typeof command.wake !== 'boolean') return err(invalid('wake 必须是布尔值'));

      const from = await deps.sessions.byId(command.fromSessionId);
      if (!from) return err(notFound('发送方会话不存在'));
      const fromProject = await canonicalProjectOf(from);
      if (!fromProject.ok) return fromProject;
      const project = fromProject.value;

      const target = await deps.sessions.byId(command.targetSessionId);
      if (!target) return err(notFound('目标会话不存在'));
      const targetProject = await canonicalProjectOf(target);
      if (!targetProject.ok) return targetProject;

      const incoming = await incomingContext(from.id);
      const traceId = incoming?.traceId ?? newTraceId();
      const depth = (incoming?.depth ?? 0) + 1;
      const base = { traceId, projectId: project.id, onBehalfOf: actorId };
      const deny = async (code: FailureCode, message: string): Promise<Result<never, DomainError>> => {
        await audit(null, base, 'denied', from.id, `${code}: handoff session:${target.id} — ${message}`);
        return err(code === 'rate_limited' || code === 'depth_exceeded' ? conflict(`${code}: ${message}`) : forbidden(`${code}: ${message}`));
      };

      if (targetProject.value.id !== project.id) return deny('unresolvable', '同一个项目里没有这条会话');
      if (target.id === from.id) return err(invalid('不能给自己发消息'));

      const checkedParts = validateParts(command.parts, project.repos.map((r) => r.name));
      if (!checkedParts.ok) return err(invalid(checkedParts.problem));
      const parts = checkedParts.parts;

      // 权限和普通发送同一套：发起人、发送方主人、被调方主人都要有 agent.message.send。
      const permission: Permission = 'agent.message.send';
      if (!(await allowed(actorId, permission, project))) return deny('denied', `发起人没有 ${permission}`);
      const caller = ownerOf(from, project);
      if (!caller) return deny('denied', '这条会话没有主人，不能发起交接');
      if (caller !== actorId && !(await allowed(caller, permission, project))) return deny('denied', `会话主人没有 ${permission}`);
      const callee = ownerOf(target, project);
      if (!(await allowed(callee, permission, project))) return deny('denied', `被调会话的主人没有 ${permission}`);

      // 持久回执 = 消息行本身：键按 人 + 来源会话 + 项目 + 操作 隔离，重试不会串到别的来源。
      const key = requestReplayKey({
        actorId,
        sourceSessionId: from.id,
        projectId: project.id,
        operation: PROJECT_HANDOFF_OPERATION
      }, requestKey);
      const wake = command.wake === true;

      const sameParams = (existing: AgentMessage): boolean =>
        existing.kind === 'send'
        && existing.projectId === project.id
        && existing.fromSessionId === from.id
        && existing.targetSessionId === target.id
        && existing.onBehalfOf === actorId
        && existing.role === null
        && existing.body === body
        && existing.wake === wake
        && JSON.stringify(existing.parts ?? []) === JSON.stringify(parts);
      const replay = (existing: AgentMessage): Result<Accepted, DomainError> => {
        if (!sameParams(existing)) return err(conflict('同一请求键对应不同参数'));
        return ok({
          messageId: existing.id,
          traceId: existing.traceId,
          status: existing.status,
          targetSessionId: existing.targetSessionId,
          ...(existing.holdReason ? { holdReason: existing.holdReason } : {})
        });
      };

      const seen = await deps.messages.byIdempotencyKey(from.id, key);
      if (seen) return replay(seen);

      // 派生隔离和收起状态照常检查；唯一放宽的是旧规则「必须显式连线」。
      const isolated = await isolationProblem(from, target);
      if (isolated) return deny('denied', isolated);
      if (target.settledAt) return deny('archived', '对方会话已收起；要先重开才能收消息');

      const config = await loadConfig(project.id);
      const limits = effectiveLimits(config.limits);
      if (depth > limits.maxDepth) return deny('depth_exceeded', `协作链深度 ${depth} 超过上限 ${limits.maxDepth}`);
      const trace = incoming ? await deps.messages.byTrace(traceId) : [];
      if (trace.filter((m) => isActive(m) && m.kind !== 'reply').length >= limits.maxConcurrent) {
        return deny('rate_limited', `这条协作链同时进行中的消息已到上限 ${limits.maxConcurrent}`);
      }
      if (trace.filter((m) => m.fromSessionId === from.id && m.kind !== 'reply').length >= limits.maxFanOut) {
        return deny('rate_limited', `这一跳往外发的消息已到上限 ${limits.maxFanOut}`);
      }

      const commit = async (): Promise<Result<AgentMessage, DomainError>> => {
        // 并发同键在锁内再查一次：同参回收先到的结果，异参拒绝，绝不覆盖。
        const raced = await deps.messages.byIdempotencyKey(from.id, key);
        if (raced) {
          if (!sameParams(raced)) return err(conflict('同一请求键对应不同参数'));
          return ok(raced);
        }

        let holdReason: AgentMessage['holdReason'] = null;
        const storm = await stormCheck(from, target, body, parts, trace);
        if (storm === 'hold') holdReason = 'pingpong';
        else if (storm) return deny(storm.code, storm.message);

        const tiers = { from: privilegeTierFor(from), to: privilegeTierFor(target) };
        if (!holdReason && tiers.from === 'guarded' && tiers.to === 'auto' && config.trustPeers !== true) holdReason = 'privilege';

        const now = deps.now();
        const message: AgentMessage = {
          id: newMessageId(),
          traceId,
          depth,
          projectId: project.id,
          kind: 'send',
          fromSessionId: from.id,
          onBehalfOf: actorId,
          to: `session:${target.id}`,
          targetSessionId: target.id,
          role: null,
          replyTo: null,
          body,
          status: holdReason ? 'held' : wake ? 'queued' : 'done',
          failure: null,
          failureDetail: null,
          replyBody: null,
          replySource: null,
          idempotencyKey: key,
          createdAt: now,
          updatedAt: now,
          deliveredAt: null,
          deadlineAt: null,
          parts,
          wake,
          replyStatus: null,
          replyParts: [],
          readAt: null,
          holdReason,
          handoffOrigin: HANDOFF_BUS_ORIGIN
        };
        try {
          await deps.messages.save(message);
        } catch {
          // SQLite 的唯一索引是跨进程的那把锁；落库失败时看看是不是别人先写进了同键。
          const winner = await deps.messages.byIdempotencyKey(from.id, key);
          if (winner) {
            if (!sameParams(winner)) return err(conflict('同一请求键对应不同参数'));
            return ok(winner);
          }
          return err(unavailable('交接消息未能保存，请稍后重试'));
        }
        await audit(message, message, 'accepted', from.id, `handoff ${message.to} depth=${depth} chars=${body.length} parts=${parts.length}${wake ? ' wake=true' : ' wake=false'}`);
        if (holdReason === 'privilege') {
          await audit(message, message, 'held', 'hub', '权限档位升级：要审批的会话（guarded）发给自动批准的会话（auto），等发起人或项目管理员放行');
        } else if (holdReason) {
          await audit(message, message, 'held', 'hub', `同一条链里和对方来回已到 ${STORM_LIMITS.pingpongMax} 次，等人放行`);
        }
        return ok(message);
      };

      // 两层串行：请求键锁保证同键回执的原子比较（即使目标不同也能发现异参），
      // 目标会话锁和普通 accept 一样，保证风暴计数与落库不会被并发的不同键交接绕过。
      const committed = await serial(`handoff:${key}`, () => serial(target.id, commit));
      if (!committed.ok) return committed;
      // 只有 wake 且没被拦下才投递；收件箱模式始终不 pump。
      if (committed.value.status === 'queued') await pump(target.id);
      const saved = (await deps.messages.byId(committed.value.id)) ?? committed.value;
      return ok({
        messageId: saved.id,
        traceId: saved.traceId,
        status: saved.status,
        targetSessionId: saved.targetSessionId,
        ...(saved.holdReason ? { holdReason: saved.holdReason } : {})
      });
    },

    async reply(fromSessionId, body, messageId, extra) {
      if (typeof body !== 'string' || body.trim() === '') return err(invalid('回复不能为空'));
      if (body.length > MAX_BODY_CHARS) return err(invalid(`回复太长（最多 ${MAX_BODY_CHARS} 字符）`));
      const delivered = (await deps.messages.deliveredTo(fromSessionId)).filter((m) => m.kind === 'ask');
      const ask = messageId ? delivered.find((m) => m.id === messageId) : delivered.length === 1 ? delivered[0] : undefined;
      if (!ask) {
        return err(messageId ? notFound('没有投给你、还在等回复的这条提问') : delivered.length === 0 ? conflict('现在没有等你回复的提问') : invalid('有多条提问在等回复，请带上 messageId'));
      }
      if (extra?.status !== undefined && !['ok', 'failed', 'refused'].includes(extra.status)) return err(invalid('status 只能是 ok / failed / refused'));
      const project = await deps.projects.byId(ask.projectId);
      const checked = validateParts(extra?.parts, project?.repos.map((r) => r.name) ?? []);
      if (!checked.ok) return err(invalid(checked.problem));
      const status: ReplyStatus = extra?.status ?? 'ok';
      const now = deps.now();
      await deps.messages.save({ ...ask, status: 'answered', replyBody: body, replySource: 'tool', replyStatus: status, replyParts: checked.parts, updatedAt: now });
      await audit(ask, ask, 'replied', fromSessionId, `agent_reply ${status}${checked.parts.length > 0 ? ` parts=${checked.parts.length}` : ''} ${summary(body)}`);
      const reply = await enqueueReply(ask, body, fromSessionId, undefined, { status, parts: checked.parts });
      return ok({ messageId: reply.id, replyTo: ask.id });
    },

    async turnEnded(sessionId, outcome) {
      const delivered = await deps.messages.deliveredTo(sessionId);
      for (const message of delivered) {
        if (message.kind === 'ask') {
          const text = outcome === 'done' ? await lastTurnText(sessionId) : '';
          if (text) {
            const now = deps.now();
            await deps.messages.save({ ...message, status: 'answered', replyBody: text, replySource: 'last_turn', replyStatus: 'ok', updatedAt: now });
            await audit(message, message, 'replied', sessionId, `最后一轮文字兜底 ${summary(text)}`);
            await enqueueReply(message, text, sessionId);
          } else {
            await fail(message, 'turn_failed', outcome === 'done' ? '对方这一轮没有给出任何文字回复' : `对方这一轮${outcome === 'failed' ? '失败了' : '被打断了'}`);
          }
        } else {
          await deps.messages.save({ ...message, status: 'done', updatedAt: deps.now() });
        }
      }
      await pump(sessionId);
    },

    async decideSpawn(messageId, actor, approve) {
      const message = await deps.messages.byId(messageId);
      if (!message || message.status !== 'awaiting_approval') return err(notFound('没有等批准的这条派生请求'));
      const project = await deps.projects.byId(message.projectId);
      if (!project || project.deletedAt !== null) return err(notFound('项目不存在'));
      if (!(await allowed(actor.user.id, 'agent.spawn', project))) return err(forbidden('你没有 agent.spawn 权限，不能批准派生新会话'));
      // 批准用的就是 actor 的 Principal（带 grants），allowed() 再按库里的授权查一遍
      const now = deps.now();
      if (!approve) {
        const denied = { ...message, status: 'denied' as const, failure: 'denied' as const, failureDetail: `${actor.user.displayName || actor.user.email} 拒绝了派生`, updatedAt: now };
        await deps.messages.save(denied);
        await audit(message, message, 'spawn_rejected', `user:${actor.user.id}`, denied.failureDetail);
        if (message.kind === 'ask') await enqueueReply(message, null, null, { code: 'denied', detail: denied.failureDetail });
        return ok(denied);
      }
      const config = await loadConfig(project.id);
      const bot = config.roles.find((r) => r.name === message.role);
      if (!bot) {
        await fail(message, 'config', `角色 ${message.role ?? ''} 已不存在`);
        return err(conflict(`角色 ${message.role ?? ''} 已不存在`));
      }
      await audit(message, message, 'spawn_approved', `user:${actor.user.id}`, botAddress(bot.name));
      const spawned = await deps.spawn({ project, role: bot, actor, title: `[${bot.name}] ${summary(message.body)}` });
      if (!spawned.ok) {
        await fail(message, 'config', spawned.error.message);
        return err(spawned.error);
      }
      await deps.messages.saveSpawn({ sessionId: spawned.value.id, projectId: project.id, role: bot.name, spawnerSessionId: message.fromSessionId, traceId: message.traceId, createdAt: now });
      await audit(message, message, 'spawned', `user:${actor.user.id}`, `→ ${spawned.value.id}`);
      const queued = { ...message, status: 'queued' as const, targetSessionId: spawned.value.id, updatedAt: deps.now() };
      await deps.messages.save(queued);
      await pump(spawned.value.id);
      return ok((await deps.messages.byId(message.id)) ?? queued);
    },

    async directory(fromSessionId, options) {
      const here = await sessionAndProject(fromSessionId);
      if (!here) return err(notFound('会话不存在'));
      const { session: from, project } = here;
      const sessions = await deps.sessions.listByProject(project.id);
      const entries: AgentDirectoryEntry[] = [];
      const reach = reachContext(project);
      if (deps.links && lineageTaskId(from, project.id)) await treeIndexFor(reach);
      const viewer = options?.viewer === undefined ? await defaultViewer(from, project) : options.viewer;
      const fromSpawn = await spawnOfCached(reach, from.id);
      for (const session of sessions) {
        if (session.id === from.id || session.status === 'failed') continue;
        if ((await isolationProblem(from, session, reach)) !== null) continue;
        const spawn = await spawnOfCached(reach, session.id);
        const explicit = await linkedCached(reach, from, session);
        const implicit = fromSpawn?.spawnerSessionId === session.id || spawn?.spawnerSessionId === from.id;
        let relation: AgentDirectoryEntry['relation'] = explicit ? 'explicit' : implicit ? 'spawn' : undefined;
        if (deps.links && !explicit && !implicit) {
          if (!(await sameTreePeer(from, session, reach, viewer))) continue;
          relation = 'task_tree';
        }
        entries.push({
          address: `session:${session.id}`,
          label: labelOf(session, spawn?.role ?? null),
          status: isBusy(session) ? 'busy' : session.status === 'running' ? 'idle' : session.status,
          ...(explicit ? { connected: true } : {}),
          ...(relation ? { relation } : {})
        });
      }
      if (!(await spawnOfCached(reach, from.id))) {
        for (const bot of (await loadConfig(project.id)).roles) {
          entries.push({ address: botAddress(bot.name), label: `${bot.name}（${bot.ref.runtime}）`, status: bot.reuse, description: bot.description });
        }
      }
      return ok(entries);
    },

    async peers(fromSessionId, options) {
      const here = await sessionAndProject(fromSessionId);
      if (!here) return err(notFound('会话不存在'));
      const { session: from, project } = here;
      const peers: AgentDirectoryEntry[] = [];
      const reach = reachContext(project);
      const fromSpawn = await spawnOfCached(reach, from.id);
      for (const session of await peerSessions(from, project, reach, options?.viewer)) {
        const spawn = await spawnOfCached(reach, session.id);
        const facts = await peerFacts(session, project);
        const explicit = await linkedCached(reach, from, session);
        const directSpawn = fromSpawn?.spawnerSessionId === session.id || spawn?.spawnerSessionId === from.id;
        const relation: AgentDirectoryEntry['relation'] = explicit ? 'explicit' : directSpawn ? 'spawn' : 'task_tree';
        peers.push({
          address: `session:${session.id}`,
          handle: await handleOf(session),
          label: labelOf(session, spawn?.role ?? null),
          status: statusLabel(session),
          ...(explicit ? { connected: true } : {}),
          relation,
          title: session.title ?? null,
          ...facts
        });
      }
      return ok(peers);
    },

    async briefing(sessionId) {
      const here = await sessionAndProject(sessionId);
      if (!here) return null;
      const { session, project } = here;
      const peers = (await peerSessions(session, project, reachContext(project))).slice(0, 20);
      const unread = (await unreadFor(session.id)).length;
      if (peers.length === 0 && unread === 0) {
        briefingMemo.delete(session.id);
        return null;
      }
      const lines: string[] = [];
      for (const peer of peers) {
        const facts = await peerFacts(peer, project);
        const bits = [
          `peer:${await handleOf(peer)}`,
          `session:${peer.id}`,
          peer.agentId + (peer.title ? `「${peer.title.slice(0, 40)}」` : ''),
          facts.workerId ? `机器 ${facts.workerId}` : null,
          facts.repo ? `仓库 ${facts.repo}` : null,
          facts.branch ? `分支 ${facts.branch}` : null,
          STATUS_TEXT[statusLabel(peer)] ?? statusLabel(peer)
        ].filter((bit): bit is string => Boolean(bit));
        lines.push(`- ${bits.join(' · ')}`);
      }
      const text = [
        peers.length > 0 ? `同伴（${peers.length}）：\n${lines.join('\n')}` : null,
        peers.length > 0
          ? '只有这些会话能和你互发消息：agent.ask / agent.send（to 可写 peer:<短名>）。ask 的答复会作为新一轮消息送到；没有别的事就结束这一轮，不要轮询。'
          : null,
        unread > 0 ? `未读通知 ${unread} 条：用 agent.inbox（unreadOnly: true）查看。` : null
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n');
      if (briefingMemo.get(session.id) === text) return null;
      briefingMemo.set(session.id, text);
      return text;
    },

    handleOf,

    async acceptExternal(command) {
      const body = command.body;
      if (typeof body !== 'string' || body.trim() === '') return err(invalid('消息不能为空'));
      if (body.length > MAX_BODY_CHARS) return err(invalid(`消息太长（最多 ${MAX_BODY_CHARS} 字符）`));
      if (command.kind !== 'send' && command.kind !== 'ask') return err(invalid('kind 只能是 send / ask'));
      if (command.wake === false && command.kind !== 'send') return err(invalid('只有 send 可以 wake=false'));
      if (command.timeoutSec !== undefined && (command.kind !== 'ask' || !Number.isInteger(command.timeoutSec) || command.timeoutSec < 30 || command.timeoutSec > MAX_ASK_TIMEOUT_SEC)) {
        return err(invalid(`timeoutSec 只用于 ask，范围 30–${MAX_ASK_TIMEOUT_SEC} 秒`));
      }
      const there = await sessionAndProject(command.targetSessionId);
      if (!there) return err(notFound('会话不存在'));
      const { session: target, project } = there;
      const checkedParts = validateParts(command.parts, project.repos.map((r) => r.name));
      if (!checkedParts.ok) return err(invalid(checkedParts.problem));
      const parts = checkedParts.parts;
      const fromId = externalAddress(command.inboxId) as SessionId;
      if (command.idempotencyKey) {
        const seen = await deps.messages.byIdempotencyKey(fromId, command.idempotencyKey);
        if (seen) return ok({ messageId: seen.id, traceId: seen.traceId, status: seen.status, targetSessionId: seen.targetSessionId });
      }
      const traceId = newTraceId();
      const base = { traceId, projectId: project.id, onBehalfOf: command.onBehalfOf };
      const deny = async (code: FailureCode, message: string): Promise<Result<never, DomainError>> => {
        await audit(null, base, 'denied', fromId, `${code}: ${command.kind} session:${target.id} — ${message}`);
        return err(code === 'rate_limited' ? conflict(`${code}: ${message}`) : code === 'archived' ? conflict(`${code}: ${message}`) : forbidden(`${code}: ${message}`));
      };
      if (target.settledAt) return deny('archived', '对方会话已收起；要先重开才能收消息');
      // 防风暴计数和落库同一把串行锁（LOW4）：外部发送也是先数后写，锁外并发会一起过线。
      // 投递（pump）在锁释放后再排，不能在锁内调——pump 会再入同一条串行队，死锁。
      const commit = async (): Promise<Result<AgentMessage, DomainError>> => {
        // 防风暴（外部这一侧）：同一对每分钟 6 条、10 分钟重复、对方收件队列 20
        const now = deps.now();
        const inbound = await deps.messages.forSession(target.id, 200);
        const sent = inbound.filter((m) => m.fromSessionId === fromId && m.targetSessionId === target.id);
        if (sent.filter((m) => m.createdAt > now - 60_000).length >= STORM_LIMITS.pairPerMinute) return deny('rate_limited', `1 分钟内已给这个会话发了 ${STORM_LIMITS.pairPerMinute} 条：合并成一条，或稍后再发`);
        const sameParts = JSON.stringify(parts);
        if (sent.some((m) => m.createdAt > now - STORM_LIMITS.duplicateWindowMs && m.status !== 'failed' && m.status !== 'denied' && m.body === body && JSON.stringify(m.parts ?? []) === sameParts)) {
          return deny('duplicate', '10 分钟内已经发过完全一样的内容');
        }
        if (inbound.filter((m) => m.targetSessionId === target.id && (m.status === 'queued' || m.status === 'held')).length >= STORM_LIMITS.inboxMax) {
          return deny('busy', `对方收件队列已满（${STORM_LIMITS.inboxMax} 条）`);
        }
        const wake = command.wake !== false;
        const message: AgentMessage = {
          id: newMessageId(),
          traceId,
          depth: 1,
          projectId: project.id,
          kind: command.kind,
          fromSessionId: fromId,
          onBehalfOf: command.onBehalfOf,
          to: `session:${target.id}`,
          targetSessionId: target.id,
          role: null,
          replyTo: null,
          body,
          status: wake ? 'queued' : 'done',
          failure: null,
          failureDetail: null,
          replyBody: null,
          replySource: null,
          idempotencyKey: command.idempotencyKey ?? null,
          createdAt: now,
          updatedAt: now,
          deliveredAt: null,
          deadlineAt: command.kind === 'ask' ? now + (command.timeoutSec !== undefined ? command.timeoutSec * 1000 : askTimeout) : null,
          parts,
          wake,
          replyStatus: null,
          replyParts: [],
          readAt: null,
          holdReason: null,
          fromLabel: command.label.slice(0, 80)
        };
        await deps.messages.save(message);
        await audit(message, message, 'accepted', fromId, `外部 ${command.kind} session:${target.id}${parts.length > 0 ? ` parts=${parts.length}` : ''}${wake ? '' : ' wake=false'} ${summary(body)}`);
        if (wake) {
          await audit(message, message, 'queued', 'hub', `→ ${target.id}`);
        }
        return ok(message);
      };
      const committed = await serial(`${fromId}:${target.id}`, commit);
      if (!committed.ok) return committed;
      if (committed.value.status === 'queued') await pump(target.id);
      const current = (await deps.messages.byId(committed.value.id)) ?? committed.value;
      return ok({ messageId: current.id, traceId: current.traceId, status: current.status, targetSessionId: current.targetSessionId });
    },

    async externalMessage(inboxId, messageId) {
      const address = externalAddress(inboxId);
      const message = await deps.messages.byId(messageId);
      if (!message || (message.fromSessionId !== address && message.to !== address)) return err(notFound('没有这条消息'));
      const reply = message.kind === 'reply' ? null : ((await deps.messages.byTrace(message.traceId)).find((m) => m.kind === 'reply' && m.replyTo === message.id) ?? null);
      return ok({ message, reply });
    },

    async externalInbox(inboxId, after, limit) {
      return deps.messages.toAddress(externalAddress(inboxId), after, Math.max(1, Math.min(limit, 100)));
    },

    async resolvePeer(fromSessionId, raw) {
      const here = await sessionAndProject(fromSessionId);
      if (!here) return err(notFound('会话不存在'));
      const address = parseAddress(typeof raw === 'string' ? raw.trim() : '');
      if (!address || (address.kind !== 'session' && address.kind !== 'peer')) return err(invalid('session 要写成 session:<id> 或 peer:<短名>'));
      if (address.kind === 'session' && address.sessionId === here.session.id) return ok(here.session.id);
      const target = address.kind === 'peer' ? await resolveHandleLegacy(here.session, address.handle) : (await sessionAndProject(address.sessionId))?.session ?? null;
      if (!target) {
        const known = await Promise.all((await legacyPeerSessions(here.session)).map(async (peer) => `peer:${await handleOf(peer)}`));
        return err(notFound(`unresolvable: 找不到这个同伴${known.length > 0 ? `；可用：${known.join('、')}` : ''}`));
      }
      if (target.id === here.session.id) return ok(target.id);
      const there = await sessionAndProject(target.id);
      if (there?.project.id !== here.project.id) return err(notFound('unresolvable: 同一个项目里没有这条会话'));
      if (!(await legacyReach(here.session, target))) return err(forbidden('denied: 只有明确连接的会话（或派生父子）才能看对方的工作空间'));
      if (target.settledAt) return err(conflict('archived: 对方会话已收起，工作空间可能已清理'));
      return ok(target.id);
    },

    async setHandle(sessionId, handle, actor) {
      const value = handle.trim();
      if (!isHandle(value)) return err(invalid('短名只能用小写字母开头，含 a-z 0-9 -，2–32 个字符'));
      const here = await sessionAndProject(sessionId);
      if (!here) return err(notFound('会话不存在'));
      if (!here.session.taskId) return err(invalid('没有任务的会话不能设短名，用 session:<id> 联系'));
      const saved = await deps.messages.setHandle({ sessionId, taskId: here.session.taskId, handle: value, updatedAt: deps.now() });
      if (!saved) return err(conflict(`任务里已经有会话叫 ${value}`));
      await audit(null, { traceId: `handle:${sessionId}`, projectId: here.project.id, onBehalfOf: actor }, 'handle_set', actor, `${sessionId} → peer:${value}`);
      return ok({ handle: value });
    },

    async decideHeld(messageId, actor, approve) {
      const message = await deps.messages.byId(messageId);
      if (!message || message.status !== 'held') return err(notFound('没有被拦下的这条消息'));
      const project = await deps.projects.byId(message.projectId);
      if (!project || project.deletedAt !== null) return err(notFound('项目不存在'));
      if (message.holdReason === 'privilege') {
        // 权限档位升级：只有发起人（链头那个人）或能改项目的人（owner / admin）能批。
        if (actor.user.id !== message.onBehalfOf && !(await allowed(actor.user.id, 'project.update', project))) return err(forbidden('只有发起人或项目管理员能放行权限升级的消息'));
      } else if (!(await allowed(actor.user.id, message.kind === 'ask' ? 'agent.ask' : 'agent.message.send', project))) return err(forbidden('你没有放行这条消息的权限'));
      const now = deps.now();
      const who = `user:${actor.user.id}`;
      if (!approve) {
        const denied = { ...message, status: 'denied' as const, failure: 'denied' as const, failureDetail: `${actor.user.displayName || actor.user.email} 没有放行`, updatedAt: now };
        await deps.messages.save(denied);
        await audit(message, message, 'rejected', who, denied.failureDetail);
        if (message.kind === 'ask') await enqueueReply(message, null, null, { code: 'denied', detail: denied.failureDetail });
        return ok(denied);
      }
      const released = { ...message, status: message.wake === false ? ('done' as const) : ('queued' as const), updatedAt: now };
      await deps.messages.save(released);
      await audit(message, message, 'released', who, message.holdReason ?? '');
      if (message.targetSessionId && released.status === 'queued') await pump(message.targetSessionId);
      return ok((await deps.messages.byId(message.id)) ?? released);
    },

    async status(fromSessionId, messageId) {
      const message = await deps.messages.byId(messageId);
      if (!message || (message.fromSessionId !== fromSessionId && message.targetSessionId !== fromSessionId)) return err(notFound('没有这条消息'));
      return ok(message);
    },

    async inbox(sessionId, limit, options) {
      const list = options?.unreadOnly ? (await unreadFor(sessionId)).slice(0, limit) : await deps.messages.forSession(sessionId, limit);
      if (options?.markRead) {
        const now = deps.now();
        for (const message of list) {
          if (message.targetSessionId === sessionId && message.wake === false && !message.readAt) await deps.messages.save({ ...message, readAt: now, updatedAt: now });
        }
      }
      return list;
    },

    async sweep() {
      const overdue = await deps.messages.overdue(deps.now());
      for (const message of overdue) {
        await fail(message, 'timeout', '对方在截止时间前没有回复');
        if (message.targetSessionId) void pump(message.targetSessionId);
      }
      let archived = 0;
      for (const targetId of await deps.messages.pendingTargets()) {
        const target = await deps.sessions.byId(targetId);
        if (target?.settledAt) {
          await drainArchived(target);
          archived++;
        }
      }
      return overdue.length + archived;
    },

    config: loadConfig,

    async saveConfig(projectId, input, actor) {
      // 整表保存也走单条保存的净化：ref 先补成合法形状交给 configProblem 报好懂的错，
      // 再用 validateAgentRef 返回的规范值落库（trim 过的 runtime/model + 过滤后的 options）。
      // 不这么做，`{name:'x'}` 这种没有 ref 的空壳会直接 TypeError，ref 里的空白 / 脏值也会原样进库。
      const drafted: PersistentAgentDefinition[] = input.roles.map((role) => {
        const raw = role as Partial<PersistentAgentDefinition>;
        const ref = raw.ref;
        return {
          ...role,
          name: (raw.name ?? '').trim(),
          ref: { runtime: ref?.runtime ?? '', model: ref?.model ?? '', options: ref?.options ?? {} }
        };
      });
      const problem = configProblem({ roles: drafted, limits: input.limits });
      if (problem) return err(invalid(problem));
      const normalized: PersistentAgentDefinition[] = [];
      for (const draft of drafted) {
        const checked = validateAgentRef(draft.ref);
        if (!checked.ok) return err(invalid(`bot ${draft.name} 的${checked.error.message}`));
        normalized.push({ ...draft, ref: checked.value });
      }
      const now = deps.now();
      const existing = await deps.bots.listForProject(projectId);
      const teamId = (await deps.projects.byId(projectId))?.teamId ?? 'team_legacy';
      const byName = new Map(existing.map((bot) => [bot.name, bot]));
      const roles: PersistentAgent[] = [];
      for (const draft of normalized) {
        const name = draft.name;
        let current = byName.get(name);
        if (current === undefined) {
          // bot 的名字在团队内唯一：别的项目已经建过同名 bot 时，只能复用它，
          // 不能悄悄改掉它的运行时/模型（会连带影响那个项目）。
          const shared = (await deps.bots.byName(teamId, name)) ?? undefined;
          if (shared !== undefined) {
            const same =
              shared.ref.runtime === draft.ref.runtime &&
              shared.ref.model === draft.ref.model &&
              (shared.ref.options === undefined || JSON.stringify(shared.ref.options) === JSON.stringify(draft.ref.options));
            if (!same) {
              return err(
                invalid(`团队里已经有同名 bot「${name}」，它的运行时或模型和这里不一样；先在 Bot 页面统一配置，或者换个名字`)
              );
            }
            current = shared;
          }
        }
        const bot: PersistentAgent = {
          ...draft,
          name,
          ref: draft.ref,
          id: current?.id ?? botIdFrom(`${projectId}\0${name}`),
          teamId,
          createdAt: current?.createdAt ?? now,
          updatedAt: now
        };
        await deps.bots.save(bot);
        // 整表保存是项目视角的：出现在这份配置里就等于「授权到本项目」。
        const grants = await deps.bots.grantsOf(bot.id);
        if (!grants.some((grant) => grant.projectId === projectId)) {
          await deps.bots.grant({ botId: bot.id, projectId, workspaceId: null, createdAt: now, createdBy: null });
        }
        roles.push(bot);
      }
      // 整表 PUT：payload 里没有的 bot 删掉（群里/会话里的引用不在这里清）。
      const keep = new Set(roles.map((bot) => bot.name));
      for (const bot of existing) if (!keep.has(bot.name)) await deps.bots.remove(bot.id);
      // limits 仍写旧的配置行；roles 列保持不动（遗留列，C3b 迁移后再也不读）。
      const legacy = await deps.messages.config(projectId);
      const trustPeers = input.trustPeers ?? legacy?.trustPeers === true;
      const config: MessagingConfig = { projectId, roles, limits: input.limits, trustPeers, updatedAt: now };
      await deps.messages.saveConfig({ ...config, roles: legacy?.roles ?? [] });
      if (trustPeers !== (legacy?.trustPeers === true)) {
        const who = actor ?? 'hub';
        await audit(null, { traceId: `config:${projectId}`, projectId, onBehalfOf: who }, 'config', who, trustPeers ? 'trustPeers 打开：guarded → auto 的消息不再拦下' : 'trustPeers 关闭：guarded → auto 的消息先拦下');
      }
      return ok(config);
    }
  };
  return bus;
}
