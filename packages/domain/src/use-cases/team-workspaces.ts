import { principalOfSubject, type Subject } from '../access.ts';
import type { DomainError } from '../errors.ts';
import { conflict, forbidden, invalid, notFound } from '../errors.ts';
import { asProjectId, asWorkspaceId } from '../ids.ts';
import type { Project } from '../project.ts';
import { err, ok, type Result } from '../result.ts';
import type { Workspace } from '../workspace.ts';
import { authorizeProject, authorizeWorkspace, canManageTeamWorkspaces, projectReader } from './authorization.ts';
import type { Deps } from './deps.ts';
import { removeWorkspaceUseCase, type RemoveWorkspaceCommand } from './workspace-cleanup.ts';
import { actorId, prepareTeamWorkspace, projectOfSession, type LongLivedPlan } from './workspaces.ts';

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
    // 独占归属：未认领的目录团队里谁都看得见（项目 owner 才能在项目设置里认领）；
    // 被别人占着、而我看不到那个项目时，不列出来（不泄露别人的目录）。
    if (!manage && hidden > 0) continue;
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
  // 未认领的目录：目标项目的 project.update 就够（上面已判），不需要额外的可见性。
  // 已有认领者时仍走 authorizeWorkspace，避免对看不见的目录动手。
  if ((await deps.workspaces.linksOf(workspace.id)).length > 0) {
    const seen = await authorizeWorkspace(deps, command.actor, workspace, 'project.read');
    if (!seen.ok) return seen;
  }
  // 独占：一个长期工作空间同一时间只能被一个项目认领。同一项目重复关联仍然幂等。
  const other = (await deps.workspaces.linksOf(workspace.id)).find((link) => link.projectId !== project.value.id);
  if (other) {
    const owner = await deps.projects.byId(other.projectId);
    return err(conflict(`这个目录已经分配给项目「${owner?.name ?? other.projectId}」。先在那边释放，或在那个项目里把它转移到本项目`));
  }
  await deps.workspaces.link({ projectId: project.value.id, workspaceId: workspace.id, linkedBy: actorId(command.actor), linkedAt: deps.now() });
  return ok(workspace);
}

/**
 * 把长期工作空间从一个项目转移到另一个项目（独占归属下的「换人用」）：
 * - 没有认领者 = 直接认领；已经属于目标项目 = 幂等；
 * - 有别的认领者：要同时能改源项目和目标项目（源项目已删除 / 在回收站时放行）；
 * - 源项目还有会话在这个目录里跑 → 先停掉再转移。
 */
export async function transferWorkspaceUseCase(
  deps: Pick<Deps, 'projects' | 'workspaces' | 'access' | 'now' | 'sessions' | 'tasks' | 'workspaceGroups' | 'bots'>,
  command: LinkCommand
): Promise<Result<Workspace, DomainError>> {
  const project = await authorizeProject(deps.access, command.actor, await deps.projects.byId(asProjectId(command.projectId)), 'project.update');
  if (!project.ok) return project;
  const workspace = await deps.workspaces.byId(asWorkspaceId(command.workspaceId));
  if (!workspace || workspace.state === 'removed') return err(notFound('工作空间不存在'));
  if (workspace.kind !== 'long_lived') return err(invalid('临时工作空间只属于一个任务，不能转移'));
  if (!(await sameTeam(deps, workspace.teamId, project.value.teamId))) return err(notFound('工作空间不存在'));
  const links = await deps.workspaces.linksOf(workspace.id);
  if (links.length > 0) {
    const seen = await authorizeWorkspace(deps, command.actor, workspace, 'project.read');
    if (!seen.ok) return seen;
  }
  const others = links.filter((link) => link.projectId !== project.value.id);
  if (others.length === 0) {
    if (links.length > 0) return ok(workspace); // 已经属于这个项目
    await deps.workspaces.link({ projectId: project.value.id, workspaceId: workspace.id, linkedBy: actorId(command.actor), linkedAt: deps.now() });
    return ok(workspace);
  }
  // 源项目还在（没进回收站）时，调用者要对它也有 project.update
  const sourceProjects: Project[] = [];
  for (const link of others) {
    const source = await deps.projects.byId(link.projectId);
    if (source && source.deletedAt === null) sourceProjects.push(source);
  }
  for (const source of sourceProjects) {
    if (!(await authorizeProject(deps.access, command.actor, source, 'project.update')).ok) {
      return err(forbidden('转移要同时能改这两个项目：先在源项目里请 owner / 管理员操作'));
    }
  }
  const sourceIds = new Set(others.map((link) => link.projectId));
  for (const session of await deps.sessions.listByWorkspace(workspace.id)) {
    if (session.status !== 'running') continue;
    const owner = await projectOfSession(deps, session);
    if (owner !== null && sourceIds.has(owner.id)) return err(conflict('源项目还有会话在这个目录里运行，先停掉再转移'));
  }
  for (const link of others) await deps.workspaces.unlink(link.projectId, workspace.id);
  await deps.workspaces.link({ projectId: project.value.id, workspaceId: workspace.id, linkedBy: actorId(command.actor), linkedAt: deps.now() });
  return ok(workspace);
}

