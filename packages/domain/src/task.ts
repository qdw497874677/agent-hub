import type { ProjectId, TaskId } from './ids.ts';
import { newTaskId } from './ids.ts';
import { conflict, invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * 三类状态。`abandoned` 是死路记录，**不隐藏也不删除**（S4.2）：
 * 知道哪些路试过没走通，本身就是产品的价值。
 */
export type TaskStatus = 'open' | 'done' | 'abandoned';

export interface Task {
  readonly id: TaskId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly goal: string | null;
  readonly status: TaskStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateTaskInput {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly goal?: string;
  readonly now: number;
  readonly id?: TaskId;
}

export function createTask(input: CreateTaskInput): Result<Task, DomainError> {
  const title = input.title.trim();
  if (!title) return err(invalid('任务标题不能为空'));
  return ok({
    id: input.id ?? newTaskId(),
    projectId: input.projectId,
    title,
    goal: input.goal?.trim() || null,
    status: 'open',
    createdAt: input.now,
    updatedAt: input.now
  });
}

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  open: ['done', 'abandoned'],
  done: ['open'],
  abandoned: ['open']
};

export function setTaskStatus(
  task: Task,
  status: TaskStatus,
  now: number
): Result<Task, DomainError> {
  if (task.status === status) return ok(task);
  if (!TRANSITIONS[task.status].includes(status)) {
    return err(conflict(`任务不能从 ${task.status} 变为 ${status}`));
  }
  return ok({ ...task, status, updatedAt: now });
}

export function isAbandoned(task: Task): boolean {
  return task.status === 'abandoned';
}
