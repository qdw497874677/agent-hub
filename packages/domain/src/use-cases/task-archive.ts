import { conflict, notFound, unavailable, type DomainError } from '../errors.ts';
import type { TaskId } from '../ids.ts';
import { err, ok, type Result } from '../result.ts';
import type { Task } from '../task.ts';
import type { Deps } from './deps.ts';
import { turnInProgress } from './delivery.ts';
import { recordSystemLog } from './work-log.ts';

export type TaskArchiveBlocker = 'dispatch' | 'delegation' | 'publish';
export type TaskArchiveBlockers = (taskId: TaskId) => Promise<TaskArchiveBlocker | null>;

const BLOCKER_MESSAGE: Record<TaskArchiveBlocker, string> = {
  dispatch: '任务还有排队或运行中的调度，请先处理',
  delegation: '任务还有待确认、准备中或结果未确认的派工，请先处理',
  publish: '任务还有进行中或结果未确认的发布，请先处理'
};

export async function setTaskArchivedUseCase(
  deps: Pick<Deps, 'tasks' | 'taskGate' | 'sessions' | 'deliveries' | 'now' | 'workLog'>,
  blockers: TaskArchiveBlockers,
  taskId: TaskId,
  archived: boolean,
  actorLabel = ''
): Promise<Result<Task, DomainError>> {
  if (!deps.taskGate || !deps.deliveries) return err(unavailable('任务归档暂不可用'));
  const leave = deps.taskGate.exclusive(taskId);
  if (!leave) return err(conflict('任务正在处理其他操作，请稍后重试'));
  try {
    const task = await deps.tasks.byId(taskId);
    if (!task) return err(notFound('任务不存在'));
    const current = task.archivedAt ?? null;
    if (archived === (current !== null)) return ok(task);
    if (archived) {
      const blocker = await blockers(taskId);
      if (blocker) return err(conflict(BLOCKER_MESSAGE[blocker]));
      for (const session of await deps.sessions.listByTask(taskId)) {
        if ((await deps.deliveries.pendingFor(session.id)).length > 0) {
          return err(conflict('任务下还有排队、发送中或未送达的消息，请先处理'));
        }
        if (await turnInProgress(deps, session.id)) {
          return err(conflict('任务下还有会话在运行或回合结果未确认，请先处理'));
        }
      }
    }
    const archivedAt = archived ? deps.now() : null;
    if (!await deps.tasks.setArchived(taskId, archivedAt, current)) {
      return err(conflict('任务归档状态已变化，请刷新后重试'));
    }
    await recordSystemLog(deps, taskId, `${actorLabel || '人'}${archived ? '归档了任务' : '恢复了任务'}`);
    return ok((await deps.tasks.byId(taskId)) ?? { ...task, archivedAt });
  } finally {
    leave();
  }
}
