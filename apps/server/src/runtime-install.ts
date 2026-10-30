import type { Hono } from 'hono';
import { runtimeJobRequest as runtimeJobRequestSchema } from '@agent-hub/contract';
import type { RuntimeInstallDeps } from '@agent-hub/domain';
import { startRuntimeJob } from '@agent-hub/domain';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 在某台机器上装 / 升级 / 卸载 agent 运行时（ADR 0010）。
 * 不是管理员专属：机器的主人（本机 = owner，远程 = 配对它的人）也能管自己的机器，权限在领域里判。
 * 只回「已下发」，进度看 /api/workers 里这台机器的 runtimeJob。
 */
export function installRuntimeInstall(app: Hono, deps: RuntimeInstallDeps, principalOf: PrincipalOf): void {
  app.post('/api/workers/:id/runtimes/:agentId', async (c) => {
    const principal = principalOf(c);
    if (!principal) return c.json({ error: { code: 'unauthorized', message: '请先登录' } }, 401);
    const parsed = runtimeJobRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid', message: '请求格式不对：action 只能是 install / uninstall，version 形如 1.2.3' } }, 400);
    const result = await startRuntimeJob(deps, principal, c.req.param('id'), {
      agentId: c.req.param('agentId'),
      action: parsed.data.action,
      ...(parsed.data.version ? { version: parsed.data.version } : {})
    });
    return result.ok ? c.json({ job: result.value }, 202) : fail(c, result.error);
  });
}
