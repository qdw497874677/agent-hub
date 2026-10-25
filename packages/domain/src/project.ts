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
  readonly createdAt: number;
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
    createdAt: input.now
  });
}
