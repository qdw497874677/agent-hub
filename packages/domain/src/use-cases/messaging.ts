import { decide, type Permission } from '../access.ts';
import { validateAgentRef } from '../agent-ref.ts';
import { botIdFrom, type PersistentAgent, type PersistentAgentDefinition } from '../bot.ts';
import type { Principal } from '../account.ts';
import { conflict, forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { newId, type ProjectId, type SessionId } from '../ids.ts';
import { createSessionLane, type SessionLane } from '../session-lane.ts';
import {
  DEFAULT_ASK_TIMEOUT_MS,
  MAX_ASK_TIMEOUT_SEC,
  MAX_BODY_CHARS,
  STORM_LIMITS,
  defaultHandle,
  isHandle,
  externalAddress,
  isExternalSender,
  privilegeTier,
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
  type MessagingConfig
} from '../messaging.ts';
import type { MessageStore } from '../ports/message-store.ts';
import type { SessionLinkRepository } from '../ports/session-link-repository.ts';
import type { Project } from '../project.ts';
import { err, ok, type Result } from '../result.ts';
import { isBusy, type Session } from '../session.ts';
import { otherEnd } from '../session-link.ts';
import { projectAsResource, type AccessPolicy } from './authorization.ts';
import type { Deps } from './deps.ts';
import { loadBotConfig } from './bots.ts';
import { projectOfSession } from './workspaces.ts';

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
  /** 会话通信 P1a：同伴的短名、落点和仓库。 */
  readonly handle?: string;
  readonly workerId?: string | null;
  readonly repo?: string | null;
  readonly branch?: string | null;
  readonly title?: string | null;
  /** 发给我、还没读的通知（wake=false）。 */
  readonly unread?: number;
}

export interface MessageBus {
  accept(command: SendCommand): Promise<Result<Accepted, DomainError>>;
  /** agent_reply：回答投给自己的 ask。messageId 不给 = 当前唯一在处理的那条 ask。 */
  reply(fromSessionId: SessionId, body: string, messageId?: string, extra?: ReplyExtra): Promise<Result<{ messageId: string; replyTo: string }, DomainError>>;
  /** 会话一轮结束（journal 里出现 ended）。 */
  turnEnded(sessionId: SessionId, outcome: 'done' | 'stopped' | 'interrupted' | 'failed'): Promise<void>;
  /** 人批 / 拒一条派生请求。 */
  decideSpawn(messageId: string, actor: Principal, approve: boolean): Promise<Result<AgentMessage, DomainError>>;
  directory(fromSessionId: SessionId): Promise<Result<AgentDirectoryEntry[], DomainError>>;
  /** 只列显式连接的会话（不包含角色，也不含仅派生关系）。 */
  peers(fromSessionId: SessionId): Promise<Result<AgentDirectoryEntry[], DomainError>>;
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

