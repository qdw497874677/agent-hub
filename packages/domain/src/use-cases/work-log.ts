import { randomUUID } from 'node:crypto';
import type { TaskId, SessionId } from '../ids.ts';
import type { Task } from '../task.ts';
import { forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import {
  draftLogEntry,
  summaryFromBody,
  type LogAuthor,
  type LogLink,
  type WorkLogEntry
} from '../work-log.ts';
import type { Deps } from './deps.ts';

export interface AppendLogCommand {
  readonly taskId: TaskId;
  readonly author: LogAuthor;
  readonly body: string;
  readonly links?: readonly LogLink[];
  readonly sessionId?: SessionId | null;
  readonly supersedes?: string | null;
}

export interface AppendLogResult {
  readonly entry: WorkLogEntry;
  readonly task: Task;
}

/** 追加一条日志：仓储分配 seq；任务 logSeq 跟进；人/agent 写的顺带刷新「当前进展」（系统条目不刷）。 */
export async function appendWorkLogUseCase(
  deps: Pick<Deps, 'now' | 'tasks' | 'workLog'>,
  command: AppendLogCommand
): Promise<Result<AppendLogResult, DomainError>> {
  const task = await deps.tasks.byId(command.taskId);
  if (!task) return err(notFound('任务不存在'));
  const now = deps.now();
  const draft = draftLogEntry({ id: randomUUID(), now, ...command });
  if (!draft.ok) return draft;
  const entry = await deps.workLog.append(draft.value);
  const fresh = (await deps.tasks.byId(command.taskId)) ?? task;
  const updated: Task = {
    ...fresh,
    logSeq: Math.max(fresh.logSeq, entry.seq),
    summary: entry.author.kind !== 'system' ? summaryFromBody(entry.body) || fresh.summary : fresh.summary,
    updatedAt: now
  };
  await deps.tasks.save(updated);
  return ok({ entry, task: updated });
}

/** 修订一条日志：只有人能改，且只能改人写的；实质是追加新版本。 */
export async function editWorkLogUseCase(
  deps: Pick<Deps, 'now' | 'tasks' | 'workLog'>,
  command: { readonly entryId: string; readonly body: string; readonly author: LogAuthor }
): Promise<Result<AppendLogResult, DomainError>> {
  if (command.author.kind !== 'user') return err(forbidden('只有人能修订日志'));
  const previous = await deps.workLog.byId(command.entryId);
  if (!previous) return err(notFound('日志不存在'));
  if (previous.author.kind !== 'user') return err(forbidden('只能修订人写的日志'));
  if (previous.supersededBy) return err(invalid('这条已被修订过，请修订最新版本'));
  return appendWorkLogUseCase(deps, {
    taskId: previous.taskId,
    author: command.author,
    body: command.body,
    links: previous.links,
    sessionId: previous.sessionId,
    supersedes: previous.id
  });
}

/** 系统事件日志：失败不影响主流程（日志是记录，不是闸门）。 */
export async function recordSystemLog(
  deps: Pick<Deps, 'now' | 'tasks' | 'workLog'>,
  taskId: TaskId,
  body: string,
  sessionId: SessionId | null = null
): Promise<void> {
  try {
    await appendWorkLogUseCase(deps, { taskId, author: { kind: 'system' }, body, sessionId });
  } catch {
    // 日志写失败不阻断状态迁移/会话启动
  }
}
