import { homedir } from 'node:os';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  asProjectId,
  asWorkspaceGroupId,
  buildWorkspaceGroupUseCase,
  removeWorkspaceGroupUseCase,
  retryWorkspaceGroupUseCase,
  type AuditAction,
  type Subject,
  type WorkspaceGroupDeps
} from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 组合工作空间（docs/design/multi-repo.md §4–§6）的 HTTP 外壳：
 * - POST   /api/projects/:projectId/workspace-groups        建组（沿用「建临时空间」权限）
 * - POST   /api/workspace-groups/:groupId/retry             重试 failed 成员
 * - DELETE /api/workspace-groups/:groupId                   删组（workspace.manage）
 *
 * 路径刻意避开 `/api/projects/:id/groups` 与 `/api/groups/:id`：那两条是聊天群（ADR 0018）。
 */
const createBody = z.object({
  taskId: z.string().min(1).max(80),
  workerId: z.string().min(1).max(120).nullable().optional(),
  home: z.string().min(1).max(2000).optional()
});
const retryBody = z.object({ home: z.string().min(1).max(2000).optional() });

export interface WorkspaceGroupRouteDeps {
  readonly deps: WorkspaceGroupDeps;
  /** 和 http.ts 里其它路由共用同一个审计入口（带 actor/ip/团队）。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly audit?: (c: any, subject: Subject | null, action: AuditAction, target: string, detail: string) => Promise<void>;
}

export function installWorkspaceGroupRoutes(app: Hono<any>, options: WorkspaceGroupRouteDeps, subjectOf: SubjectOf): void {
  const { deps, audit } = options;
  const needUser = { code: 'forbidden' as const, message: '要以账号身份管理组合工作空间' };

  app.post('/api/projects/:projectId/workspace-groups', async (c) => {
    const subject = subjectOf(c);
    if (!subject) return fail(c, needUser);
    const parsed = createBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(c, { code: 'invalid', message: issue ? `${issue.path.join('.')}: ${issue.message}` : '建组参数不对' });
    }
    const projectId = asProjectId(c.req.param('projectId'));
    const built = await buildWorkspaceGroupUseCase(deps, {
      projectId,
      taskId: parsed.data.taskId,
      workerId: parsed.data.workerId ?? null,
      home: parsed.data.home ?? homedir(),
      actor: subject
    });
    if (!built.ok) return fail(c, built.error);
    await audit?.(c, subject, 'workspace.group.create', built.value.id, `项目 ${projectId} · ${built.value.members.length} 个仓库`);
    return c.json(built.value, 201);
  });

  app.post('/api/workspace-groups/:groupId/retry', async (c) => {
    const subject = subjectOf(c);
    if (!subject) return fail(c, needUser);
    const groupId = asWorkspaceGroupId(c.req.param('groupId'));
    const group = await deps.workspaceGroups?.byId(groupId);
    if (!group) return fail(c, { code: 'not_found', message: '组合工作空间不存在' });
    const parsed = retryBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!parsed.success) return fail(c, { code: 'invalid', message: '重试参数不对' });
    const retried = await retryWorkspaceGroupUseCase(deps, {
      groupId,
      home: parsed.data.home ?? homedir(),
      actor: subject
    });
    if (!retried.ok) return fail(c, retried.error);
    await audit?.(c, subject, 'workspace.group.retry', groupId, `重试后 ${retried.value.state}`);
    return c.json(retried.value);
  });

  app.delete('/api/workspace-groups/:groupId', async (c) => {
    const subject = subjectOf(c);
    if (!subject) return fail(c, needUser);
    const groupId = asWorkspaceGroupId(c.req.param('groupId'));
    const group = await deps.workspaceGroups?.byId(groupId);
    if (!group) return fail(c, { code: 'not_found', message: '组合工作空间不存在' });
    const removed = await removeWorkspaceGroupUseCase(deps, { groupId, actor: subject, home: homedir() });
    if (!removed.ok) return fail(c, removed.error);
    await audit?.(c, subject, 'workspace.group.remove', groupId, `删除 ${group.root} · ${group.members.length} 个成员`);
    return c.json(removed.value);
  });
}

