import type { Hono } from 'hono';
import { createApiTokenRequest } from '@agent-hub/contract';
import { createApiToken, listApiTokens, revokeApiToken } from '@agent-hub/domain';
import type { ApiTokenDeps } from '@agent-hub/domain';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 设置页里管 API 令牌（ADR 0015），只走登录态（cookie + CSRF，由 installAuth 守）：
 * - GET    /api/tokens       我的个人令牌 + （团队主人）服务账号
 * - POST   /api/tokens       新建；明文只在这次响应里出现
 * - DELETE /api/tokens/:id   吊销（服务账号连账号一起停用）
 */
export function installApiTokens(app: Hono, deps: ApiTokenDeps, principalOf: PrincipalOf): void {
  const need = (c: Parameters<PrincipalOf>[0]) => principalOf(c);
  app.get('/api/tokens', async (c) => {
    const actor = need(c);
    if (!actor) return c.json({ error: { code: 'unauthorized', message: '请先登录' } }, 401);
    return c.json(await listApiTokens(deps, actor));
  });
  app.post('/api/tokens', async (c) => {
    const actor = need(c);
    if (!actor) return c.json({ error: { code: 'unauthorized', message: '请先登录' } }, 401);
    const parsed = createApiTokenRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法' });
    const result = await createApiToken(deps, actor, parsed.data);
    c.header('Cache-Control', 'no-store');
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  app.delete('/api/tokens/:id', async (c) => {
    const actor = need(c);
    if (!actor) return c.json({ error: { code: 'unauthorized', message: '请先登录' } }, 401);
    const result = await revokeApiToken(deps, actor, c.req.param('id'));
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
}
