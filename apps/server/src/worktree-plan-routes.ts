import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { invalid } from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';
import type { createWorktreePlans } from './worktree-plans.ts';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/);
const preview = z.strictObject({
  workerId: identifier, source: z.enum(['local', 'project']), primaryId: identifier.optional(), runSetup: z.boolean().optional(),
  members: z.array(z.strictObject({ id: identifier, startRef: z.string().trim().min(1).max(256).optional(), baseWorkspaceId: identifier.optional() })).min(1).max(8)
});
const confirm = z.strictObject({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const root = '/api/projects/:projectId/tasks/:taskId/worktree-plans';

export function installDisabledWorktreePlanRoutes(app: Hono<any>): void {
  for (const route of [root, `${root}/:planId`, `${root}/:planId/execute`]) {
    app.all(route, (c) => {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: { code: 'not_found', message: '此 Hub 未启用 Worktree 计划' } }, 404);
    });
  }
}

export function installWorktreePlanRoutes(app: Hono<any>, plans: ReturnType<typeof createWorktreePlans>, actor: SubjectOf): void {
  const bounded = bodyLimit({ maxSize: 8192, onError: (c) => fail(c, invalid('Worktree 计划参数过长')) });
  app.use(root, async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.use(`${root}/*`, async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.get(root, async (c) => {
    const result = await plans.list(actor(c), c.req.param('projectId'), c.req.param('taskId'));
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  app.post(root, bounded, async (c) => {
    const body = preview.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(c, invalid('Worktree 计划参数不正确'));
    const result = await plans.preview(actor(c), c.req.param('projectId'), c.req.param('taskId'), body.data);
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  app.get(`${root}/:planId`, async (c) => {
    const result = await plans.get(actor(c), c.req.param('projectId'), c.req.param('taskId'), c.req.param('planId'));
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  app.post(`${root}/:planId/execute`, bounded, async (c) => {
    const body = confirm.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(c, invalid('需要明确确认 Worktree 计划版本'));
    const result = await plans.execute(actor(c), c.req.param('projectId'), c.req.param('taskId'), c.req.param('planId'), body.data.revision);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
}
