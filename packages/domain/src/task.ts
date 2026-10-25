import type { ProjectId, TaskId } from './ids.ts';
import { newTaskId } from './ids.ts';
import { conflict, invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * 任务状态机（tasks-and-capabilities.md §2.1）。`abandoned` 是死路记录，**不隐藏也不删除**（S4.2）。
 * 老库的 `open` 在读出时映射：有过会话 → in_progress，否则 → todo（见 storage 迁移）。
 */
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'in_review' | 'done' | 'abandoned';

export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked', 'in_review', 'done', 'abandoned'];

export interface Task {
  readonly id: TaskId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly goal: string | null;
  readonly status: TaskStatus;
  /** 负责人（人）。agent 不当 owner，它是会话。 */
  readonly ownerId: string | null;
  /** git 项目的任务分支（workspaces.md）；首次运行时定下。 */
  readonly branch: string | null;
  /** 「当前进展」一句话：最近一条 handoff 自动刷新，也可手改。 */
  readonly summary: string | null;
  /** 工作日志当前最大序号；追加日志时 +1。 */
  readonly logSeq: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateTaskInput {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly goal?: string;
  readonly ownerId?: string | null;
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
    status: 'todo',
    ownerId: input.ownerId ?? null,
    branch: null,
    summary: null,
    logSeq: 0,
    createdAt: input.now,
    updatedAt: input.now
  });
}

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ['in_progress', 'done', 'abandoned'],
  in_progress: ['blocked', 'in_review', 'done', 'abandoned', 'todo'],
  blocked: ['in_progress', 'abandoned'],
  in_review: ['in_progress', 'done', 'abandoned'],
  done: ['in_progress'],
  abandoned: ['todo']
};

/** agent（经能力层）只能走的迁移：最多到 in_review，done/abandoned 只有人能设（§7 决定 3）。 */
const AGENT_TARGETS: readonly TaskStatus[] = ['in_progress', 'blocked', 'in_review'];

export type StatusActor = 'user' | 'agent' | 'system';

export function setTaskStatus(
  task: Task,
  status: TaskStatus,
  now: number,
  actor: StatusActor = 'user'
): Result<Task, DomainError> {
  if (task.status === status) return ok(task);
  if (actor === 'agent' && !AGENT_TARGETS.includes(status)) {
    return err(conflict(`agent 不能把任务设为 ${status}，只能是 ${AGENT_TARGETS.join(' / ')}`));
  }
  if (!TRANSITIONS[task.status].includes(status)) {
    return err(conflict(`任务不能从 ${task.status} 变为 ${status}`));
  }
  return ok({ ...task, status, updatedAt: now });
}

/** 会话开跑时把 todo 推到 in_progress；其它状态不动。 */
export function markStarted(task: Task, now: number): Task {
  return task.status === 'todo' ? { ...task, status: 'in_progress', updatedAt: now } : task;
}

export function isAbandoned(task: Task): boolean {
  return task.status === 'abandoned';
}

/** 给人看的状态名：日志正文里写中文，不写枚举值。 */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待开始', in_progress: '进行中', blocked: '受阻', in_review: '待验收', done: '已收尾', abandoned: '已放弃'
};
