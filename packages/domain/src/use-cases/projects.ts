import { createProject } from '../project.ts';
import type { Project } from '../project.ts';
import type { DomainError } from '../errors.ts';
import { invalid, notFound } from '../errors.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import type { Deps } from './deps.ts';
import type { DirectoryEntry } from '../ports/workspace-fs.ts';
import { folderNameProblem, insideRoots, managedDirectory, projectSlug } from '../directories.ts';

export interface CreateProjectCommand {
  readonly name: string;
  readonly rootPath: string;
  /** 目录在哪台 Worker 上。不给 / 给的是本机 Worker = 和 Server 同机。 */
  readonly workerId?: string | null;
}

export async function createProjectUseCase(
  deps: Pick<Deps, 'fs' | 'now' | 'projects' | 'gateway'>,
  command: CreateProjectCommand
): Promise<Result<Project, DomainError>> {
  const where = await directoryOwner(deps, command.workerId ?? null);
  if (!where.ok) return where;
  const directoryExists =
    where.value === null
      ? await deps.fs.directoryExists(command.rootPath)
      : await remoteExists(deps, where.value, command.rootPath);
  const created = createProject({
    name: command.name,
    rootPath: command.rootPath,
    directoryExists,
    now: deps.now(),
    workerId: where.value
  });
  if (!created.ok) return created;
  await deps.projects.save(created.value);
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

/**
 * 目录属于谁：null = Server 自己的文件系统（同机的 local Worker 也算这里），
 * 否则是那台 remote Worker。之所以把 local Worker 折叠成 null：
 * 本机 Worker 每次重启可能换 id，老项目不该因此「搬家」。
 */
export async function directoryOwner(
  deps: Pick<Deps, 'gateway'>,
  workerId: string | null
): Promise<Result<string | null, DomainError>> {
  if (workerId === null) return ok(null);
  const worker = (await deps.gateway.status()).find((candidate) => candidate.workerId === workerId);
  if (!worker) return err(notFound(`没有这台 Worker：${workerId}`));
  return ok(worker.origin === 'local' ? null : worker.workerId);
}

async function remoteExists(deps: Pick<Deps, 'gateway'>, workerId: string, path: string): Promise<boolean> {
  const listed = await deps.gateway.listDirectories(workerId, path);
  return listed.ok && listed.value.exists;
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

/** 在 parent 下新建一层文件夹，返回新目录。名字只允许一段；边界和软链接由适配器用 realpath 把关。 */
export async function createDirectory(
  deps: Pick<Deps, 'fs' | 'gateway'>,
  input: { readonly workerId: string | null; readonly parent: string; readonly name: string; readonly home: string }
): Promise<Result<{ readonly path: string }, DomainError>> {
  const problem = folderNameProblem(input.name);
  if (problem !== null) return err(invalid(problem));
  if (!input.parent.startsWith('/') || input.parent.split('/').includes('..')) return err(invalid('父目录必须是绝对路径'));
  const owner = await directoryOwner(deps, input.workerId);
  if (!owner.ok) return owner;
  const parent = normalize(input.parent);
  if (owner.value !== null) return deps.gateway.makeDirectory(owner.value, parent, input.name);
  const roots = await rootsOf(deps, null, input.workerId, input.home);
  if (!insideRoots(parent, roots)) return err(invalid(`「${parent}」不在允许新建文件夹的目录里（${roots.join(':')}）`));
  const made = await deps.fs.makeDirectory(parent, input.name, roots);
  return made.ok ? ok({ path: made.value }) : made;
}

/** 本机（null）用本机 Worker 报上来的 roots，没有就是 home；remote 用它自己的 roots。 */
async function rootsOf(
  deps: Pick<Deps, 'gateway'>,
  owner: string | null,
  requested: string | null,
  home: string
): Promise<readonly string[]> {
  const workers = await deps.gateway.status();
  const worker =
    owner !== null
      ? workers.find((w) => w.workerId === owner)
      : workers.find((w) => w.workerId === requested) ?? workers.find((w) => w.origin === 'local');
  const roots = (worker?.roots ?? []).map(normalize);
  return roots.length > 0 ? roots : [normalize(home)];
}

async function listOn(
  deps: Pick<Deps, 'fs' | 'gateway'>,
  owner: string | null,
  path: string
): Promise<Result<{ path: string; entries: readonly DirectoryEntry[] } | null, DomainError>> {
  if (owner === null) {
    if (!(await deps.fs.directoryExists(path))) return ok(null);
    return ok({ path, entries: await deps.fs.listDirectories(path) });
  }
  const listed = await deps.gateway.listDirectories(owner, path);
  if (!listed.ok) return listed;
  return listed.value.exists ? ok({ path: listed.value.path, entries: listed.value.entries }) : ok(null);
}

/** 最近改过的排前面（时间相同按名字）：刚建的、刚用过的项目目录最可能是要找的。 */
function sortRecentFirst(entries: readonly DirectoryEntry[]): DirectoryEntry[] {
  return [...entries].sort(
    (left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0) || left.name.localeCompare(right.name)
  );
}

/** 纯字符串的 POSIX 规范化：领域层不碰 node:path。 */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function parentOf(path: string): string | null {
  if (path === '/') return null;
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}
