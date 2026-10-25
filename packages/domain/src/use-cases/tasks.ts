import { createTask, setTaskStatus } from '../task.ts';
import type { Task, TaskStatus } from '../task.ts';
import type { TaskId } from '../ids.ts';
import { asProjectId } from '../ids.ts';
import { notFound } from '../errors.ts';
import type { DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';

export interface CreateTaskCommand {
  readonly projectId: string;
  readonly title: string;
  readonly goal?: string;
}

export async function createTaskUseCase(
  deps: Pick<Deps, 'now' | 'projects' | 'tasks'>,
  command: CreateTaskCommand
): Promise<Result<Task, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));
  const created = createTask({
    projectId: project.id,
    title: command.title,
    goal: command.goal,
    now: deps.now()
  });
  if (!created.ok) return created;
  await deps.tasks.save(created.value);
  return ok(created.value);
}

export async function setTaskStatusUseCase(
  deps: Pick<Deps, 'now' | 'tasks'>,
  taskId: TaskId,
  status: TaskStatus
): Promise<Result<Task, DomainError>> {
  const task = await deps.tasks.byId(taskId);
  if (!task) return err(notFound('任务不存在'));
  const changed = setTaskStatus(task, status, deps.now());
  if (!changed.ok) return changed;
  await deps.tasks.save(changed.value);
  return ok(changed.value);
}
