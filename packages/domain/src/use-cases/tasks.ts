import { createTask, setTaskStatus, type StatusActor } from '../task.ts';
import { recordSystemLog } from './work-log.ts';
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
  readonly ownerId?: string | null;
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
    ownerId: command.ownerId ?? null,
    now: deps.now()
  });
  if (!created.ok) return created;
  await deps.tasks.save(created.value);
  return ok(created.value);
}

export async function setTaskStatusUseCase(
  deps: Pick<Deps, 'now' | 'tasks' | 'workLog'>,
  taskId: TaskId,
  status: TaskStatus,
  actor: StatusActor = 'user',
  note?: string
): Promise<Result<Task, DomainError>> {
  const task = await deps.tasks.byId(taskId);
  if (!task) return err(notFound('任务不存在'));
  const changed = setTaskStatus(task, status, deps.now(), actor);
  if (!changed.ok) return changed;
  if (changed.value === task) return ok(task);
  await deps.tasks.save(changed.value);
  const who = actor === 'agent' ? 'agent' : actor === 'system' ? '系统' : '人';
  await recordSystemLog(deps, taskId, 'status_change', `${who}把状态从 ${task.status} 改为 ${status}${note ? `：${note}` : ''}`);
  // 系统日志会推进 logSeq：返回最新的任务
  return ok((await deps.tasks.byId(taskId)) ?? changed.value);
}
