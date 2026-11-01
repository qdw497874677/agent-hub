import type { Hono } from 'hono';
import { z } from 'zod';
import { asProjectId, principalOfSubject, PERSISTENT_AGENT_COLORS, PERSISTENT_AGENT_DESCRIPTION_MAX, PERSISTENT_AGENT_DISPLAY_NAME_MAX, type PersistentAgents } from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 持久智能体（界面上叫「bot」）的 HTTP 外壳：
 * - GET    /api/projects/:id/agents          列表（带所在的群）
 * - POST   /api/projects/:id/agents          新建（name 即 @id，建好不改）
 * - PUT    /api/projects/:id/agents/:name    改显示名 / 颜色 / 职责 / 运行时 / 模型 / 复用
 * - DELETE /api/projects/:id/agents/:name    删除，同时从所有群移出
 * 旧的整表接口 /api/projects/:id/messaging 保留。
 */
const fields = {
  displayName: z.string().max(PERSISTENT_AGENT_DISPLAY_NAME_MAX).optional(),
  color: z.enum(PERSISTENT_AGENT_COLORS).optional(),
  description: z.string().max(PERSISTENT_AGENT_DESCRIPTION_MAX).optional(),
  agentId: z.string().min(1).max(80),
  model: z.string().max(200).optional(),
  reuse: z.enum(['sticky', 'per-trace', 'always-new']).optional()
};
const createBody = z.object({ name: z.string().min(1).max(40), ...fields });
const patchBody = z.object({ ...fields, agentId: fields.agentId.optional() });

export function installPersistentAgentRoutes(app: Hono<any>, agents: PersistentAgents, subjectOf: SubjectOf): void {
  const me = (c: Parameters<SubjectOf>[0]) => principalOfSubject(subjectOf(c));
  const needUser = { code: 'forbidden' as const, message: '要以账号身份管理 bot' };
  const issue = (e: z.ZodError) => {
    const first = e.issues[0];
    return first ? `${first.path.join('.')}: ${first.message}` : 'bot 格式不对';
  };

  app.get('/api/projects/:id/agents', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const list = await agents.list(actor, asProjectId(c.req.param('id')));
    return list.ok ? c.json({ agents: list.value }) : fail(c, list.error);
  });

  app.post('/api/projects/:id/agents', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const parsed = createBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: issue(parsed.error) });
    const created = await agents.create(actor, asProjectId(c.req.param('id')), parsed.data);
    return created.ok ? c.json(created.value, 201) : fail(c, created.error);
  });

  app.put('/api/projects/:id/agents/:name', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const parsed = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: issue(parsed.error) });
    const updated = await agents.update(actor, asProjectId(c.req.param('id')), c.req.param('name'), parsed.data);
    return updated.ok ? c.json(updated.value) : fail(c, updated.error);
  });

  app.delete('/api/projects/:id/agents/:name', async (c) => {
    const actor = me(c);
    if (!actor) return fail(c, needUser);
    const removed = await agents.remove(actor, asProjectId(c.req.param('id')), c.req.param('name'));
    return removed.ok ? c.json(removed.value) : fail(c, removed.error);
  });
}
