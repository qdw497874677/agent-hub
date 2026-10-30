import { newId } from '../ids.ts';
import type { Principal } from '../account.ts';
import type { ProjectId } from '../ids.ts';
import type { Project } from '../project.ts';
import { isBusy } from '../session.ts';
import type { DomainError } from '../errors.ts';
import { conflict, forbidden, invalid } from '../errors.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { ToolGrantRepository } from '../ports/tool-grant-repository.ts';
import type { Deps } from './deps.ts';
import { authorizeProject, projectAsResource } from './authorization.ts';
import { can } from '../access.ts';

export interface DeleteProjectDeps extends Pick<Deps, 'projects' | 'sessions' | 'now' | 'access'> {
  readonly toolGrants: Pick<ToolGrantRepository, 'revokeSession'>;
  readonly audit: AuditLog;
}

export interface DeleteProjectCommand {
  readonly projectId: ProjectId;
  /** 防手滑：必须和项目名一字不差（GitHub 式确认）。 */
  readonly confirmName: string;
}

const signedIn = (actor: Principal | null): Result<Principal, DomainError> =>
  !actor || actor.user.disabledAt !== null || actor.user.deletedAt !== null ? err(forbidden('需要登录')) : ok(actor);

async function record(deps: DeleteProjectDeps, actor: Principal, action: 'project.delete' | 'project.restore' | 'project.purge', project: Project, detail: string) {
  await deps.audit.append({
    id: newId(),
    actorId: actor.user.id,
    actorEmail: actor.user.email,
    action,
    target: project.id,
    detail: `${project.name}（${detail}）`,
    at: deps.now(),
    teamId: project.teamId ?? actor.user.teamId
  });
}

/**
 * 删除项目 = 放进回收站（软删，ADR 0011）：只有团队 owner 和建它的人能删；不删磁盘目录。
 * 有会话还在跑就拒绝（先停）；名下会话的工具令牌全部吊销；写一条审计。之后能还原，或彻底删掉。
 */
export async function deleteProjectUseCase(
  deps: DeleteProjectDeps,
  actor: Principal | null,
  command: DeleteProjectCommand
): Promise<Result<Project, DomainError>> {
  const who = signedIn(actor);
  if (!who.ok) return who;
  const allowed = await authorizeProject(deps.access, who.value, await deps.projects.byId(command.projectId), 'project.delete');
  if (!allowed.ok) return allowed;
  const project = allowed.value;
  if (command.confirmName !== project.name) return err(invalid('输入的项目名不对'));
  const sessions = await deps.sessions.listByProject(project.id);
  const running = sessions.filter(isBusy);
  if (running.length > 0) return err(conflict(`还有 ${running.length} 个会话在运行，先停止再删除`));
  const now = deps.now();
  for (const session of sessions) await deps.toolGrants.revokeSession(session.id, now);
  const trashed: Project = { ...project, deletedAt: now };
  await deps.projects.save(trashed);
  await record(deps, who.value, 'project.delete', project, `放进回收站；${sessions.length} 个会话；工作空间的目录都保留`);
  return ok(trashed);
}

/** 从回收站还原。 */
export async function restoreProjectUseCase(
  deps: DeleteProjectDeps,
  actor: Principal | null,
  projectId: ProjectId
): Promise<Result<Project, DomainError>> {
  const who = signedIn(actor);
  if (!who.ok) return who;
  const allowed = await authorizeProject(deps.access, who.value, await deps.projects.byId(projectId), 'project.restore');
  if (!allowed.ok) return allowed;
  const restored: Project = { ...allowed.value, deletedAt: null };
  await deps.projects.save(restored);
  await record(deps, who.value, 'project.restore', restored, '从回收站还原');
  return ok(restored);
}

/** 彻底删掉回收站里的项目（库里的记录；磁盘目录照样不动）。同样要输项目名。 */
export async function purgeProjectUseCase(
  deps: DeleteProjectDeps,
  actor: Principal | null,
  command: DeleteProjectCommand
): Promise<Result<Project, DomainError>> {
  const who = signedIn(actor);
  if (!who.ok) return who;
  const allowed = await authorizeProject(deps.access, who.value, await deps.projects.byId(command.projectId), 'project.purge');
  if (!allowed.ok) return allowed;
  if (command.confirmName !== allowed.value.name) return err(invalid('输入的项目名不对'));
  await deps.projects.remove(allowed.value.id);
  await record(deps, who.value, 'project.purge', allowed.value, '彻底删除；工作空间的目录都保留');
  return ok(allowed.value);
}

/** 回收站：我能还原的那些。 */
export async function listTrashUseCase(deps: DeleteProjectDeps, actor: Principal | null): Promise<Project[]> {
  const ctx = deps.access ? await deps.access.context() : null;
  return (await deps.projects.listDeleted()).filter(
    (project) => !ctx || can(actor, 'project.restore', projectAsResource(project, ctx), ctx)
  );
}
