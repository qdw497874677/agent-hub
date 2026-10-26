import type { ProjectId } from './ids.ts';
import { newProjectId } from './ids.ts';
import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/** Project 是作用域容器：绑定一个本地目录，没有领域行为。见 GLOSSARY。 */
export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly rootPath: string;
  /** 目录在哪台 Worker 的文件系统上。null = 和 Server 同机（多机之前的老项目都是）。 */
  readonly workerId: string | null;
  /**
   * 同一份代码在别的 Worker 上的目录（workerId → 绝对路径）。
   * 只有「换台机器继续」时才会登记；会话落在哪台就用哪台的目录。
   */
  readonly directories: Readonly<Record<string, string>>;
  readonly createdAt: number;
}

/** 一条会话真正干活的地方：哪台机器（null = Server 本机的文件系统）+ 哪个目录。 */
export interface Location {
  readonly workerId: string | null;
  readonly root: string;
}

/** 会话落在映射过的那台 Worker 上就用那台的目录，否则用项目自己的目录。 */
export function workspaceFor(project: Project, sessionWorker: string | null): Location {
  const mapped = sessionWorker !== null && sessionWorker !== project.workerId ? project.directories[sessionWorker] : undefined;
  const ws = mapped !== undefined ? { workerId: sessionWorker, root: mapped } : { workerId: project.workerId, root: project.rootPath };
  return { workerId: ws.workerId, root: ws.root.replace(/\/+$/, '') || '/' };
}

export interface CreateProjectInput {
  readonly name: string;
  readonly rootPath: string;
  /** 由 WorkspaceFS 提供：目录是否存在。领域层不做 I/O。 */
  readonly directoryExists: boolean;
  readonly now: number;
  readonly id?: ProjectId;
  readonly workerId?: string | null;
}

export function createProject(input: CreateProjectInput): Result<Project, DomainError> {
  const name = input.name.trim();
  if (!name) return err(invalid('项目名称不能为空'));
  if (!input.rootPath.startsWith('/')) return err(invalid('目录必须是绝对路径'));
  if (!input.directoryExists) return err(invalid(`目录不存在：${input.rootPath}`));
  return ok({
    id: input.id ?? newProjectId(),
    name,
    rootPath: input.rootPath,
    workerId: input.workerId ?? null,
    directories: {},
    createdAt: input.now
  });
}
