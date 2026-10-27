import { createProject, normalizeDescription, parseRepo } from '../project.ts';
import { asProjectId } from '../ids.ts';
import type { Project } from '../project.ts';
import type { DomainError } from '../errors.ts';
import { invalid, notFound } from '../errors.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import type { Deps } from './deps.ts';
import type { DirectoryEntry } from '../ports/workspace-fs.ts';
import { newWorkspace, type Workspace } from '../workspace.ts';
import { claimOf, directoryOwner, listOn, normalize, parentOf, remoteExists, resolveMachine, rootsOf } from './machine-dirs.ts';

export { createDirectory, directoryOwner } from './machine-dirs.ts';
import { managedDirectory, projectSlug } from '../directories.ts';

export interface CreateProjectCommand {
  readonly name: string;
  /** 空串 / 不给 = 先不选目录（开始任务时再选工作空间）。 */
  readonly rootPath?: string;
  /** 目录在哪台 Worker 上。不给 / 给的是本机 Worker = 和 Server 同机。 */
  readonly workerId?: string | null;
  /** 可选的 git 仓库。 */
  readonly repoUrl?: string | null;
  readonly defaultBranch?: string | null;
  /** 可选的项目说明（markdown）。 */
  readonly description?: string | null;
}

export async function createProjectUseCase(
  deps: Pick<Deps, 'fs' | 'now' | 'projects' | 'gateway' | 'workspaces'>,
  command: CreateProjectCommand
): Promise<Result<Project, DomainError>> {
  const repo = parseRepo(command.repoUrl, command.defaultBranch);
  if (!repo.ok) return repo;
  const description = normalizeDescription(command.description);
  if (!description.ok) return description;
  const rootPath = command.rootPath?.trim() ?? '';
  const where = await resolveMachine(deps, command.workerId ?? null);
  if (!where.ok) return where;
  if (rootPath !== '') {
    if (!rootPath.startsWith('/')) return err(invalid('目录必须是绝对路径'));
    const route = where.value.route;
    const exists = route === null ? await deps.fs.directoryExists(rootPath) : await remoteExists(deps, route, rootPath);
    if (!exists) return err(invalid(`目录不存在：${rootPath}`));
  }
  const created = createProject({ name: command.name, now: deps.now(), repo: repo.value, description: description.value });
  if (!created.ok) return created;
  let first: Workspace | null = null;
  if (rootPath !== '') {
    const taken = await claimOf(deps, { projectId: created.value.id, workerId: where.value.workerId, path: rootPath });
    if (!taken.ok) return taken;
    // 给了目录：它就是这个项目的第一个持久工作空间（关联已有目录，平台永不删它）
    const linked = newWorkspace({ projectId: created.value.id, workerId: where.value.workerId, path: rootPath, kind: 'long_lived', source: 'linked', now: deps.now() });
    if (!linked.ok) return linked;
    first = linked.value;
  }
  await deps.projects.save(created.value);
  if (first) await deps.workspaces.save(first);
  return ok(created.value);
}

export async function listProjects(deps: Pick<Deps, 'projects'>): Promise<Result<Project[], DomainError>> {
  return ok(await deps.projects.list());
}

export async function loadProject(
  deps: Pick<Deps, 'projects'>,
  projectId: Project['id']
): Promise<Result<Project, DomainError>> {
  const project = await deps.projects.byId(projectId);
  return project ? ok(project) : err(notFound('项目不存在'));
}



export interface DirectoryListing {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly DirectoryEntry[];
  readonly workerId: string | null;
  /** 这台机器允许浏览的根（面包屑的起点，不能往上越过）。 */
  readonly roots: readonly string[];
  /** 当前项目的托管目录 `<roots[0]>/agent-hub/<slug>`（给了项目名才有）；不一定已存在。 */
  readonly managed: string | null;
}

/**
 * 目录选择器：在「项目要绑的那台机器」上浏览。
 * `path` 为空时从那台机器的起点开始（Server 本机由 `home` 给，remote Worker 由它自己的 roots[0] 给）。
 */
export async function browseDirectories(
  deps: Pick<Deps, 'fs' | 'gateway'>,
  input: { readonly workerId: string | null; readonly path: string; readonly home: string; readonly project?: string }
): Promise<Result<DirectoryListing, DomainError>> {
  const owner = await directoryOwner(deps, input.workerId);
  if (!owner.ok) return owner;
  const roots = await rootsOf(deps, owner.value, input.workerId, input.home);
  const slug = input.project ? projectSlug(input.project) : null;
  const managed = slug === null ? null : managedDirectory(roots, slug);
  // 没指定路径：优先从项目托管目录开始，没有就退到 <root>/agent-hub，再退到 root
  const candidates =
    input.path !== ''
      ? [normalize(input.path)]
      : [...(managed ? [managed, parentOf(managed) ?? ''] : []), roots[0] ?? ''].filter((c) => c !== '');
  if (candidates.length === 0) candidates.push('');
  let lastError: DomainError | null = null;
  for (const candidate of candidates) {
    const listed = await listOn(deps, owner.value, candidate);
    if (!listed.ok) {
      lastError = listed.error;
      continue;
    }
    if (listed.value === null) continue;
    const path = listed.value.path;
    const atRoot = roots.some((root) => normalize(root) === path) || path === '/';
    return ok({
      path,
      parent: atRoot ? null : parentOf(path),
      entries: sortRecentFirst(listed.value.entries),
      workerId: owner.value,
      roots,
      managed
    });
  }
  if (lastError) return err(lastError);
  return err(notFound(`没有这个目录：${input.path || candidates[candidates.length - 1]}`));
}




/** 最近改过的排前面（时间相同按名字）：刚建的、刚用过的项目目录最可能是要找的。 */
function sortRecentFirst(entries: readonly DirectoryEntry[]): DirectoryEntry[] {
  return [...entries].sort(
    (left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0) || left.name.localeCompare(right.name)
  );
}



/** 绑定 / 改 / 解除项目仓库（url 为空 = 解除）。只影响以后新建的工作空间，已有的不动。 */
export async function setProjectRepoUseCase(
  deps: Pick<Deps, 'projects'>,
  command: { readonly projectId: string; readonly repoUrl: string | null; readonly defaultBranch?: string | null }
): Promise<Result<Project, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));
  const repo = parseRepo(command.repoUrl, command.defaultBranch);
  if (!repo.ok) return repo;
  const next: Project = { ...project, repo: repo.value };
  await deps.projects.save(next);
  return ok(next);
}

/** 改项目说明（空 = 清掉）。 */
export async function setProjectDescriptionUseCase(
  deps: Pick<Deps, 'projects'>,
  command: { readonly projectId: string; readonly description: string | null }
): Promise<Result<Project, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));
  const description = normalizeDescription(command.description);
  if (!description.ok) return description;
  const next: Project = { ...project, description: description.value };
  await deps.projects.save(next);
  return ok(next);
}
