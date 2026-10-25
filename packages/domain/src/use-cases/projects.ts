import { createProject } from '../project.ts';
import type { Project } from '../project.ts';
import type { DomainError } from '../errors.ts';
import { notFound } from '../errors.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import type { Deps } from './deps.ts';

export interface CreateProjectCommand {
  readonly name: string;
  readonly rootPath: string;
}

export async function createProjectUseCase(
  deps: Pick<Deps, 'fs' | 'now' | 'projects'>,
  command: CreateProjectCommand
): Promise<Result<Project, DomainError>> {
  const directoryExists = await deps.fs.directoryExists(command.rootPath);
  const created = createProject({
    name: command.name,
    rootPath: command.rootPath,
    directoryExists,
    now: deps.now()
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
