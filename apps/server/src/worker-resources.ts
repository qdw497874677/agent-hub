import type { Hono } from 'hono';
import { resourcePolicyRequest, workerMetricsHistorySchema } from '@agent-hub/contract';
import type { ResourceDeps } from '@agent-hub/domain';
import { setRefuseWhenFull, workerMetricsHistory } from '@agent-hub/domain';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 机器资源（ADR 0014）：
 * - GET /api/workers/:id/metrics：最近 1 小时的采样（含每条会话用量），能看见这台机器就能看；
 * - PUT /api/workers/:id/resource-policy：「资源满了就拒绝新会话」开关，要能管这台机器。
 * 最新一份已经随 /api/workers 每 5 秒的轮询带下去，这里只补历史。
 */
export function installWorkerResources(app: Hono, deps: ResourceDeps, principalOf: PrincipalOf): void {
  app.get('/api/workers/:id/metrics', async (c) => {
    const workerId = c.req.param('id');
    const result = await workerMetricsHistory(deps, principalOf(c), workerId);
    if (!result.ok) return fail(c, result.error);
    return c.json(workerMetricsHistorySchema.parse({ workerId, samples: result.value }));
  });
  app.put('/api/workers/:id/resource-policy', async (c) => {
    const parsed = resourcePolicyRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid', message: '请求格式不对：需要 { refuseWhenFull: boolean }' } }, 400);
    const result = await setRefuseWhenFull(deps, principalOf(c), c.req.param('id'), parsed.data.refuseWhenFull);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
}
