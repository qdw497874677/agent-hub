import { principalOfSubject, type Subject } from '../access.ts';
import type { DomainError } from '../errors.ts';
import { conflict, forbidden, invalid, notFound } from '../errors.ts';
import { asProjectId, asWorkspaceId } from '../ids.ts';
import { err, ok, type Result } from '../result.ts';
import type { Workspace } from '../workspace.ts';
import { authorizeProject, authorizeWorkspace, canManageTeamWorkspaces, projectReader } from './authorization.ts';
import type { Deps } from './deps.ts';
import { removeWorkspaceUseCase, type RemoveWorkspaceCommand } from './workspace-cleanup.ts';
import { actorId, prepareTeamWorkspace, type LongLivedPlan } from './workspaces.ts';

/**
 * 团队工作空间（ADR 0026）：长期工作空间属于团队，项目通过关联来用。
 * - 看：有团队 workspace.manage 的看全部；其他人看关联到自己看得见的项目的；
 * - 团队页新建 / 删除共用的：workspace.manage；
 * - 关联 / 取消关联：对项目有 project.update，且看得见这个工作空间（Q4）。
 */
export interface TeamWorkspaceView {
  readonly workspace: Workspace;
  /** 关联的、你看得见的项目。 */
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  /** 关联了但你看不见的项目数。 */
  readonly hiddenProjects: number;
  /** 此刻在里面跑的会话数（所有项目）。 */
  readonly runningSessions: number;
}

type TeamDeps = Pick<Deps, 'projects' | 'workspaces' | 'sessions' | 'access'>;

/** 这个人所在的团队；没装账号体系时是 null（单人模式，全部可见）。 */
export async function teamOf(deps: Pick<Deps, 'access'>, actor: Subject | null): Promise<string | null> {
  const mine = principalOfSubject(actor)?.user.teamId ?? null;
  if (mine !== null || !deps.access) return mine;
  return (await deps.access.context()).hubTeamId;
}

/** 同一个团队？老数据 teamId 为 null 按 hub 团队算。 */
async function sameTeam(deps: Pick<Deps, 'access'>, a: string | null, b: string | null): Promise<boolean> {
  if (a === b) return true;
  if (!deps.access) return true;
  const hub = (await deps.access.context()).hubTeamId;
  return (a ?? hub) === (b ?? hub);
}

export async function listTeamWorkspacesUseCase(deps: TeamDeps, actor: Subject | null): Promise<Result<TeamWorkspaceView[], DomainError>> {
  const team = await teamOf(deps, actor);
  const manage = await canManageTeamWorkspaces(deps.access, actor, team);
  const readable = await projectReader(deps.access, actor);
  const views: TeamWorkspaceView[] = [];
  for (const workspace of await deps.workspaces.longLived()) {
    if (!(await sameTeam(deps, workspace.teamId, team))) continue;
    const projects: { id: string; name: string }[] = [];
    let hidden = 0;
    for (const link of await deps.workspaces.linksOf(workspace.id)) {
      const project = await deps.projects.byId(link.projectId);
      if (!project || project.deletedAt !== null) continue;
      if (readable(project)) projects.push({ id: project.id, name: project.name });
      else hidden += 1;
    }
    if (!manage && projects.length === 0) continue;
    const running = (await deps.sessions.listByWorkspace(workspace.id)).filter((s) => s.status === 'running').length;
    views.push({ workspace, projects, hiddenProjects: hidden, runningSessions: running });
  }
  return ok(views);
}

export interface CreateTeamWorkspaceCommand {
  readonly actor: Subject | null;
  readonly workerId: string | null;
  readonly plan: LongLivedPlan;
  /** 仓库配方（Q3）。 */
  readonly repoUrl?: string | null;
  readonly branch?: string | null;
  /** 托管目录名（没给路径时用）。 */
  readonly name?: string | null;
  /** 建好顺手关联到这个项目（可选）。 */
  readonly projectId?: string | null;
  readonly home: string;
}