  const sessionAndProject = async (sessionId: SessionId): Promise<{ session: Session; project: Project } | null> => {
    const session = await deps.sessions.byId(sessionId);
    if (!session) return null;
    // 容器会话没有任务：按 bot 归属找回项目（#221 步骤 7）。
    const project = await projectOfSession(deps, session);
    if (!project || project.deletedAt !== null) return null;
    return { session, project };
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
      await deps.messages.save(delivering);
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

  /** 隔离：消息派生出来的任务会话只能和派生它的会话来往。 */
  const isolationProblem = async (from: Session, target: Session): Promise<string | null> => {
    const [fromSpawn, targetSpawn] = await Promise.all([deps.messages.spawnOf(from.id), deps.messages.spawnOf(target.id)]);
    if (fromSpawn && fromSpawn.spawnerSessionId !== target.id) return '派生出来的任务会话默认隔离：只能回给派生它的会话';
    if (targetSpawn && targetSpawn.spawnerSessionId !== from.id) return '那是别的会话派生的任务会话（默认隔离），不能直接找它';
    return null;
  };

  /** 显式连线或同一条派生链（父 ↔ 子）都允许；没配 links 时保持旧行为。 */
  const canReach = async (from: Session, target: Session): Promise<boolean> => {
    if (!deps.links) return true;
    const [fromSpawn, targetSpawn] = await Promise.all([deps.messages.spawnOf(from.id), deps.messages.spawnOf(target.id)]);
    if (fromSpawn?.spawnerSessionId === target.id || targetSpawn?.spawnerSessionId === from.id) return true;
    return deps.links.areLinked(from.id, target.id);
  };

  const linkProblem = async (from: Session, target: Session): Promise<string | null> =>
    (await canReach(from, target)) ? null : '只有明确连接的会话才能互相发消息';

  const handleOf = async (session: Session): Promise<string> => (await deps.messages.handleOf(session.id)) ?? defaultHandle(session);

  /** 能直接说话的同伴：显式连线 + 派生父会话（派生子会话通过 spawn 记录反查不到全部，靠连线或子会话自己联系）。 */
  const peerSessions = async (from: Session): Promise<Session[]> => {
    const ids = new Set<string>();
    if (deps.links) for (const link of await deps.links.forSession(from.id)) {
      const other = otherEnd(link, from.id);
      if (other) ids.add(other);
    }
    const spawn = await deps.messages.spawnOf(from.id);
    if (spawn) ids.add(spawn.spawnerSessionId);
    const out: Session[] = [];
    for (const id of ids) {
      const session = await deps.sessions.byId(id as SessionId);
      if (session && session.status !== 'failed') out.push(session);
    }
    return out;
  };

  /** peer:<handle> → 会话：先找任务内设过的短名，再在同伴里按（设过的或默认）短名匹配。 */
  const resolveHandle = async (from: Session, handle: string): Promise<Session | null> => {
    if (from.taskId) {
      const id = await deps.messages.sessionByHandle(from.taskId, handle);
      if (id) {
        const found = await deps.sessions.byId(id);
        if (found) return found;
      }
    }
    for (const peer of await peerSessions(from)) if ((await handleOf(peer)) === handle) return peer;
    return null;
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
      const base = { traceId, projectId: project.id, onBehalfOf };
      const deny = async (code: FailureCode, message: string): Promise<Result<Accepted, DomainError>> => {
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
          const found = await resolveHandle(from, address.handle);
          if (!found) {
            const known = await Promise.all((await peerSessions(from)).map(async (peer) => `peer:${await handleOf(peer)}`));
            return deny('unresolvable', `没有叫 ${address.handle} 的同伴${known.length > 0 ? `；可用：${known.join('、')}` : '；还没有连线的同伴'}`);
          }
          target = found;
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
            if (candidate && candidate.status !== 'failed' && !candidate.settledAt && (await isolationProblem(from, candidate)) === null && (await canReach(from, candidate))) {
              target = candidate;
              break;
            }
          }
        }
      }
      if (target) {
        const callee = ownerOf(target, project);
        if (!(await allowed(callee, permission, project))) return deny('denied', `被调会话的主人没有 ${permission}`);
        const isolated = await isolationProblem(from, target);
        if (isolated) return deny('denied', isolated);
        const unlinked = await linkProblem(from, target);
        if (unlinked) return deny('denied', unlinked);
        if (target.settledAt) return deny('archived', '对方会话已收起；要先重开才能收消息');
      } else if (!(await allowed(onBehalfOf, 'agent.spawn', project)) || !(await allowed(caller, 'agent.spawn', project))) {
        return deny('denied', `没有现成的 ${addressName(address)} 会话，派生新会话要 agent.spawn 权限`);
      }