export async function unlinkWorkspaceUseCase(
  deps: Pick<Deps, 'projects' | 'workspaces' | 'sessions' | 'tasks' | 'access' | 'workspaceGroups' | 'bots'>,
  command: LinkCommand
): Promise<Result<Workspace, DomainError>> {
  const project = await authorizeProject(deps.access, command.actor, await deps.projects.byId(asProjectId(command.projectId)), 'project.update');
  if (!project.ok) return project;
  const workspace = await deps.workspaces.byId(asWorkspaceId(command.workspaceId));
  const links = workspace ? await deps.workspaces.linksOf(workspace.id) : [];
  if (!workspace || !links.some((l) => l.projectId === project.value.id)) return err(notFound('这个项目没有关联这个工作空间'));
  for (const session of await deps.sessions.listByWorkspace(workspace.id)) {
    if (session.status !== 'running') continue;
    const owner = await projectOfSession(deps, session);
    if (owner?.id === project.value.id) return err(conflict('本项目还有会话在这个工作空间里运行，先停掉它'));
  }
  await deps.workspaces.unlink(project.value.id, workspace.id);
  return ok(workspace);
}

/**
 * 删除 / 移除工作空间（项目设置和团队页共用）：
 * 长期工作空间同一时间只属于一个项目（独占归属），对它的项目有 project.update 即可。
 * `linksOf(...).length > 1` 只可能是迁移留下 / 手改的历史数据：那种仍要求团队 workspace.manage。
 */
export async function deleteWorkspaceUseCase(
  deps: Pick<Deps, 'git' | 'gateway' | 'now' | 'sessions' | 'tasks' | 'workspaces' | 'projects' | 'access'>,
  command: RemoveWorkspaceCommand & { readonly actor: Subject | null }
): Promise<Result<Workspace, DomainError>> {
  const workspace = await deps.workspaces.byId(asWorkspaceId(command.workspaceId));
  const allowed = await authorizeWorkspace(deps, command.actor, workspace, 'project.update');
  if (!allowed.ok) return allowed;
  if (allowed.value.kind === 'long_lived' && (await deps.workspaces.linksOf(allowed.value.id)).length > 1) {
    // 独占归属之后最多一个认领者；>1 只出现在历史数据里，保留这道更严的检查。
    if (!(await canManageTeamWorkspaces(deps.access, command.actor, allowed.value.teamId))) {
      return err(forbidden('这个工作空间还关联着别的项目；先在本项目「取消关联」，或请团队 owner / admin 在「工作空间」页删除'));
    }
  }
  return removeWorkspaceUseCase(deps, command);
}
