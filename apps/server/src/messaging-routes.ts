import type { Hono } from 'hono';
import { z } from 'zod';
import {
  AGENT_REF_MODEL_MAX,
  AGENT_REF_OPTION_KEY,
  AGENT_REF_OPTIONS_MAX,
  AGENT_REF_OPTION_VALUE_MAX,
  asProjectId,
  asSessionId,
  asUserId,
  authorizeProject,
  authorizeSession,
  isExternalSender,
  messageSenderKind,
  messageView,
  principalOfSubject,
  projectOfSessionOrigin,
  type AgentMessage,
  type Deps,
  type MessageBus,
  type MessagePart,
  type MessageStore,
  type BotDefinition,
  type SessionId,
  type Subject,
  type UserRepository
} from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { messagingConfigDto } from './agent-ref-dto.ts';
import { fail } from './http-error.ts';
import { NO_STORE } from './http-helpers.ts';

/**
 * agent 间通信的 HTTP 外壳（ADR 0018 · P2P）：
 * - GET  /api/sessions/:id/messages        进出这条会话的消息 + 它发起、等人批的派生请求
 * - POST /api/sessions/:id/messages        人替这条会话发一条（链头，代的是这个人）
 * - GET/PUT /api/projects/:id/messaging    项目的角色表和限额（最多默认值 2 倍）
 * - POST /api/messages/:id/decision        批 / 拒派生新会话（要 agent.spawn）；或放行 / 拒绝被拦下的消息
 * - GET  /api/sessions/:id/peers           同伴（短名、机器、仓库、分支、状态）
 * - PUT  /api/sessions/:id/handle          设任务内短名（peer:<handle>）
 * - GET  /api/messages/:id/trace           一条协作链的消息和审计
 * 路径里带 sessions / projects 的读写权限由 installAccess 先查过。
 */
const sendBody = z.object({
  kind: z.enum(['send', 'ask']),
  to: z.string().min(3).max(200),
  body: z.string().min(1).max(32768),
  idempotencyKey: z.string().max(100).optional(),
  parts: z.array(z.record(z.string(), z.unknown())).max(8).optional(),
  wake: z.boolean().optional(),
  timeoutSec: z.number().int().optional()
});
const handleBody = z.object({ handle: z.string().min(2).max(32) });
// 与 domain 的 configProblem 用同一套规则；前端逐条提示也照这份，别在三处各写一遍。
const optionsBody = z
  .record(
    z.string().regex(AGENT_REF_OPTION_KEY, '选项键要小写字母开头，只含 a-z 0-9 _ . -'),
    z.union([z.string().max(AGENT_REF_OPTION_VALUE_MAX), z.boolean()])
  )
  .refine((value) => Object.keys(value).length <= AGENT_REF_OPTIONS_MAX, `启动选项最多 ${AGENT_REF_OPTIONS_MAX} 个`);

const roleBody = z.object({
  name: z.string().max(40),
  description: z.string().max(500).default(''),
  agentId: z.string().min(1).max(80),
  model: z.string().max(AGENT_REF_MODEL_MAX).default(''),
  reuse: z.enum(['sticky', 'per-trace', 'always-new']).default('sticky'),
  options: optionsBody.optional()
});
/** body 仍是扁平字段；进 domain 前归一成 ref。 */
const toRole = (role: z.infer<typeof roleBody>): BotDefinition => ({
  name: role.name,
  description: role.description,
  reuse: role.reuse,
  ref: { runtime: role.agentId, model: role.model, options: role.options ?? {} }
});
const configBody = z.object({
  /** 不给 = 只改别的开关（如 trustPeers），角色表和限额保持原样。 */
  roles: z.array(roleBody).max(50).optional(),
  limits: z.object({ maxDepth: z.number().int(), maxConcurrent: z.number().int(), maxFanOut: z.number().int() }).partial().optional(),
  /** 会话通信 P1f：信任同伴（guarded → auto 不拦）。不给 = 保持原值。 */
  trustPeers: z.boolean().optional()
});
const decisionBody = z.object({ approve: z.boolean() });

export interface MessagingRouteDeps {
  readonly bus: MessageBus;
  readonly messages: MessageStore;
  readonly users?: Pick<UserRepository, 'byId'>;
  readonly deps: Pick<Deps, 'sessions' | 'tasks' | 'projects' | 'access' | 'bots' | 'workspaces' | 'workspaceGroups'>;
}