      let holdReason: AgentMessage['holdReason'] = null;
      if (target) {
        const storm = await stormCheck(from, target, body, parts, trace);
        if (storm === 'hold') holdReason = 'pingpong';
        else if (storm) return deny(storm.code, storm.message);
      }
      // P1f 权限档位：guarded → auto 先拦下（不能借自动批准的会话做自己要审批的事）；项目 trustPeers 可关。
      const tiers = target ? { from: privilegeTier(from.options), to: privilegeTier(target.options) } : null;
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
      } else if (target) {
        if (wake) await pump(target.id);
      } else {
        await audit(message, message, 'spawn_requested', from.id, `${bot ? botAddress(bot.name) : 'bot'}（${bot?.ref.runtime}）等人批准`);
      }
      const saved = (await deps.messages.byId(message.id)) ?? message;
      return ok({ messageId: saved.id, traceId, status: saved.status, targetSessionId: saved.targetSessionId, ...(saved.holdReason ? { holdReason: saved.holdReason } : {}) });
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

    async directory(fromSessionId) {
      const here = await sessionAndProject(fromSessionId);
      if (!here) return err(notFound('会话不存在'));
      const { session: from, project } = here;
      const sessions = await deps.sessions.listByProject(project.id);
      const entries: AgentDirectoryEntry[] = [];
      const fromSpawn = await deps.messages.spawnOf(from.id);
      for (const session of sessions) {
        if (session.id === from.id || session.status === 'failed') continue;
        if ((await isolationProblem(from, session)) !== null) continue;
        const spawn = await deps.messages.spawnOf(session.id);
        const explicit = deps.links ? await deps.links.areLinked(from.id, session.id) : false;
        const implicit = fromSpawn?.spawnerSessionId === session.id || spawn?.spawnerSessionId === from.id;
        if (deps.links && !explicit && !implicit) continue;
        entries.push({
          address: `session:${session.id}`,
          label: labelOf(session, spawn?.role ?? null),
          status: isBusy(session) ? 'busy' : session.status === 'running' ? 'idle' : session.status,
          ...(explicit ? { connected: true } : {})
        });
      }
      if (!(await deps.messages.spawnOf(from.id))) {
        for (const bot of (await loadConfig(project.id)).roles) {
          entries.push({ address: botAddress(bot.name), label: `${bot.name}（${bot.ref.runtime}）`, status: bot.reuse, description: bot.description });
        }
      }
      return ok(entries);
    },

    async peers(fromSessionId) {
      const here = await sessionAndProject(fromSessionId);
      if (!here) return err(notFound('会话不存在'));
      const { session: from, project } = here;
      const peers: AgentDirectoryEntry[] = [];
      for (const session of await peerSessions(from)) {
        const spawn = await deps.messages.spawnOf(session.id);
        const facts = await peerFacts(session, project);
        const explicit = deps.links ? await deps.links.areLinked(from.id, session.id) : false;
        peers.push({
          address: `session:${session.id}`,
          handle: await handleOf(session),
          label: labelOf(session, spawn?.role ?? null),
          status: statusLabel(session),
          ...(explicit ? { connected: true } : {}),
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
      const peers = (await peerSessions(session)).slice(0, 20);
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
      const deny = async (code: FailureCode, message: string): Promise<Result<Accepted, DomainError>> => {
        await audit(null, base, 'denied', fromId, `${code}: ${command.kind} session:${target.id} — ${message}`);
        return err(code === 'rate_limited' ? conflict(`${code}: ${message}`) : code === 'archived' ? conflict(`${code}: ${message}`) : forbidden(`${code}: ${message}`));
      };
      if (target.settledAt) return deny('archived', '对方会话已收起；要先重开才能收消息');
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
        await pump(target.id);
      }
      const current = (await deps.messages.byId(message.id)) ?? message;
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
      const target = address.kind === 'peer' ? await resolveHandle(here.session, address.handle) : (await sessionAndProject(address.sessionId))?.session ?? null;
      if (!target) {
        const known = await Promise.all((await peerSessions(here.session)).map(async (peer) => `peer:${await handleOf(peer)}`));
        return err(notFound(`unresolvable: 找不到这个同伴${known.length > 0 ? `；可用：${known.join('、')}` : ''}`));
      }
      if (target.id === here.session.id) return ok(target.id);
      const there = await sessionAndProject(target.id);
      if (there?.project.id !== here.project.id) return err(notFound('unresolvable: 同一个项目里没有这条会话'));
      if (!(await canReach(here.session, target))) return err(forbidden('denied: 只有明确连接的会话（或派生父子）才能看对方的工作空间'));
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
