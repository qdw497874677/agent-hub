import { workspaceFor, type Location, type Project } from '../project.ts';
import type { Session } from '../session.ts';
import { isUsable, newWorkspace, normalizePath, samePlace, type Workspace } from '../workspace.ts';
import { projectSlug } from '../directories.ts';
import { createDirectory, directoryOwner, gitOn, listOn, rootsOf } from './machine-dirs.ts';
import type { ProjectId } from '../ids.ts';
import { asProjectId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { invalid, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';

/**
 * 一条会话（或「还没有会话」时的项目本身）实际在哪个目录干活。
 * 有工作空间就听工作空间的；迁移前的老会话没有，就按项目目录推算（与以前完全一样）。
 */
export async function locationOf(
  deps: Pick<Deps, 'workspaces'>,
  project: Project,
  session: Pick<Session, 'workerId' | 'workspaceId'> | null
): Promise<Location> {
  if (session?.workspaceId) {
    const workspace = await deps.workspaces.byId(session.workspaceId);
    if (workspace && workspace.state !== 'removed') return { workerId: workspace.workerId, root: workspace.path };
  }
  return workspaceFor(project, session?.workerId ?? null);
}

/**
 * 「项目目录」对应的长期工作空间：落到哪台机器就用哪台登记过的目录。
 * 迁移会把老数据全登记好；这里兜底，碰到没登记的（迁移后才映射的目录）就补登一条 linked。
 */
export async function linkedWorkspaceFor(
  deps: Pick<Deps, 'workspaces' | 'now'>,
  project: Project,
  workerId: string | null
): Promise<Workspace | null> {
  const place = workspaceFor(project, workerId);
  if (!place.root.startsWith('/')) return null; // 没有目录的新项目：只能在运行面板里选工作空间
  const existing = (await deps.workspaces.byProject(project.id)).find(
    (workspace) => workspace.kind === 'long_lived' && isUsable(workspace) && samePlace(workspace, { workerId: place.workerId, path: place.root })
  );
  if (existing) return existing;
  const created = newWorkspace({
    projectId: project.id,
    workerId: place.workerId,
    path: place.root,
    kind: 'long_lived',
    source: 'linked',
    now: deps.now()
  });
  if (!created.ok) return null;
  await deps.workspaces.save(created.value);
  return created.value;
}

/** 项目名下还在的工作空间（不含已删除的），长期在前、临时在后，各自按新旧排。 */
export async function listWorkspacesUseCase(
  deps: Pick<Deps, 'projects' | 'workspaces'>,
  projectId: string
): Promise<Result<Workspace[], DomainError>> {
  const id: ProjectId = asProjectId(projectId);
  if (!(await deps.projects.byId(id))) return err(notFound('项目不存在'));
  const all = await deps.workspaces.byProject(id);
  const rank = (workspace: Workspace): number => (workspace.kind === 'long_lived' ? 0 : 1);
  return ok(
    all
      .filter((workspace) => workspace.state !== 'removed')
      .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)
  );
}

/** 运行面板里一行：工作空间本身 + 现在有哪些任务正在里面跑会话（并发警告用）。 */
export interface WorkspaceView {
  readonly workspace: Workspace;
  readonly runningTaskIds: readonly string[];
}

/** 同 listWorkspacesUseCase，另附每个工作空间里正在跑的任务——面板据此提示「另一个任务也在这里干活」。 */
export async function workspaceViewsUseCase(
  deps: Pick<Deps, 'projects' | 'sessions' | 'workspaces'>,
  projectId: string
): Promise<Result<WorkspaceView[], DomainError>> {
  const listed = await listWorkspacesUseCase(deps, projectId);
  if (!listed.ok) return listed;
  const running = new Map<string, Set<string>>();
  for (const session of await deps.sessions.listByProject(asProjectId(projectId))) {
    if (session.status !== 'running' || !session.workspaceId) continue;
    const tasks = running.get(session.workspaceId) ?? new Set<string>();
    tasks.add(session.taskId);
    running.set(session.workspaceId, tasks);
  }
  return ok(listed.value.map((workspace) => ({ workspace, runningTaskIds: [...(running.get(workspace.id) ?? [])] })));
}

/**
 * 新建持久工作空间（§4.1）：
 * - `create`：在那台机器的 `<roots[0]>/agent-hub/<项目 slug>` 新建（名字被占就 -2、-3……），平台建的；
 *   项目绑了仓库就 clone 到那里（cloned），没绑就是空目录（created）；
 * - `link`：选一个已有目录，人的目录，平台永不删。
 * 同一台机器同一个目录已经登记过就直接返回那一条（幂等）。
 */
export type LongLivedPlan = { readonly mode: 'create' } | { readonly mode: 'link'; readonly path: string };

export interface PrepareLongLivedCommand {
  readonly projectId: string;
  /** 人选的机器；本机 Worker 会折叠成 null（和项目目录同一套规则）。 */
  readonly workerId: string | null;
  readonly plan: LongLivedPlan;
  /** Server 本机的起点（没有本机 Worker 报 roots 时兜底）。 */
  readonly home: string;
}

export async function prepareLongLivedWorkspaceUseCase(
  deps: Pick<Deps, 'fs' | 'git' | 'gateway' | 'now' | 'projects' | 'workspaces'>,
  command: PrepareLongLivedCommand
): Promise<Result<Workspace, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));
  const owner = await directoryOwner(deps, command.workerId);
  if (!owner.ok) return owner;

  const git = gitOn(deps, owner.value);
  let path: string;
  let source: Workspace['source'];
  let branch: string | null = null;
  let isGit: boolean | null = null;
  if (command.plan.mode === 'link') {
    if (!command.plan.path.startsWith('/')) return err(invalid('目录必须是绝对路径'));
    const listed = await listOn(deps, owner.value, normalizePath(command.plan.path));
    if (!listed.ok) return listed;
    if (listed.value === null) return err(invalid(`目录不存在：${command.plan.path}`));
    path = listed.value.path;
    source = 'linked';
    // 探测只是为了卡片上显示分支；失败（老 Worker 不认 ws.*）不挡关联
    const inspected = await git.inspect(path);
    if (inspected.ok) {
      isGit = inspected.value.isGit;
      branch = inspected.value.branch;
    }
  } else {
    const place = await managedPlace(deps, project, owner.value, command);
    if (!place.ok) return place;
    if (project.repo) {
      // 有仓库：把它下载到托管目录（用那台机器自己的 git 凭据）
      const cloned = await git.clone({ repoUrl: project.repo.url, parent: place.value.parent, name: place.value.name, branch: project.repo.defaultBranch });
      if (!cloned.ok) return cloned;
      path = cloned.value.path;
      branch = cloned.value.branch;
      isGit = true;
      source = 'cloned';
    } else {
      const made = await createDirectory(deps, { workerId: owner.value, parent: place.value.parent, name: place.value.name, home: command.home });
      if (!made.ok) return made;
      path = made.value.path;
      isGit = false;
      source = 'created';
    }
  }

  const existing = (await deps.workspaces.byProject(project.id)).find(
    (workspace) => workspace.state !== 'removed' && samePlace(workspace, { workerId: owner.value, path })
  );
  if (existing) return ok(existing);
  const created = newWorkspace({
    projectId: project.id,
    workerId: owner.value,
    path,
    kind: 'long_lived',
    source,
    branch,
    isGit,
    now: deps.now()
  });
  if (!created.ok) return created;
  await deps.workspaces.save(created.value);
  return ok(created.value);
}

