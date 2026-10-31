import type { AccessContext, Permission, Resource, Subject } from '../access.ts';
import { can, decide, DENY_MESSAGES } from '../access.ts';
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
  /** 一台 Worker 当资源：本机（null 或 origin=local）只给集群管理员；远端属于接入它的人的团队。 */
  worker(workerId: string | null): Promise<Resource>;
}

export interface AccessPolicyDeps {
  readonly users: Pick<UserRepository, 'firstClusterAdmin' | 'byId'>;
  readonly settings: Pick<SettingsRepository, 'get'>;
  readonly enrollment: Pick<EnrollmentRepository, 'credentialFor'>;
  readonly gateway: Pick<NodeGateway, 'status'>;
}

export const LOCAL_WORKER_DENIED = DENY_MESSAGES.local_worker;

export function createAccessPolicy(deps: AccessPolicyDeps): AccessPolicy {
  const context = async (): Promise<AccessContext> => {
    const [admin, settings] = await Promise.all([deps.users.firstClusterAdmin(), deps.settings.get()]);
    return { hubTeamId: admin?.teamId ?? null, settings };
  };
  return {
    context,
    async worker(workerId) {
      const ctx = await context();
      const workers = await deps.gateway.status();
      const status = workerId === null ? undefined : workers.find((w) => w.workerId === workerId);
      if (workerId === null || status?.origin === 'local') {
        return { kind: 'worker', id: workerId ?? 'local', teamId: ctx.hubTeamId, createdBy: null, local: true };
      }
      const credential = await deps.enrollment.credentialFor(workerId);
      // 凭共享 HUB_TOKEN 接入的老机器没有凭据：算 hub 管理员团队的。
      if (!credential) return { kind: 'worker', id: workerId, teamId: ctx.hubTeamId, createdBy: null };
      const enrolledBy = await deps.users.byId(credential.enrolledBy);
      return { kind: 'worker', id: workerId, teamId: enrolledBy?.teamId ?? ctx.hubTeamId, createdBy: credential.enrolledBy };
    }
  };
}

/** 项目当资源：老数据 team_id 为 NULL 时算 hub 管理员团队的。项目下的任务、会话、工作空间都用它。 */
export function projectAsResource(project: Project, ctx: AccessContext): Resource {
  return { kind: 'project', id: project.id, teamId: project.teamId ?? ctx.hubTeamId, createdBy: project.createdBy, sharedWith: project.members };
}

/**
 * 会话当资源（ADR 0017 决定 4A）：说话 / 中断 / 换机继续只看会话的创建者，不看项目共享。
 * 老会话没有 createdBy 时退回项目创建者。
 */
export function sessionAsResource(session: Session, project: Project, ctx: AccessContext): Resource {
  return {
    kind: 'session',
    id: session.id,
    teamId: project.teamId ?? ctx.hubTeamId,
    createdBy: session.createdBy ?? project.createdBy
  };
}

/** 对会话做 permission（session.prompt / interrupt / continue）：先要看得见项目。 */
export async function authorizeSession(
  policy: AccessPolicy | undefined,
  actor: Subject | null,
  project: Project | null,
  session: Session | null,
  permission: Permission
): Promise<Result<Session, DomainError>> {
  if (!session) return err(notFound('会话不存在'));
  const visible = await authorizeProject(policy, actor, project, 'session.read');
  if (!visible.ok) return visible;
  if (!policy) return ok(session);
  const ctx = await policy.context();
  const decision = decide(actor, permission, sessionAsResource(session, visible.value, ctx), ctx);
  return decision.allow ? ok(session) : err(forbidden(decision.reason === 'relation' ? '只有会话的创建者、团队 owner / admin 或被授权的人能这么做' : DENY_MESSAGES[decision.reason]));
}

/**
 * 能不能对项目做 permission。看不见（别的团队、不是自己的也没共享）一律 notFound，不泄露存在；
 * 看得见但没这个权限给 forbidden。回收站里的只有 restore / purge 能碰。
 */
export async function authorizeProject(
  policy: AccessPolicy | undefined,
  actor: Subject | null,
  project: Project | null,
  permission: Permission
): Promise<Result<Project, DomainError>> {
  if (!project) return err(notFound('项目不存在'));
  const trashOnly = permission === 'project.restore' || permission === 'project.purge';
  if (trashOnly && project.deletedAt === null) return err(notFound('回收站里没有这个项目'));
  if (!trashOnly && project.deletedAt !== null) return err(notFound('项目不存在'));
  if (!policy) return ok(project);
  const ctx = await policy.context();
  const resource = projectAsResource(project, ctx);
  if (!can(actor, 'project.read', resource, ctx)) return err(notFound('项目不存在'));
  const decision = decide(actor, permission, resource, ctx);
  if (!decision.allow) return err(forbidden(DENY_MESSAGES[decision.reason]));
  return ok(project);
}

/**
 * 能不能把活派到这台机器上（开会话、分叉、换地方继续、建工作空间、看目录）。
 * 本机 Worker 只给集群管理员（can() 第 4 步）。session 开跑 / 派发前都要过这一关。
 */
export async function authorizeWorker(
  policy: AccessPolicy | undefined,
  actor: Subject | null,
  workerId: string | null,
  permission: Permission = 'worker.use'
): Promise<Result<void, DomainError>> {
  if (!policy) return ok(undefined);
  const [ctx, resource] = await Promise.all([policy.context(), policy.worker(workerId)]);
  const decision = decide(actor, permission, resource, ctx);
  if (!decision.allow) return err(forbidden(resource.local ? LOCAL_WORKER_DENIED : decision.reason === 'team' ? '你不能用这台机器' : DENY_MESSAGES[decision.reason]));
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
export async function projectReader(policy: AccessPolicy | undefined, actor: Subject | null): Promise<(project: Project) => boolean> {
  if (!policy) return (project) => project.deletedAt === null;
  const ctx = await policy.context();
  return (project) => project.deletedAt === null && can(actor, 'project.read', projectAsResource(project, ctx), ctx);
}

/** 机器列表过滤用：本机 Worker 只给能用它的人看；远端看所在团队。 */
export async function workerReader(policy: AccessPolicy | undefined, actor: Subject | null): Promise<(workerId: string) => Promise<boolean>> {
  if (!policy) return async () => true;
  const ctx = await policy.context();
  return async (workerId) => can(actor, 'worker.read', await policy.worker(workerId), ctx);
}
