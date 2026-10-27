import type { Location, Project } from '../project.ts';
import type { Session } from '../session.ts';
import { isUsable, newWorkspace, normalizePath, samePlace, type Workspace } from '../workspace.ts';
import { folderNameProblem, insideRoots, projectSlug } from '../directories.ts';
import type { Machine } from './machine-dirs.ts';
import { claimOf, createDirectory, gitOn, listOn, normalize, parentOf, resolveMachine, rootsOf } from './machine-dirs.ts';
import type { ProjectId } from '../ids.ts';
import { asProjectId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { conflict, invalid, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';

/**
 * 一条会话实际在哪个目录干活：听它的工作空间。没有工作空间（或已删除）时退回项目的默认工作空间；
 * 都没有 root 为空串，调用方必须拒绝，不能把它当成 /。
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
  const fallback = await defaultWorkspaceFor(deps, project.id);
  return fallback ? { workerId: fallback.workerId, root: fallback.path } : { workerId: session?.workerId ?? null, root: '' };
}

/**
 * 没指定工作空间时用哪个：项目最早登记的、还能用的长期工作空间（迁移来的老项目就是原来的项目目录）。
 * 给了 workerId（null = Server 本机）就只在那台机器上找。没有返回 null：让人在运行面板里选。
 */
export async function defaultWorkspaceFor(
  deps: Pick<Deps, 'workspaces'>,
  projectId: ProjectId,
  workerId?: string | null
): Promise<Workspace | null> {
  const candidates = (await deps.workspaces.byProject(projectId))
    .filter((workspace) => workspace.kind === 'long_lived' && isUsable(workspace) && (workerId === undefined || workspace.workerId === workerId))
    .sort((a, b) => a.createdAt - b.createdAt);
  return candidates[0] ?? null;
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
 *   给了 `path` 就建在那里：必须是绝对路径、父目录已存在、它自己还不存在、不属于别的项目；
 * - `link`：选一个已有目录，人的目录，平台永不删。
 * 同一台机器同一个目录已经登记过就直接返回那一条（幂等）。
 */
export type LongLivedPlan = { readonly mode: 'create'; readonly path?: string } | { readonly mode: 'link'; readonly path: string };

export interface PrepareLongLivedCommand {
  readonly projectId: string;
  /** 人选的机器（null = 本机）。记账时记真实 Worker id。 */
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
  const resolved = await resolveMachine(deps, command.workerId);
  if (!resolved.ok) return resolved;
  const machine = resolved.value;

  const git = gitOn(deps, machine.route);
  let path: string;
  let source: Workspace['source'];
  let branch: string | null = null;
  let isGit: boolean | null = null;
  if (command.plan.mode === 'link') {
    if (!command.plan.path.startsWith('/')) return err(invalid('目录必须是绝对路径'));
    const listed = await listOn(deps, machine.route, normalizePath(command.plan.path));
    if (!listed.ok) return listed;
    if (listed.value === null) return err(invalid(`目录不存在：${command.plan.path}`));
    path = listed.value.path;
    source = 'linked';
    const taken = await claimOf(deps, { projectId: project.id, workerId: machine.workerId, path });
    if (!taken.ok) return taken;
    // 探测只是为了卡片上显示分支；失败（老 Worker 不认 ws.*）不挡关联
    const inspected = await git.inspect(path);
    if (inspected.ok) {
      isGit = inspected.value.isGit;
      branch = inspected.value.branch;
    }
  } else {
    const place = command.plan.path
      ? await chosenPlace(deps, project, machine, command.plan.path, command.home)
      : await managedPlace(deps, project, machine.route, command);
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
      const made = await createDirectory(deps, { workerId: machine.workerId, parent: place.value.parent, name: place.value.name, home: command.home });
      if (!made.ok) return made;
      path = made.value.path;
      isGit = false;
      source = 'created';
    }
  }

  const existing = (await deps.workspaces.byProject(project.id)).find(
    (workspace) => workspace.state !== 'removed' && samePlace(workspace, { workerId: machine.workerId, path })
  );
  if (existing) return ok(existing);
  const created = newWorkspace({
    projectId: project.id,
    workerId: machine.workerId,
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

/** 人指定的新目录：校验完拆成 parent + name，真正创建（mkdir / clone）留给调用方。 */
async function chosenPlace(
  deps: Pick<Deps, 'fs' | 'gateway' | 'projects' | 'workspaces'>,
  project: Project,
  machine: Machine,
  raw: string,
  home: string
): Promise<Result<{ readonly parent: string; readonly name: string }, DomainError>> {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') || trimmed.split('/').includes('..')) return err(invalid('目录必须是绝对路径'));
  const path = normalize(trimmed);
  const parent = parentOf(path);
  const name = path.split('/').at(-1) ?? '';
  if (parent === null || name === '') return err(invalid('不能用根目录'));
  const problem = folderNameProblem(name);
  if (problem !== null) return err(invalid(problem));
  if (machine.route === null) {
    const roots = await rootsOf(deps, null, machine.workerId, home);
    if (!insideRoots(parent, roots)) return err(invalid(`「${path}」不在允许新建目录的位置（${roots.join(':')}）`));
  }
  const parentListed = await listOn(deps, machine.route, parent);
  if (!parentListed.ok) return parentListed;
  if (parentListed.value === null) return err(invalid(`父目录不存在：${parent}`));
  if (parentListed.value.entries.some((entry) => entry.name === name)) {
    return err(conflict(`「${path}」已经存在；要用已有目录请选「关联已有目录」`));
  }
  const taken = await claimOf(deps, { projectId: project.id, workerId: machine.workerId, path });
  if (!taken.ok) return taken;
  return ok({ parent: parentListed.value.path, name });
}

/** slug、slug-2、slug-3……第一个没被占的（§7 托管目录名冲突）。 */
export function freeName(slug: string, taken: ReadonlySet<string>): string {
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n += 1) if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

/**
 * 迁移老数据：以前本机的工作空间 workerId 记成 null。本机 Worker 一上线，就把这些登记改记成它的真实 id
 * （幂等：没有 null 的就什么都不做）。remote Worker 上线不碰。返回改了几条。
 */
export async function adoptLocalWorkspacesUseCase(
  deps: Pick<Deps, 'now' | 'workspaces'>,
  worker: { readonly workerId: string; readonly origin: 'local' | 'remote' }
): Promise<number> {
  if (worker.origin !== 'local') return 0;
  const legacy = await deps.workspaces.onMachine(null);
  for (const workspace of legacy) await deps.workspaces.save({ ...workspace, workerId: worker.workerId, updatedAt: deps.now() });
  return legacy.length;
}
