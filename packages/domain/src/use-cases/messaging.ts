import { decide, type Permission } from '../access.ts';
import type { Principal } from '../account.ts';
import { conflict, forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { newId, type ProjectId, type SessionId } from '../ids.ts';
import { createSessionLane, type SessionLane } from '../session-lane.ts';
import {
  DEFAULT_ASK_TIMEOUT_MS,
  MAX_BODY_CHARS,
  configProblem,
  effectiveLimits,
  emptyConfig,
  isActive,
  newMessageId,
  newTraceId,
  parseAddress,
  wrapUntrusted,
  type AgentMessage,
  type AgentRole,
  type FailureCode,
  type MessageAuditAction,
  type MessageKind,
  type MessageLimits,
  type MessagingConfig
} from '../messaging.ts';
import type { MessageStore } from '../ports/message-store.ts';
import type { Project } from '../project.ts';
import { err, ok, type Result } from '../result.ts';
import { isBusy, type Session } from '../session.ts';
import { projectAsResource, type AccessPolicy } from './authorization.ts';
import type { Deps } from './deps.ts';

/**
 * 消息总线（ADR 0018 · P2P 内核）：
 * 接收（权限 ∩、限额、幂等、审计）→ 解析地址 → 对方空闲就投、忙就排队 → 回合结束时收回复（agent_reply 优先，最后一轮文字兜底）并投下一条。
 * 派生新会话要 agent.spawn，且要人批。
 */
export interface MessageBusDeps extends Pick<Deps, 'now' | 'sessions' | 'projects' | 'tasks'> {
  readonly messages: MessageStore;
  readonly policy?: AccessPolicy;
  /** userId → 带上自定义角色和显式授权的 Principal；停用 / 不存在是 null。 */
  readonly principalOf: (userId: string) => Promise<Principal | null>;
  /** 把一段话作为一轮提问送进会话（组合根接到 promptSessionUseCase）。 */
  readonly deliver: (sessionId: SessionId, text: string, author: { id: string; name: string; via: string }) => Promise<Result<unknown, DomainError>>;
  /** 按角色开一条新会话（组合根：建任务 + 派生会话）。actor 是批准的人。 */
  readonly spawn: (input: { project: Project; role: AgentRole; actor: Principal; title: string }) => Promise<Result<Session, DomainError>>;
  readonly askTimeoutMs?: number;
  /** 同一条会话的投递闸（组合根里两边共用一个）；occupied = 别的通道在这条会话上还有没收尾的投递。 */
  readonly lane?: SessionLane;
  readonly occupied?: (sessionId: SessionId) => Promise<boolean>;
}

export interface SendCommand {
  readonly fromSessionId: SessionId;
  readonly kind: Exclude<MessageKind, 'reply'>;
  readonly to: string;
  readonly body: string;
  readonly idempotencyKey?: string;
  /** 人在界面里替这条会话发起（链头）：代的就是这个人，不是会话主人。agent 经工具发的不填。 */
  readonly onBehalfOf?: string;
}

export interface Accepted {
  readonly messageId: string;
  readonly traceId: string;
  readonly status: AgentMessage['status'];
  readonly targetSessionId: SessionId | null;
}

export interface AgentDirectoryEntry {
  readonly address: string;
  readonly label: string;
  readonly status: string;
  readonly description?: string;
}

export interface MessageBus {
  accept(command: SendCommand): Promise<Result<Accepted, DomainError>>;
  /** agent_reply：回答投给自己的 ask。messageId 不给 = 当前唯一在处理的那条 ask。 */
  reply(fromSessionId: SessionId, body: string, messageId?: string): Promise<Result<{ messageId: string; replyTo: string }, DomainError>>;
  /** 会话一轮结束（journal 里出现 ended）。 */
  turnEnded(sessionId: SessionId, outcome: 'done' | 'stopped' | 'interrupted' | 'failed'): Promise<void>;
  /** 人批 / 拒一条派生请求。 */
  decideSpawn(messageId: string, actor: Principal, approve: boolean): Promise<Result<AgentMessage, DomainError>>;
  directory(fromSessionId: SessionId): Promise<Result<AgentDirectoryEntry[], DomainError>>;
  status(fromSessionId: SessionId, messageId: string): Promise<Result<AgentMessage, DomainError>>;
  inbox(sessionId: SessionId, limit: number): Promise<AgentMessage[]>;
  /** 超时扫一遍（组合根定时调）。 */
  sweep(): Promise<number>;
  config(projectId: ProjectId): Promise<MessagingConfig>;
  saveConfig(projectId: ProjectId, input: { roles: readonly AgentRole[]; limits: Partial<MessageLimits> }): Promise<Result<MessagingConfig, DomainError>>;
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
    const task = await deps.tasks.byId(session.taskId);
    if (!task) return null;
    const project = await deps.projects.byId(task.projectId);
    if (!project || project.deletedAt !== null) return null;
    return { session, project };
  };

  const loadConfig = async (projectId: ProjectId): Promise<MessagingConfig> => (await deps.messages.config(projectId)) ?? emptyConfig(projectId);

  const labelOf = (session: Session, role: string | null): string => `${role ?? session.agentId}（会话 #${session.id.slice(0, 6)}）`;

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
      if (isBusy(target)) return;
      if ((await deps.messages.deliveredTo(targetId)).length > 0) return;
      if (await deps.occupied?.(targetId)) return;
      const next = (await deps.messages.queuedFor(targetId))[0];
      if (!next) return;
      const from = await deps.sessions.byId(next.fromSessionId);
      const text = wrapUntrusted({
        message: next,
        fromLabel: from ? labelOf(from, (await deps.messages.spawnOf(from.id))?.role ?? null) : next.fromSessionId,
        fromSessionId: next.fromSessionId,
        onBehalfOfName: await nameOf(next.onBehalfOf)
      });
      const author = {
        id: `agent:${next.fromSessionId}`,
        name: `${from ? labelOf(from, (await deps.messages.spawnOf(from.id))?.role ?? null) : next.fromSessionId} 代 ${await nameOf(next.onBehalfOf)}`,
        via: 'agent'
      };
      const now = deps.now();
      const delivering: AgentMessage = { ...next, status: 'delivered', deliveredAt: now, updatedAt: now };
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
  const enqueueReply = async (ask: AgentMessage, body: string | null, fromSessionId: SessionId | null, failure?: { code: FailureCode; detail: string }): Promise<AgentMessage> => {
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
      deadlineAt: null
    };
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

  const bus: MessageBus = {
    async accept(command) {
      const body = command.body;
      if (typeof body !== 'string' || body.trim() === '') return err(invalid('消息不能为空'));
      if (body.length > MAX_BODY_CHARS) return err(invalid(`消息太长（最多 ${MAX_BODY_CHARS} 字符）`));
      const address = parseAddress(command.to);
      if (!address) return err(invalid('地址要写成 session:<id> 或 role:<name>'));
      const here = await sessionAndProject(command.fromSessionId);
      if (!here) return err(notFound('发送方会话不存在'));
      const { session: from, project } = here;

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
      let role: AgentRole | null = null;
      if (address.kind === 'session') {
        const there = await sessionAndProject(address.sessionId);
        target = there?.session ?? null;
        if (!target || there?.project.id !== project.id) return deny('unresolvable', '同一个项目里没有这条会话');
        if (target.id === from.id) return err(invalid('不能给自己发消息'));
      } else {
        role = config.roles.find((r) => r.name === address.role) ?? null;
        if (!role) return deny('unresolvable', `项目里没有定义角色 ${address.role}`);
        if (role.reuse !== 'always-new') {
          const spawns = (await deps.messages.spawnsForRole(project.id, role.name)).filter((s) => role!.reuse === 'sticky' || s.traceId === traceId);
          for (const spawn of spawns.sort((a, b) => b.createdAt - a.createdAt)) {
            const candidate = await deps.sessions.byId(spawn.sessionId);
            if (candidate && candidate.status !== 'failed' && (await isolationProblem(from, candidate)) === null) {
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
      } else if (!(await allowed(onBehalfOf, 'agent.spawn', project)) || !(await allowed(caller, 'agent.spawn', project))) {
        return deny('denied', `没有现成的 ${address.kind === 'role' ? address.role : ''} 会话，派生新会话要 agent.spawn 权限`);
      }

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
        role: role?.name ?? null,
        replyTo: null,
        body,
        status: target ? 'queued' : 'awaiting_approval',
        failure: null,
        failureDetail: null,
        replyBody: null,
        replySource: null,
        idempotencyKey: command.idempotencyKey ?? null,
        createdAt: now,
        updatedAt: now,
        deliveredAt: null,
        deadlineAt: command.kind === 'ask' ? now + askTimeout : null
      };
      await deps.messages.save(message);
      await audit(message, message, 'accepted', from.id, `${command.kind} ${message.to} depth=${depth} ${summary(body)}`);
      if (target) {
        await pump(target.id);
      } else {
        await audit(message, message, 'spawn_requested', from.id, `role:${role?.name}（${role?.agentId}）等人批准`);
      }
      const saved = (await deps.messages.byId(message.id)) ?? message;
      return ok({ messageId: saved.id, traceId, status: saved.status, targetSessionId: saved.targetSessionId });
    },

    async reply(fromSessionId, body, messageId) {
      if (typeof body !== 'string' || body.trim() === '') return err(invalid('回复不能为空'));
      if (body.length > MAX_BODY_CHARS) return err(invalid(`回复太长（最多 ${MAX_BODY_CHARS} 字符）`));
      const delivered = (await deps.messages.deliveredTo(fromSessionId)).filter((m) => m.kind === 'ask');
      const ask = messageId ? delivered.find((m) => m.id === messageId) : delivered.length === 1 ? delivered[0] : undefined;
      if (!ask) {
        return err(messageId ? notFound('没有投给你、还在等回复的这条提问') : delivered.length === 0 ? conflict('现在没有等你回复的提问') : invalid('有多条提问在等回复，请带上 messageId'));
      }
      const now = deps.now();
      await deps.messages.save({ ...ask, status: 'answered', replyBody: body, replySource: 'tool', updatedAt: now });
      await audit(ask, ask, 'replied', fromSessionId, `agent_reply ${summary(body)}`);
      const reply = await enqueueReply(ask, body, fromSessionId);
      return ok({ messageId: reply.id, replyTo: ask.id });
    },

    async turnEnded(sessionId, outcome) {
      const delivered = await deps.messages.deliveredTo(sessionId);
      for (const message of delivered) {
        if (message.kind === 'ask') {
          const text = outcome === 'done' ? await lastTurnText(sessionId) : '';
          if (text) {
            const now = deps.now();
            await deps.messages.save({ ...message, status: 'answered', replyBody: text, replySource: 'last_turn', updatedAt: now });
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
      const role = config.roles.find((r) => r.name === message.role);
      if (!role) {
        await fail(message, 'config', `角色 ${message.role ?? ''} 已不存在`);
        return err(conflict(`角色 ${message.role ?? ''} 已不存在`));
      }
      await audit(message, message, 'spawn_approved', `user:${actor.user.id}`, `role:${role.name}`);
      const spawned = await deps.spawn({ project, role, actor, title: `[${role.name}] ${summary(message.body)}` });
      if (!spawned.ok) {
        await fail(message, 'config', spawned.error.message);
        return err(spawned.error);
      }
      await deps.messages.saveSpawn({ sessionId: spawned.value.id, projectId: project.id, role: role.name, spawnerSessionId: message.fromSessionId, traceId: message.traceId, createdAt: now });
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
      for (const session of sessions) {
        if (session.id === from.id || session.status === 'failed') continue;
        if ((await isolationProblem(from, session)) !== null) continue;
        const spawn = await deps.messages.spawnOf(session.id);
        entries.push({ address: `session:${session.id}`, label: labelOf(session, spawn?.role ?? null), status: isBusy(session) ? 'busy' : session.status === 'running' ? 'idle' : session.status });
      }
      if (!(await deps.messages.spawnOf(from.id))) {
        for (const role of (await loadConfig(project.id)).roles) {
          entries.push({ address: `role:${role.name}`, label: `${role.name}（${role.agentId}）`, status: role.reuse, description: role.description });
        }
      }
      return ok(entries);
    },

    async status(fromSessionId, messageId) {
      const message = await deps.messages.byId(messageId);
      if (!message || (message.fromSessionId !== fromSessionId && message.targetSessionId !== fromSessionId)) return err(notFound('没有这条消息'));
      return ok(message);
    },

    inbox: (sessionId, limit) => deps.messages.forSession(sessionId, limit),

    async sweep() {
      const overdue = await deps.messages.overdue(deps.now());
      for (const message of overdue) {
        await fail(message, 'timeout', '对方在截止时间前没有回复');
        if (message.targetSessionId) void pump(message.targetSessionId);
      }
      return overdue.length;
    },

    config: loadConfig,

    async saveConfig(projectId, input) {
      const problem = configProblem(input);
      if (problem) return err(invalid(problem));
      const config: MessagingConfig = { projectId, roles: input.roles.map((r) => ({ ...r, name: r.name.trim(), agentId: r.agentId.trim() })), limits: input.limits, updatedAt: deps.now() };
      await deps.messages.saveConfig(config);
      return ok(config);
    }
  };
  return bus;
}
