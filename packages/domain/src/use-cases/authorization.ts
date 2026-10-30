import type { Principal } from '../account.ts';
import type { AccessContext, Permission, Resource } from '../access.ts';
import { can } from '../access.ts';
import type { Project } from '../project.ts';
import type { DomainError } from '../errors.ts';
import { forbidden, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { UserRepository } from '../ports/user-repository.ts';
import type { SettingsRepository } from '../ports/settings-repository.ts';
import type { EnrollmentRepository } from '../ports/enrollment-repository.ts';
import type { NodeGateway } from '../ports/node-gateway.ts';
import type { Session } from '../session.ts';
import { asProjectId, asSessionId, asTaskId, asWorkspaceId } from '../ids.ts';
import type { Deps } from './deps.ts';

/**
 * 把「资源是谁的」查出来交给 can()（ADR 0011）。路由和用例都只问它，不自己比角色。
 */
export interface AccessPolicy {
  context(): Promise<AccessContext>;
  /** 一台 Worker 当资源：本机（null 或 origin=local）属于 hub 管理员的团队；远端属于接入它的人的团队。 */
  worker(workerId: string | null): Promise<Resource>;
}

export interface AccessPolicyDeps {
  readonly users: Pick<UserRepository, 'hubAdmin' | 'byId'>;
  readonly settings: Pick<SettingsRepository, 'get'>;
  readonly enrollment: Pick<EnrollmentRepository, 'credentialFor'>;
  readonly gateway: Pick<NodeGateway, 'status'>;
}

export const LOCAL_WORKER_DENIED = '本机 Worker（hub 所在的机器）只有 hub 管理员和被单独授权的人能用';

export function createAccessPolicy(deps: AccessPolicyDeps): AccessPolicy {
  const context = async (): Promise<AccessContext> => {
    const [admin, settings] = await Promise.all([deps.users.hubAdmin(), deps.settings.get()]);
    return { hubTeamId: admin?.teamId ?? null, hubAdminId: admin?.id ?? null, settings };
  };
  return {
    context,
    async worker(workerId) {
      const ctx = await context();
      const workers = await deps.gateway.status();
      const status = workerId === null ? undefined : workers.find((w) => w.workerId === workerId);
      if (workerId === null || status?.origin === 'local') {
        return { teamId: ctx.hubTeamId, createdBy: ctx.hubAdminId ?? null, local: true };
      }
      const credential = await deps.enrollment.credentialFor(workerId);
      // 凭共享 HUB_TOKEN 接入的老机器没有凭据：算 hub 管理员团队的。
      if (!credential) return { teamId: ctx.hubTeamId, createdBy: ctx.hubAdminId ?? null };
      const enrolledBy = await deps.users.byId(credential.enrolledBy);
      return { teamId: enrolledBy?.teamId ?? ctx.hubTeamId, createdBy: credential.enrolledBy };
    }
  };
}

/** 项目当资源：老数据 team_id 为 NULL 时算 hub 管理员团队的。项目下的任务、会话、工作空间都用它。 */
export function projectAsResource(project: Project, ctx: AccessContext): Resource {
  return { teamId: project.teamId ?? ctx.hubTeamId, createdBy: project.createdBy, sharedWith: project.members };
}

/**
 * 能不能对项目做 permission。看不见（别的团队、不是自己的也没共享）一律 notFound，不泄露存在；
 * 看得见但没这个权限给 forbidden。回收站里的只有 restore / purge 能碰。
 */
export async function authorizeProject(
  policy: AccessPolicy | undefined,
  actor: Principal | null,
  project: Project | null,
  permission: Permission
): Promise<Result<Project, DomainError>> {
  if (!project) return err(notFound('项目不存在'));
  const trashOnly = permission === 'project.restore' || permission === 'project.purge';
  if (trashOnly && project.deletedAt === null) return err(notFound('回收站里没有这个项目'));
  if (!trashOnly && project.deletedAt !== null) return err(notFound('项目不存在'));
  if (!policy || actor === null) return ok(project);
  const ctx = await policy.context();
  const resource = projectAsResource(project, ctx);
  if (!can(actor, 'project.read', resource, ctx)) return err(notFound('项目不存在'));
  if (!can(actor, permission, resource, ctx)) return err(forbidden('你没有权限这么做'));
  return ok(project);
}

/**
 * 能不能把活派到这台机器上（开会话、分叉、换地方继续、建工作空间、看目录）。
 * 本机 Worker 走单独的 worker.use_local。session 开跑 / 派发前都要过这一关。
 */
export async function authorizeWorker(
  policy: AccessPolicy | undefined,
  actor: Principal | null,
  workerId: string | null,
  permission: Permission = 'worker.use'
): Promise<Result<void, DomainError>> {
  if (!policy || actor === null) return ok(undefined);
  const [ctx, resource] = await Promise.all([policy.context(), policy.worker(workerId)]);
  if (resource.local && !can(actor, 'worker.use_local', resource, ctx)) return err(forbidden(LOCAL_WORKER_DENIED));
  if (!can(actor, permission, resource, ctx)) return err(forbidden(resource.local ? LOCAL_WORKER_DENIED : '你不能用这台机器'));
  return ok(undefined);
}

/** 路由上的各种 id → 它所在的项目（任务、会话、工作空间都挂在项目下）。找不到是 null。 */
export type ResourceRef =
  | { readonly kind: 'project'; readonly id: string }
  | { readonly kind: 'task'; readonly id: string }
  | { readonly kind: 'session'; readonly id: string }
  | { readonly kind: 'workspace'; readonly id: string };

export async function projectOfRef(
  deps: Pick<Deps, 'projects' | 'tasks' | 'sessions' | 'workspaces'>,
  ref: ResourceRef
): Promise<{ project: Project | null; session: Session | null }> {
  if (ref.kind === 'project') return { project: await deps.projects.byId(asProjectId(ref.id)), session: null };
  if (ref.kind === 'workspace') {
    const workspace = await deps.workspaces.byId(asWorkspaceId(ref.id));
    return { project: workspace ? await deps.projects.byId(workspace.projectId) : null, session: null };
  }
  let taskId = ref.id;
  let session: Session | null = null;
  if (ref.kind === 'session') {
    session = await deps.sessions.byId(asSessionId(ref.id));
    if (!session) return { project: null, session: null };
    taskId = session.taskId;
  }
  const task = await deps.tasks.byId(asTaskId(taskId));
  return { project: task ? await deps.projects.byId(task.projectId) : null, session };
}

/** 列表过滤用：这个人能看的项目（回收站里的不算）。 */
export async function projectReader(policy: AccessPolicy | undefined, actor: Principal | null): Promise<(project: Project) => boolean> {
  if (!policy || actor === null) return (project) => project.deletedAt === null;
  const ctx = await policy.context();
  return (project) => project.deletedAt === null && can(actor, 'project.read', projectAsResource(project, ctx), ctx);
}

/** 机器列表过滤用：本机 Worker 只给能用它的人看；远端看所在团队。 */
export async function workerReader(policy: AccessPolicy | undefined, actor: Principal | null): Promise<(workerId: string) => Promise<boolean>> {
  if (!policy || actor === null) return async () => true;
  const ctx = await policy.context();
  return async (workerId) => {
    const resource = await policy.worker(workerId);
    if (resource.local) return can(actor, 'worker.use_local', resource, ctx);
    return can(actor, 'worker.read', resource, ctx);
  };
}
