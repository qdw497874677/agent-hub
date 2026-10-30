import type { Context, Hono } from 'hono';
import { asProjectId, deleteProjectUseCase, listTrashUseCase, purgeProjectUseCase, restoreProjectUseCase } from '@agent-hub/domain';
import type { DeleteProjectDeps } from '@agent-hub/domain';
import { deleteProjectRequest } from '@agent-hub/contract';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 删除项目 = 进回收站（ADR 0011）。都要登录态（审计要记是谁）。磁盘目录一律保留。
 * - DELETE /api/projects/:id              放进回收站（团队 owner / 建它的人）
 * - GET    /api/projects-trash            回收站里我能还原的
 * - POST   /api/projects/:id/restore      还原
 * - POST   /api/projects/:id/purge        彻底删除（要输项目名）
 */
export function installProjectDeletion(app: Hono, deps: DeleteProjectDeps, principalOf: PrincipalOf): void {
  const confirm = async (c: Context) => deleteProjectRequest.safeParse(await c.req.json().catch(() => null));
  app.delete('/api/projects/:projectId', async (c) => {
    const parsed = await confirm(c);
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法' });
    const result = await deleteProjectUseCase(deps, principalOf(c), {
      projectId: asProjectId(c.req.param('projectId')),
      confirmName: parsed.data.confirmName
    });
    return result.ok ? c.json({ id: result.value.id, deleted: true }) : fail(c, result.error);
  });
  app.get('/api/projects-trash', async (c) => {
    const projects = await listTrashUseCase(deps, principalOf(c));
    return c.json(projects.map((p) => ({ id: p.id, name: p.name, deletedAt: p.deletedAt, createdBy: p.createdBy })));
  });
  app.post('/api/projects/:projectId/restore', async (c) => {
    const result = await restoreProjectUseCase(deps, principalOf(c), asProjectId(c.req.param('projectId')));
    return result.ok ? c.json({ id: result.value.id, restored: true }) : fail(c, result.error);
  });
  app.post('/api/projects/:projectId/purge', async (c) => {
    const parsed = await confirm(c);
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法' });
    const result = await purgeProjectUseCase(deps, principalOf(c), {
      projectId: asProjectId(c.req.param('projectId')),
      confirmName: parsed.data.confirmName
    });
    return result.ok ? c.json({ id: result.value.id, purged: true }) : fail(c, result.error);
  });
}
