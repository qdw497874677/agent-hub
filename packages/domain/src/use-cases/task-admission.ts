import { conflict, notFound, type DomainError } from '../errors.ts';
import type { TaskId } from '../ids.ts';
import type { TaskGate } from '../ports/task-gate.ts';
import type { TaskRepository } from '../ports/task-repository.ts';
import { err, type Result } from '../result.ts';

export async function withActiveTask<T>(
  deps: { readonly taskGate?: TaskGate; readonly tasks: Pick<TaskRepository, 'byId'> },
  taskId: TaskId | null,
  action: () => Promise<Result<T, DomainError>>
): Promise<Result<T, DomainError>> {
  if (taskId === null) return action();
  const leave = deps.taskGate?.enter(taskId);
  if (leave === null) return err(conflict('任务正在归档或恢复，请重试'));
  try {
    const task = await deps.tasks.byId(taskId);
    if (task === null) return err(notFound('任务不存在'));
    if (task.archivedAt != null) return err(conflict('任务已归档，请恢复后再继续'));
    return await action();
  } finally {
    leave?.();
  }
}
