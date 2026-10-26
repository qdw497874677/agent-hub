import { newId } from '../ids.ts';
import type { Principal } from '../account.ts';
import type { ProjectId } from '../ids.ts';
import type { Project } from '../project.ts';
import type { DomainError } from '../errors.ts';
import { conflict, forbidden, invalid, notFound } from '../errors.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { ToolGrantRepository } from '../ports/tool-grant-repository.ts';
import type { Deps } from './deps.ts';

export interface DeleteProjectDeps extends Pick<Deps, 'projects' | 'sessions' | 'now'> {
  readonly toolGrants: Pick<ToolGrantRepository, 'revokeSession'>;
  readonly audit: AuditLog;
}

export interface DeleteProjectCommand {
  readonly projectId: ProjectId;
  /** 防手滑：必须和项目名一字不差（GitHub 式确认）。 */
  readonly confirmName: string;
}

/**
 * 删除项目：只删记录，**不删磁盘目录**。
 * 有会话还在跑就拒绝（先停）；名下会话的工具令牌全部吊销；写一条审计。
 * 权限沿用现有规则：登录且未停用的主人或成员都能操作项目。
 */
export async function deleteProjectUseCase(
  deps: DeleteProjectDeps,
  actor: Principal | null,
  command: DeleteProjectCommand
): Promise<Result<Project, DomainError>> {
  if (!actor || actor.user.disabledAt !== null) return err(forbidden('需要登录'));
  const project = await deps.projects.byId(command.projectId);
  if (!project) return err(notFound('项目不存在'));
  if (command.confirmName !== project.name) return err(invalid('输入的项目名不对'));
  const sessions = await deps.sessions.listByProject(project.id);
  const running = sessions.filter((session) => session.status === 'running');
  if (running.length > 0) return err(conflict(`还有 ${running.length} 个会话在运行，先停止再删除`));
  const now = deps.now();
  for (const session of sessions) await deps.toolGrants.revokeSession(session.id, now);
  await deps.projects.remove(project.id);
  await deps.audit.append({
    id: newId(),
    actorId: actor.user.id,
    actorEmail: actor.user.email,
    action: 'project.delete',
    target: project.id,
    detail: `${project.name}（${sessions.length} 个会话；磁盘目录 ${project.rootPath} 保留）`,
    at: now
  });
  return ok(project);
}
