import type { Hono } from 'hono';
import { z } from 'zod';
import {
  asProjectId,
  asSessionId,
  authorizeProject,
  messageView,
  principalOfSubject,
  type Deps,
  type MessageBus,
  type MessageStore
} from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * agent 间通信的 HTTP 外壳（ADR 0018 · P2P）：
 * - GET  /api/sessions/:id/messages        进出这条会话的消息 + 它发起、等人批的派生请求
 * - POST /api/sessions/:id/messages        人替这条会话发一条（链头，代的是这个人）
 * - GET/PUT /api/projects/:id/messaging    项目的角色表和限额（最多默认值 2 倍）
 * - POST /api/messages/:id/decision        批 / 拒派生新会话（要 agent.spawn）
 * - GET  /api/messages/:id/trace           一条协作链的消息和审计
 * 路径里带 sessions / projects 的读写权限由 installAccess 先查过。
 */
const sendBody = z.object({
  kind: z.enum(['send', 'ask']),
  to: z.string().min(3).max(200),
  body: z.string().min(1).max(32768),
  idempotencyKey: z.string().max(100).optional()
});
const roleBody = z.object({
  name: z.string().max(40),
  description: z.string().max(500).default(''),
  agentId: z.string().min(1).max(80),
  model: z.string().max(200).default(''),
  reuse: z.enum(['sticky', 'per-trace', 'always-new']).default('sticky')
});
const configBody = z.object({
  roles: z.array(roleBody).max(50),
  limits: z.object({ maxDepth: z.number().int(), maxConcurrent: z.number().int(), maxFanOut: z.number().int() }).partial().default({})
});
const decisionBody = z.object({ approve: z.boolean() });

export interface MessagingRouteDeps {
  readonly bus: MessageBus;
  readonly messages: MessageStore;
  readonly deps: Pick<Deps, 'sessions' | 'tasks' | 'projects' | 'access'>;
}

export function installMessagingRoutes(app: Hono<any>, options: MessagingRouteDeps, subjectOf: SubjectOf): void {
  const { bus, messages, deps } = options;

  app.get('/api/sessions/:id/messages', async (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    const session = await deps.sessions.byId(sessionId);
    if (!session) return fail(c, { code: 'not_found', message: '会话不存在' });
    const task = await deps.tasks.byId(session.taskId);
    if (!task) return fail(c, { code: 'not_found', message: '会话不存在' });
    const visible = await authorizeProject(deps.access, subjectOf(c), await deps.projects.byId(task.projectId), 'project.read');
    if (!visible.ok) return fail(c, visible.error);
    const list = await bus.inbox(sessionId, 50);
    const pending = task ? (await messages.awaitingApproval(task.projectId)).filter((m) => m.fromSessionId === sessionId) : [];
    return c.json({ messages: list.map(messageView), awaitingApproval: pending.map(messageView) });
  });

  app.post('/api/sessions/:id/messages', async (c) => {
    const parsed = sendBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '要给 kind（send / ask）、to 和 body' });
    const actor = principalOfSubject(subjectOf(c));
    const accepted = await bus.accept({ fromSessionId: asSessionId(c.req.param('id')), ...parsed.data, ...(actor ? { onBehalfOf: actor.user.id } : {}) });
    return accepted.ok ? c.json(accepted.value, 201) : fail(c, accepted.error);
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
    return c.json({ ...config, awaitingApproval: pending.map(messageView) });
  });

  app.put('/api/projects/:id/messaging', async (c) => {
    const parsed = configBody.safeParse(await c.req.json().catch(() => null));
    const allowed = await projectFor(c, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);
    if (!parsed.success) return fail(c, { code: 'invalid', message: parsed.error.issues[0]?.message ?? '配置格式不对' });
    const saved = await bus.saveConfig(allowed.value.id, parsed.data);
    return saved.ok ? c.json(saved.value) : fail(c, saved.error);
  });

  app.post('/api/messages/:id/decision', async (c) => {
    const actor = principalOfSubject(subjectOf(c));
    if (!actor) return fail(c, { code: 'forbidden', message: '要以账号身份批准' });
    const parsed = decisionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '要给 approve: true / false' });
    const decided = await bus.decideSpawn(c.req.param('id'), actor, parsed.data.approve);
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