export function installMessagingRoutes(app: Hono<any>, options: MessagingRouteDeps, subjectOf: SubjectOf): void {
  const { bus, messages, deps, users } = options;
  const noMessage = { code: 'not_found', message: '没有这条消息' } as const;
  const sessionAndProject = async (id: SessionId, actor: Subject | null) => {
    const session = await deps.sessions.byId(id);
    if (!session) return null;
    const project = await projectOfSessionOrigin(deps, session);
    if (!project || !(await authorizeSession(deps.access, actor, project, session, 'session.read')).ok) return null;
    return { session, project };
  };
  const projections = (actor: Subject | null, projectId: string) => {
    const cache = new Map<SessionId, ReturnType<typeof sessionAndProject>>();
    const read = async (id: SessionId) => {
      let resolve = cache.get(id);
      if (!resolve) { resolve = sessionAndProject(id, actor); cache.set(id, resolve); }
      const visible = await resolve;
      return visible?.project.id === projectId ? visible.session : null;
    };
    const visibleParts = async (parts: readonly MessagePart[] = []) => (await Promise.all(parts.map(async (part) =>
      part.type === 'file' && part.session.startsWith('session:') && !(await read(asSessionId(part.session.slice('session:'.length)))) ? null : part
    ))).filter((part) => part !== null);
    const details = async (message: AgentMessage) => {
      const sender = messageSenderKind(message);
      const source = sender === 'session' ? await read(message.fromSessionId) : null;
      const initiator = message.initiator;
      const user = source && users && initiator?.kind === 'account' ? await users.byId(asUserId(initiator.accountId)) : null;
      return {
        ...(source ? { sourceSession: { id: source.id, label: source.title?.trim() || source.agentId } } : {}),
        ...(user?.displayName ? { initiatorName: user.displayName } : {}),
        parts: await visibleParts(message.parts), replyStatus: message.replyStatus ?? null, failure: message.failure
      };
    };
    return {
      details,
      inbox: async (message: AgentMessage, ownSession: SessionId) => {
        const { sourceSession, initiatorName, parts } = await details(message);
        const recipient = message.targetSessionId === ownSession ? ownSession :
          message.targetSessionId && (await read(message.targetSessionId)) ? message.targetSessionId : null;
        const view = messageView(message);
        return {
          ...view,
          from: message.fromSessionId === ownSession ? `session:${ownSession}` : sourceSession ? `session:${sourceSession.id}` : isExternalSender(message.fromSessionId) ? 'external:' : 'session:',
          fromLabel: null,
          to: message.targetSessionId === null && (message.to.startsWith('role:') || message.to.startsWith('bot:')) ? message.to : recipient ? `session:${recipient}` : '',
          targetSessionId: recipient,
          failureDetail: null,
          parts,
          replyParts: await visibleParts(message.replyParts),
          senderKind: messageSenderKind(message),
          initiatorKind: message.initiator?.kind ?? 'unknown',
          ...(sourceSession ? { sourceSession } : {}),
          ...(initiatorName ? { initiatorName } : {})
        };
      }
    };
  };

  app.get('/api/sessions/:id/messages', async (c) => {
    c.header('Cache-Control', NO_STORE['cache-control']);
    const sessionId = asSessionId(c.req.param('id'));
    const actor = subjectOf(c);
    const visible = await sessionAndProject(sessionId, actor);
    if (!visible) return fail(c, { code: 'not_found', message: '会话不存在' });
    const { project } = visible;
    const list = await bus.inbox(sessionId, 50, { unreadOnly: c.req.query('unread') === '1' });
    const pending = (await messages.awaitingApproval(project.id)).filter((m) => m.projectId === project.id && m.fromSessionId === sessionId);
    const { inbox } = projections(actor, project.id);
    return c.json({
      messages: await Promise.all(list.filter((m) => m.projectId === project.id && (m.targetSessionId === sessionId || m.fromSessionId === sessionId)).map((message) => inbox(message, sessionId))),
      awaitingApproval: await Promise.all(pending.map((message) => inbox(message, sessionId)))
    });
  });

  app.get('/api/sessions/:id/messages/:messageId/source', async (c) => {
    c.header('Cache-Control', NO_STORE['cache-control']);
    const actor = subjectOf(c);
    const target = await sessionAndProject(asSessionId(c.req.param('id')), actor);
    if (!target) return fail(c, noMessage);
    const message = await messages.byId(c.req.param('messageId'));
    if (!message || message.targetSessionId !== target.session.id || message.projectId !== target.project.id) return fail(c, noMessage);
    return c.json(await projections(actor, target.project.id).details(message));
  });

  app.post('/api/sessions/:id/messages', async (c) => {
    const parsed = sendBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '要给 kind（send / ask）、to 和 body' });
    const actor = principalOfSubject(subjectOf(c));
    const accepted = await bus.accept(
      { fromSessionId: asSessionId(c.req.param('id')), ...parsed.data, ...(actor ? { onBehalfOf: actor.user.id } : {}) },
      actor ? { initiator: actor.via ? { kind: 'external_token' } : { kind: 'account', accountId: actor.user.id } } : undefined
    );
    return accepted.ok ? c.json(accepted.value, 201) : fail(c, accepted.error);
  });

  app.get('/api/sessions/:id/peers', async (c) => {
    // installAccess 查路径上的会话；新增同任务树同伴还要按实际查看者过滤。
    const peers = await bus.peers(asSessionId(c.req.param('id')), { viewer: subjectOf(c) });
    if (!peers.ok) return fail(c, peers.error);
    // 顺带回这条会话自己的有效短名（检查器里「我的短名」用）。
    const self = await deps.sessions.byId(asSessionId(c.req.param('id')));
    return c.json({ peers: peers.value, handle: self ? await bus.handleOf(self) : null });
  });

  app.put('/api/sessions/:id/handle', async (c) => {
    const parsed = handleBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '要给 handle' });
    const actor = principalOfSubject(subjectOf(c));
    const saved = await bus.setHandle(asSessionId(c.req.param('id')), parsed.data.handle, actor ? `user:${actor.user.id}` : 'hub');
    return saved.ok ? c.json(saved.value) : fail(c, saved.error);
  });

  // 项目配置：先确认项目存在且看得到（读）/ 能改（写），不然任何人都能给不存在或别人的项目写角色表
  const projectFor = (c: Parameters<SubjectOf>[0], permission: 'project.read' | 'project.update') =>
    deps.projects.byId(asProjectId(c.req.param('id') ?? '')).then((project) => authorizeProject(deps.access, subjectOf(c), project, permission));

  app.get('/api/projects/:id/messaging', async (c) => {
    const allowed = await projectFor(c, 'project.read');
    if (!allowed.ok) return fail(c, allowed.error);
    const projectId = allowed.value.id;
    const config = await bus.config(projectId);
    const pending = await messages.awaitingApproval(projectId);
    return c.json({ ...messagingConfigDto(config), awaitingApproval: pending.map(messageView) });
  });

  app.put('/api/projects/:id/messaging', async (c) => {
    const parsed = configBody.safeParse(await c.req.json().catch(() => null));
    const allowed = await projectFor(c, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);
    if (!parsed.success) return fail(c, { code: 'invalid', message: parsed.error.issues[0]?.message ?? '配置格式不对' });
    const actor = principalOfSubject(subjectOf(c));
    const current = parsed.data.roles === undefined ? await bus.config(allowed.value.id) : null;
    const saved = await bus.saveConfig(
      allowed.value.id,
      {
        roles: parsed.data.roles?.map(toRole) ?? current?.roles ?? [],
        limits: parsed.data.limits ?? current?.limits ?? {},
        ...(parsed.data.trustPeers !== undefined ? { trustPeers: parsed.data.trustPeers } : {})
      },
      actor ? `user:${actor.user.id}` : 'hub'
    );
    return saved.ok ? c.json(messagingConfigDto(saved.value)) : fail(c, saved.error);
  });

  app.post('/api/messages/:id/decision', async (c) => {
    const actor = principalOfSubject(subjectOf(c));
    if (!actor) return fail(c, { code: 'forbidden', message: '要以账号身份批准' });
    const parsed = decisionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '要给 approve: true / false' });
    const target = await messages.byId(c.req.param('id'));
    const decided = target?.status === 'held'
      ? await bus.decideHeld(c.req.param('id'), actor, parsed.data.approve)
      : await bus.decideSpawn(c.req.param('id'), actor, parsed.data.approve);
    return decided.ok ? c.json(messageView(decided.value)) : fail(c, decided.error);
  });

  app.get('/api/messages/:id/trace', async (c) => {
    const message = await messages.byId(c.req.param('id'));
    if (!message) return fail(c, { code: 'not_found', message: '没有这条消息' });
    const visible = await authorizeProject(deps.access, subjectOf(c), await deps.projects.byId(message.projectId), 'project.read');
    if (!visible.ok) return fail(c, visible.error);
    const [trace, audit] = await Promise.all([messages.byTrace(message.traceId), messages.auditByTrace(message.traceId)]);
    return c.json({ traceId: message.traceId, messages: trace.map(messageView), audit });
  });
}
