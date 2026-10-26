import { createTask, setTaskStatus, TASK_STATUS_LABEL, type StatusActor } from '../task.ts';
import { recordSystemLog } from './work-log.ts';
import type { Task, TaskStatus } from '../task.ts';
import type { SessionId, TaskId } from '../ids.ts';
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
  note?: string,
  /** 谁改的，写进系统日志：agent 给「运行时（模型）」并关联会话，人给显示名。不给就只写「agent / 人 / 系统」。 */
  by?: { readonly label: string; readonly sessionId?: SessionId | null }
): Promise<Result<Task, DomainError>> {
  const task = await deps.tasks.byId(taskId);
  if (!task) return err(notFound('任务不存在'));
  const changed = setTaskStatus(task, status, deps.now(), actor);
  if (!changed.ok) return changed;
  if (changed.value === task) return ok(task);
  await deps.tasks.save(changed.value);
  const role = actor === 'agent' ? 'agent' : actor === 'system' ? '系统' : '人';
  const who = by?.label ? (actor === 'agent' ? `agent ${by.label} ` : `${by.label} `) : role;
  await recordSystemLog(
    deps,
    taskId,
    `${who}把状态从「${TASK_STATUS_LABEL[task.status]}」改为「${TASK_STATUS_LABEL[status]}」${note ? `：${note}` : ''}`,
    by?.sessionId ?? null
  );
  // 系统日志会推进 logSeq：返回最新的任务
  return ok((await deps.tasks.byId(taskId)) ?? changed.value);
}

/** 手动改「当前进展」那一行（之后再有人/agent 写日志仍会自动刷新它）。空串 = 清空。 */
export async function setTaskSummaryUseCase(
  deps: Pick<Deps, 'now' | 'tasks'>,
  taskId: TaskId,
  summary: string
): Promise<Result<Task, DomainError>> {
  const task = await deps.tasks.byId(taskId);
  if (!task) return err(notFound('任务不存在'));
  const text = summary.trim().slice(0, 500);
  const next: Task = { ...task, summary: text || null, updatedAt: deps.now() };
  await deps.tasks.save(next);
  return ok(next);
}
