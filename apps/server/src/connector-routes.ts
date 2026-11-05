import type { Hono } from 'hono';
import { z } from 'zod';
import { decideAgentTask, principalOfSubject, type AgentTaskRequest, type AgentTaskStore, type ConnectorHub, type Deps, type Dispatcher } from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 连接器 HTTP 外壳（ADR 0032 R1/R2）。触发挂在 bot 下，只有人能建（agent 没有这些接口的工具）。
 * - GET/POST   /api/projects/:id/agents/:name/bindings
 * - PATCH/DELETE /api/bindings/:id，GET /api/bindings/:id/runs
 * - GET/PUT    /api/projects/:id/agents/:name/projects   关联项目（= 白名单）
 * - GET        /api/connectors/notices                   等我处理：自动暂停的触发 + 超额待批的任务
 * - POST       /api/agent-tasks/:id/decision             批 / 拒超额任务
 * - GET        /api/dispatch                             任务队列（R3）：排队 / 运行 / 最近完成
 * - POST       /api/dispatch/:id/cancel                  取消排队中的任务
 */
export interface ConnectorRouteDeps {
  readonly hub: ConnectorHub;
  readonly agentTasks: AgentTaskStore;
  readonly deps: Pick<Deps, 'now' | 'tasks' | 'projects'>;
  readonly dispatcher?: Dispatcher;
  /** 任务真正建出来（批准超额后）：交给调度器排队。 */
  readonly onCreated?: (r: AgentTaskRequest) => Promise<void>;
}

const createBody = z.object({
  connector: z.string().min(1).max(40), kind: z.string().min(1).max(40), name: z.string().min(1).max(60),
  target: z.enum(['main', 'new']).optional(), projectId: z.string().max(100).nullable().optional(),
  params: z.record(z.string(), z.unknown()).default({}), timeZone: z.string().max(60).optional()
});
const patchBody = z.object({ enabled: z.boolean().optional(), name: z.string().min(1).max(60).optional(), target: z.enum(['main', 'new']).optional(), params: z.record(z.string(), z.unknown()).optional() });
const projectsBody = z.object({ projectIds: z.array(z.string().min(1).max(100)).max(50) });
const validZone = (tz: string | undefined) => { try { if (tz) new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return undefined; } };

export function installConnectorRoutes(app: Hono<any>, r: ConnectorRouteDeps, subjectOf: SubjectOf): void {
  const me = (c: Parameters<SubjectOf>[0]) => principalOfSubject(subjectOf(c));
  const needUser = { code: 'forbidden' as const, message: '要以账号身份管理触发' };
  const bad = (e: z.ZodError) => ({ code: 'invalid' as const, message: e.issues[0] ? `${e.issues[0].path.join('.')}: ${e.issues[0].message}` : '格式不对' });

  app.get('/api/connectors', (c) => c.json({ sources: r.hub.sources() }));
  app.get('/api/projects/:id/agents/:name/bindings', async (c) => {
    const actor = me(c); if (!actor) return fail(c, needUser);
    const out = await r.hub.list(actor, c.req.param('id'), c.req.param('name'));
    return out.ok ? c.json({ bindings: out.value }) : fail(c, out.error);
  });
  app.post('/api/projects/:id/agents/:name/bindings', async (c) => {
    const actor = me(c); if (!actor) return fail(c, needUser);
    const p = createBody.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return fail(c, bad(p.error));
    const out = await r.hub.create(actor, c.req.param('id'), c.req.param('name'), { ...p.data, timeZone: validZone(p.data.timeZone) });
    return out.ok ? c.json(out.value, 201) : fail(c, out.error);
  });
  app.patch('/api/bindings/:id', async (c) => {
    const actor = me(c); if (!actor) return fail(c, needUser);
    const p = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return fail(c, bad(p.error));
    const out = await r.hub.update(actor, c.req.param('id'), p.data);
    return out.ok ? c.json(out.value) : fail(c, out.error);
  });
  app.delete('/api/bindings/:id', async (c) => {
    const actor = me(c); if (!actor) return fail(c, needUser);
    const out = await r.hub.remove(actor, c.req.param('id'));
    return out.ok ? c.json({ ok: true }) : fail(c, out.error);
  });
  app.get('/api/bindings/:id/runs', async (c) => {
    const actor = me(c); if (!actor) return fail(c, needUser);
    const out = await r.hub.runs(actor, c.req.param('id'), 30);
    return out.ok ? c.json({ runs: out.value }) : fail(c, out.error);
  });
  app.get('/api/projects/:id/agents/:name/projects', async (c) => {
    const actor = me(c); if (!actor) return fail(c, needUser);
    const out = await r.hub.agentProjects(actor, c.req.param('id'), c.req.param('name'));
    return out.ok ? c.json(out.value) : fail(c, out.error);
  });
  app.put('/api/projects/:id/agents/:name/projects', async (c) => {
    const actor = me(c); if (!actor) return fail(c, needUser);
    const p = projectsBody.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return fail(c, bad(p.error));
    const out = await r.hub.setAgentProjects(actor, c.req.param('id'), c.req.param('name'), p.data.projectIds);
    return out.ok ? c.json(out.value) : fail(c, out.error);
  });
  app.get('/api/connectors/notices', async (c) => {
    const actor = me(c); if (!actor) return c.json({ notices: [] });
    const paused = await r.hub.notices(actor.user.id);
    const pending = (await r.agentTasks.pendingFor(actor.user.id)).map((q) => ({ kind: 'task_pending' as const, id: q.id, title: q.title, reason: '超出 bot 建任务的配额，等你批准', since: q.createdAt, projectId: q.projectId, agentName: q.agent }));
    return c.json({ notices: [...paused, ...pending].sort((a, b) => b.since - a.since) });
  });
  app.post('/api/agent-tasks/:id/decision', async (c) => {
    const actor = me(c); if (!actor) return fail(c, needUser);
    const p = z.object({ approve: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!p.success) return fail(c, bad(p.error));
    const out = await decideAgentTask({ ...r.deps, requests: r.agentTasks, ...(r.onCreated ? { onCreated: r.onCreated } : {}) }, actor.user.id, c.req.param('id'), p.data.approve);
    return out.ok ? c.json(out.value) : fail(c, out.error);
  });
  app.get('/api/dispatch', async (c) => {
    const actor = me(c); if (!actor || !r.dispatcher) return c.json({ queued: [], running: [], recent: [], pending: [], caps: null });
    const view = await r.dispatcher.list(actor.user.id);
    const pending = (await r.agentTasks.pendingFor(actor.user.id)).map((q) => ({ id: q.id, title: q.title, projectId: q.projectId, agentName: q.agent, createdAt: q.createdAt }));
    return c.json({ ...view, pending });
  });
  app.post('/api/dispatch/:id/cancel', async (c) => {
    const actor = me(c); if (!actor) return fail(c, needUser);
    if (!r.dispatcher) return fail(c, { code: 'not_found' as const, message: '调度器没开' });
    const out = await r.dispatcher.cancel(actor.user.id, c.req.param('id'));
    return out.ok ? c.json(out.value) : fail(c, out.error);
  });
}
