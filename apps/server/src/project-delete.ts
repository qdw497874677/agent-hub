import type { Hono } from 'hono';
import { asProjectId, deleteProjectUseCase } from '@agent-hub/domain';
import type { DeleteProjectDeps } from '@agent-hub/domain';
import { deleteProjectRequest } from '@agent-hub/contract';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

/** DELETE /api/projects/:id —— 只删记录，磁盘目录保留。要登录态（审计要记是谁删的）。 */
export function installProjectDeletion(app: Hono, deps: DeleteProjectDeps, principalOf: PrincipalOf): void {
  app.delete('/api/projects/:projectId', async (c) => {
    const parsed = deleteProjectRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法' });
    const result = await deleteProjectUseCase(deps, principalOf(c), {
      projectId: asProjectId(c.req.param('projectId')),
      confirmName: parsed.data.confirmName
    });
    return result.ok ? c.json({ id: result.value.id, deleted: true }) : fail(c, result.error);
  });
}
