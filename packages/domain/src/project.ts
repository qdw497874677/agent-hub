import type { ProjectId } from './ids.ts';
import { newProjectId } from './ids.ts';
import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/** Project 是作用域容器：绑定一个本地目录，没有领域行为。见 GLOSSARY。 */
export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly rootPath: string;
  readonly createdAt: number;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly rootPath: string;
  /** 由 WorkspaceFS 提供：目录是否存在。领域层不做 I/O。 */
  readonly directoryExists: boolean;
  readonly now: number;
  readonly id?: ProjectId;
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
    createdAt: input.now
  });
}
