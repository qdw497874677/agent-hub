import type { Hono } from 'hono';
import { z } from 'zod';
import type { ContextService } from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 上下文策略的 HTTP 外壳（ADR 0020 · P1）：
 * - GET/PUT /api/projects/:id/context   项目默认策略 + 启用列表（读要 project.read，改要 project.update）
 * - GET/PUT /api/sessions/:id/context   会话的生效策略、模式、退回原因、L1 能力缺口、估算用量；会话级选择（创建者）
 * - PUT /api/projects/:id/context/roles/:role   角色层选择（project.update；null = 跟随项目）
 * - POST /api/sessions/:id/context/compact     手动压缩（session.prompt；运行时不支持返回 400，正在回复返回 409）
 * 权限全在 ContextService 里过，项目 / 会话不存在一律 404。
 */
const projectBody = z.object({ strategy: z.string().min(1).max(60), enabled: z.array(z.string().min(1).max(60)).min(1).max(20) });
const sessionBody = z.object({ strategy: z.string().min(1).max(60).nullable() });
const compactBody = z.object({ instructions: z.string().max(2000).optional() });

export function installContextRoutes(app: Hono<any>, context: ContextService, subjectOf: SubjectOf): void {
  app.get('/api/projects/:id/context', async (c) => {
    const r = await context.project(subjectOf(c), c.req.param('id'));
    return r.ok ? c.json(r.value) : fail(c, r.error);
  });
  app.put('/api/projects/:id/context', async (c) => {
    const body = projectBody.safeParse(await c.req.json().catch(() => null));
    // 先看权限再校验参数：没权限的人不该从报错里看出接口长什么样
    const seen = await context.project(subjectOf(c), c.req.param('id'));
    if (!seen.ok) return fail(c, seen.error);
    if (!body.success) return fail(c, { code: 'invalid', message: '要给 strategy 和 enabled' });
    const r = await context.setProject(subjectOf(c), c.req.param('id'), body.data);
    return r.ok ? c.json(r.value) : fail(c, r.error);
  });
  app.put('/api/projects/:id/context/roles/:role', async (c) => {
    const body = sessionBody.safeParse(await c.req.json().catch(() => null));
    const seen = await context.project(subjectOf(c), c.req.param('id'));
    if (!seen.ok) return fail(c, seen.error);
    if (!body.success) return fail(c, { code: 'invalid', message: 'strategy 是策略 id 或 null（跟随项目）' });
    const r = await context.setRole(subjectOf(c), c.req.param('id'), c.req.param('role'), body.data.strategy);
    return r.ok ? c.json(r.value) : fail(c, r.error);
  });
  app.post('/api/sessions/:id/context/compact', async (c) => {
    const seen = await context.session(subjectOf(c), c.req.param('id'));
    if (!seen.ok) return fail(c, seen.error);
    const body = compactBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!body.success) return fail(c, { code: 'invalid', message: 'instructions 最多 2000 字' });
    const r = await context.compact(subjectOf(c), c.req.param('id'), body.data.instructions);
    return r.ok ? c.json(r.value, 202) : fail(c, r.error);
  });
  app.get('/api/sessions/:id/context', async (c) => {
    const r = await context.session(subjectOf(c), c.req.param('id'));
    return r.ok ? c.json(r.value) : fail(c, r.error);
  });
  app.put('/api/sessions/:id/context', async (c) => {
    const body = sessionBody.safeParse(await c.req.json().catch(() => null));
    const seen = await context.session(subjectOf(c), c.req.param('id'));
    if (!seen.ok) return fail(c, seen.error);
    if (!body.success) return fail(c, { code: 'invalid', message: 'strategy 是策略 id 或 null（跟随项目）' });
    const r = await context.setSession(subjectOf(c), c.req.param('id'), body.data.strategy);
    return r.ok ? c.json(r.value) : fail(c, r.error);
  });
}
