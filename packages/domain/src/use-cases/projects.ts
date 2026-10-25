import { createProject } from '../project.ts';
import type { Project } from '../project.ts';
import type { DomainError } from '../errors.ts';
import { notFound } from '../errors.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import type { Deps } from './deps.ts';
import type { DirectoryEntry } from '../ports/workspace-fs.ts';

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
}

/**
 * 目录选择器：在「项目要绑的那台机器」上浏览。
 * `path` 为空时从那台机器的起点开始（Server 本机由 `home` 给，remote Worker 由它自己的 roots[0] 给）。
 */
export async function browseDirectories(
  deps: Pick<Deps, 'fs' | 'gateway'>,
  input: { readonly workerId: string | null; readonly path: string; readonly home: string }
): Promise<Result<DirectoryListing, DomainError>> {
  const owner = await directoryOwner(deps, input.workerId);
  if (!owner.ok) return owner;
  if (owner.value === null) {
    const path = input.path === '' ? input.home : normalize(input.path);
    if (!(await deps.fs.directoryExists(path))) return err(notFound(`没有这个目录：${path}`));
    return ok({ path, parent: parentOf(path), entries: await deps.fs.listDirectories(path), workerId: null });
  }
  const listed = await deps.gateway.listDirectories(owner.value, input.path === '' ? '' : normalize(input.path));
  if (!listed.ok) return listed;
  if (!listed.value.exists) return err(notFound(`那台 Worker 上没有这个目录：${input.path}`));
  const path = listed.value.path;
  // 到了那台 Worker 的 WORKER_ROOTS 边界就不再给「上一级」：往上走只会撞到拒绝
  const worker = (await deps.gateway.status()).find((w) => w.workerId === owner.value);
  const atRoot = (worker?.roots ?? []).some((root) => normalize(root) === path);
  return ok({ path, parent: atRoot ? null : parentOf(path), entries: listed.value.entries, workerId: owner.value });
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