export async function createTeamWorkspaceUseCase(
  deps: Pick<Deps, 'fs' | 'git' | 'gateway' | 'now' | 'projects' | 'workspaces' | 'sessions' | 'access'>,
  command: CreateTeamWorkspaceCommand
): Promise<Result<Workspace, DomainError>> {
  const team = await teamOf(deps, command.actor);
  if (!(await canManageTeamWorkspaces(deps.access, command.actor, team))) return err(forbidden('只有团队 owner / admin（或有「管理工作空间」权限的人）能在团队里新建工作空间；也可以在项目设置里为项目新建'));
  const repoUrl = command.repoUrl?.trim() || null;
  const slug = (command.name ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const prepared = await prepareTeamWorkspace(deps, {
    teamId: team,
    originProjectId: null,
    repo: repoUrl ? { url: repoUrl, branch: command.branch?.trim() || null } : null,
    slug,
    workerId: command.workerId,
    plan: command.plan,
    home: command.home,
    actor: command.actor
  });
  if (!prepared.ok || !command.projectId) return prepared;
  const linked = await linkWorkspaceUseCase(deps, { actor: command.actor, projectId: command.projectId, workspaceId: prepared.value.id });
  return linked.ok ? prepared : linked;
}

export interface LinkCommand {
  readonly actor: Subject | null;
  readonly projectId: string;
  readonly workspaceId: string;
}

export async function linkWorkspaceUseCase(deps: Pick<Deps, 'projects' | 'workspaces' | 'access' | 'now'>, command: LinkCommand): Promise<Result<Workspace, DomainError>> {
  const project = await authorizeProject(deps.access, command.actor, await deps.projects.byId(asProjectId(command.projectId)), 'project.update');
  if (!project.ok) return project;
  const workspace = await deps.workspaces.byId(asWorkspaceId(command.workspaceId));
  if (!workspace || workspace.state === 'removed') return err(notFound('工作空间不存在'));
  if (workspace.kind !== 'long_lived') return err(invalid('临时工作空间只属于一个任务，不能关联'));
  if (!(await sameTeam(deps, workspace.teamId, project.value.teamId))) return err(notFound('工作空间不存在'));
  const seen = await authorizeWorkspace(deps, command.actor, workspace, 'project.read');
  if (!seen.ok) return seen;
  await deps.workspaces.link({ projectId: project.value.id, workspaceId: workspace.id, linkedBy: actorId(command.actor), linkedAt: deps.now() });
  return ok(workspace);
}

export async function unlinkWorkspaceUseCase(
  deps: Pick<Deps, 'projects' | 'workspaces' | 'sessions' | 'tasks' | 'access'>,
  command: LinkCommand
): Promise<Result<Workspace, DomainError>> {
  const project = await authorizeProject(deps.access, command.actor, await deps.projects.byId(asProjectId(command.projectId)), 'project.update');
  if (!project.ok) return project;
  const workspace = await deps.workspaces.byId(asWorkspaceId(command.workspaceId));
  const links = workspace ? await deps.workspaces.linksOf(workspace.id) : [];
  if (!workspace || !links.some((l) => l.projectId === project.value.id)) return err(notFound('这个项目没有关联这个工作空间'));
  for (const session of await deps.sessions.listByWorkspace(workspace.id)) {
    if (session.status !== 'running') continue;
    const task = await deps.tasks.byId(session.taskId);
    if (task?.projectId === project.value.id) return err(conflict('本项目还有会话在这个工作空间里运行，先停掉它'));
  }
  await deps.workspaces.unlink(project.value.id, workspace.id);
  return ok(workspace);
}

/**
 * 删除 / 移除工作空间（项目设置和团队页共用）：
 * 关联了不止一个项目的长期工作空间是团队共用的，要 workspace.manage；否则对它的项目有 project.update 即可。
 */
export async function deleteWorkspaceUseCase(
  deps: Pick<Deps, 'git' | 'gateway' | 'now' | 'sessions' | 'tasks' | 'workspaces' | 'projects' | 'access'>,
  command: RemoveWorkspaceCommand & { readonly actor: Subject | null }
): Promise<Result<Workspace, DomainError>> {
  const workspace = await deps.workspaces.byId(asWorkspaceId(command.workspaceId));
  const allowed = await authorizeWorkspace(deps, command.actor, workspace, 'project.update');
  if (!allowed.ok) return allowed;
  if (allowed.value.kind === 'long_lived' && (await deps.workspaces.linksOf(allowed.value.id)).length > 1) {
    if (!(await canManageTeamWorkspaces(deps.access, command.actor, allowed.value.teamId))) {
      return err(forbidden('这个工作空间还关联着别的项目；先在本项目「取消关联」，或请团队 owner / admin 在「工作空间」页删除'));
    }
  }
  return removeWorkspaceUseCase(deps, command);
}
