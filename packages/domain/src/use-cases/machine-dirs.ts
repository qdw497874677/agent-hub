import type { DomainError } from '../errors.ts';
import { conflict, invalid, notFound } from '../errors.ts';
import type { ProjectId } from '../ids.ts';
import { claimedByOther } from '../workspace.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import type { Deps } from './deps.ts';
import type { DirectoryEntry } from '../ports/workspace-fs.ts';
import type { WorkspaceGit } from '../ports/workspace-git.ts';
import { folderNameProblem, insideRoots } from '../directories.ts';

/** 「某台机器上的目录」这一层：本机走 Server 的 fs，remote 走网关。项目和工作空间用例共用。 */

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

/**
 * 一台机器的两种身份，别混用：
 * - `workerId`：记账用的真实 Worker id（本机也记它自己的 id；没有本机 Worker 时才是 null）；
 * - `route`：干活走哪条路——null = Server 自己的 fs / git（本机 Worker 同机，直接做），否则走网关。
 */
export interface Machine {
  readonly workerId: string | null;
  readonly route: string | null;
}

/** 人选的机器（null = 本机）→ 记账 id + 干活通道。不认识的 id 报 notFound。 */
export async function resolveMachine(deps: Pick<Deps, 'gateway'>, requested: string | null): Promise<Result<Machine, DomainError>> {
  const workers = await deps.gateway.status();
  if (requested === null) return ok({ workerId: workers.find((worker) => worker.origin === 'local')?.workerId ?? null, route: null });
  const worker = workers.find((candidate) => candidate.workerId === requested);
  if (!worker) return err(notFound(`没有这台 Worker：${requested}`));
  return ok({ workerId: worker.workerId, route: worker.origin === 'local' ? null : worker.workerId });
}

/** 已记下的 workerId → 干活通道。本机（或老数据的 null）走 Server 自己；不在线的 remote 照样给 id，由网关报错。 */
export async function routeOf(deps: Pick<Deps, 'gateway'>, workerId: string | null): Promise<string | null> {
  if (workerId === null) return null;
  const worker = (await deps.gateway.status()).find((candidate) => candidate.workerId === workerId);
  return worker?.origin === 'local' ? null : workerId;
}

/** 已记下的 workerId 那台机器上的 git 操作。 */
export async function gitFor(deps: Pick<Deps, 'git' | 'gateway'>, workerId: string | null): Promise<WorkspaceGit> {
  return gitOn(deps, await routeOf(deps, workerId));
}

export async function remoteExists(deps: Pick<Deps, 'gateway'>, workerId: string, path: string): Promise<boolean> {
  const listed = await deps.gateway.listDirectories(workerId, path);
  return listed.ok && listed.value.exists;
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
export async function rootsOf(
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

export async function listOn(
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

/** 纯字符串的 POSIX 规范化：领域层不碰 node:path。 */
export function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function parentOf(path: string): string | null {
  if (path === '/') return null;
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

/** 目录主人（directoryOwner 的结果）那台机器上的 git 操作。 */
export function gitOn(deps: Pick<Deps, 'git' | 'gateway'>, owner: string | null): WorkspaceGit {
  return owner === null ? deps.git : deps.gateway.git(owner);
}

/** 「一个目录最多属于一个项目」：被别的项目（含上下级目录）占了就拒绝，告诉人是哪个项目。 */
export async function claimOf(
  deps: Pick<Deps, 'projects' | 'workspaces'>,
  place: { readonly projectId: ProjectId; readonly workerId: string | null; readonly path: string }
): Promise<Result<null, DomainError>> {
  const other = claimedByOther(place, await deps.workspaces.onMachine(place.workerId));
  if (!other) return ok(null);
  const owner = await deps.projects.byId(other.projectId);
  return err(conflict(`这个目录已经属于项目「${owner?.name ?? '另一个项目'}」（${other.path}），一个目录只能属于一个项目`));
}