/** `<roots[0]>/agent-hub/<slug>`：先确保 agent-hub 这层在，再挑一个磁盘上还没有的名字（还没建）。 */
async function managedPlace(
  deps: Pick<Deps, 'fs' | 'gateway'>,
  project: Project,
  owner: string | null,
  command: Pick<PrepareLongLivedCommand, 'workerId' | 'home'>
): Promise<Result<{ readonly parent: string; readonly name: string }, DomainError>> {
  const roots = await rootsOf(deps, owner, command.workerId, command.home);
  const root = roots[0];
  if (root === undefined) return err(invalid('这台机器没有可以新建目录的位置'));
  const base = await createDirectory(deps, { workerId: owner, parent: root, name: 'agent-hub', home: command.home });
  if (!base.ok) return base;
  const listed = await listOn(deps, owner, base.value.path);
  if (!listed.ok) return listed;
  const taken = new Set((listed.value?.entries ?? []).map((entry) => entry.name));
  const slug = projectSlug(project.name) ?? 'project';
  return ok({ parent: base.value.path, name: freeName(slug, taken) });
}

/** slug、slug-2、slug-3……第一个没被占的（§7 托管目录名冲突）。 */
export function freeName(slug: string, taken: ReadonlySet<string>): string {
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n += 1) if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
}
