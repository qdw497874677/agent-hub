import type { Hono } from 'hono';
import { createApiTokenRequest, mcpAccessPatchRequest } from '@agent-hub/contract';
import { apiTokenActivity, authenticateApiTokenById, createApiToken, listApiTokens, revokeApiToken, rotateApiToken } from '@agent-hub/domain';
import type { ApiTokenDeps, HubSettings, Principal } from '@agent-hub/domain';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';
import { effectiveWrites, mcpToolsFor, policyFromEnv } from './openapi/mcp.ts';

export interface ApiTokenRouteOptions {
  /** hub 设置：外部 MCP 只读模式（mcpReadOnly）。不给就只能读环境变量、不能在页面上改。 */
  readonly settings?: { get(): Promise<HubSettings>; save(next: HubSettings): Promise<void> };
}

/**
 * 设置页 / 外部接入页里管 API 令牌（ADR 0015），只走登录态（cookie + CSRF，由 installAuth 守）：
 * - GET    /api/tokens                我的个人令牌 + （团队主人）服务账号 + （项目 admin）bot 凭据（含已吊销）
 * - POST   /api/tokens                新建；kind='bot' 要 projectId；可 projectIds 限定项目。明文只在这次响应里出现
 * - DELETE /api/tokens/:id            吊销（服务账号连账号一起停用；bot 只作废凭据）。记录保留
 * - POST   /api/tokens/:id/rotate     轮换：同权限新令牌 + 旧的吊销（记录保留）
 * - GET    /api/tokens/:id/activity   最近活动（创建 / 轮换 / 吊销 / MCP 调用）
 * - GET    /api/tokens/:id/tools      这个令牌接上 MCP 能看到哪些工具
 * - GET    /api/mcp/access            外部 MCP 的只读模式（谁都能看；集群管理员能改）
 * - PUT    /api/mcp/access            改只读模式；readOnly=null 恢复成沿用环境变量
 */
export function installApiTokens(app: Hono, deps: ApiTokenDeps, principalOf: PrincipalOf, options: ApiTokenRouteOptions = {}): void {
  const need = (c: Parameters<PrincipalOf>[0]) => principalOf(c);
  const unauthorized = { error: { code: 'unauthorized', message: '请先登录' } } as const;
  const accessSetting = async () => effectiveWrites(await options.settings?.get().catch(() => null));
  /** 对外的形状：页面只关心「是不是只读」，写不写由令牌 scope 决定。 */
  const accessBody = (access: { writes: boolean; source: 'setting' | 'env' }) => ({ readOnly: !access.writes, source: access.source });
  const canManageMcp = (actor: Principal) => actor.user.clusterAdmin === true && !actor.via;

  app.get('/api/tokens', async (c) => {
    const actor = need(c);
    if (!actor) return c.json(unauthorized, 401);
    return c.json(await listApiTokens(deps, actor));
  });
  app.post('/api/tokens', async (c) => {
    const actor = need(c);
    if (!actor) return c.json(unauthorized, 401);
    const parsed = createApiTokenRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法' });
    const result = await createApiToken(deps, actor, parsed.data);
    c.header('Cache-Control', 'no-store');
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  app.delete('/api/tokens/:id', async (c) => {
    const actor = need(c);
    if (!actor) return c.json(unauthorized, 401);
    const result = await revokeApiToken(deps, actor, c.req.param('id'));
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  app.post('/api/tokens/:id/rotate', async (c) => {
    const actor = need(c);
    if (!actor) return c.json(unauthorized, 401);
    const result = await rotateApiToken(deps, actor, c.req.param('id'));
    c.header('Cache-Control', 'no-store');
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  app.get('/api/tokens/:id/activity', async (c) => {
    const actor = need(c);
    if (!actor) return c.json(unauthorized, 401);
    const result = await apiTokenActivity(deps, actor, c.req.param('id'), Number(c.req.query('limit') ?? 50) || 50);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  app.get('/api/tokens/:id/tools', async (c) => {
    const actor = need(c);
    if (!actor) return c.json(unauthorized, 401);
    const via = await authenticateApiTokenById(deps, actor, c.req.param('id'));
    if (!via.ok) return fail(c, via.error);
    const { writes } = await accessSetting();
    const tools = mcpToolsFor(via.value.permissions, { ...policyFromEnv(), writes });
    return c.json({ tools: tools.map((tool) => ({ name: tool.name, readOnly: tool.readOnly })), writes });
  });
  app.get('/api/mcp/access', async (c) => {
    const actor = need(c);
    if (!actor) return c.json(unauthorized, 401);
    return c.json({ ...accessBody(await accessSetting()), canManage: canManageMcp(actor) && options.settings !== undefined });
  });
  app.put('/api/mcp/access', async (c) => {
    const actor = need(c);
    if (!actor) return c.json(unauthorized, 401);
    if (!canManageMcp(actor) || !options.settings) return fail(c, { code: 'forbidden', message: '只有集群管理员能改外部接入的只读模式' });
    const parsed = mcpAccessPatchRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法：需要 { readOnly: true | false | null }' });
    const current = await options.settings.get();
    if ((current.mcpReadOnly ?? null) !== parsed.data.readOnly) {
      await options.settings.save({ ...current, mcpReadOnly: parsed.data.readOnly });
      await deps.audit
        ?.append({
          id: crypto.randomUUID(),
          actorId: actor.user.id,
          actorEmail: actor.user.email,
          action: 'settings.update',
          target: 'settings',
          detail: `mcpReadOnly=${JSON.stringify(parsed.data.readOnly)}`,
          at: deps.now(),
          ip: null,
          teamId: actor.user.teamId ?? null
        })
        .catch(() => undefined);
    }
    return c.json({ ...accessBody(await accessSetting()), canManage: true });
  });
}
