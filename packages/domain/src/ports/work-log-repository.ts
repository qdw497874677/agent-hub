import type { TaskId } from '../ids.ts';
import type { WorkLogDraft, WorkLogEntry } from '../work-log.ts';

export interface WorkLogQuery {
  /** 只要 seq 小于它的（倒序翻页）。 */
  readonly beforeSeq?: number;
  readonly limit: number;
  /** 只要人/agent 写的（不含系统条目）。 */
  readonly excludeSystem?: boolean;
  /** 包含已被修订的旧版本（编辑历史）。 */
  readonly includeSuperseded?: boolean;
}

/** 工作日志仓储：只追加。seq 由实现原子分配（任务内单调递增）。 */
export interface WorkLogRepository {
  append(draft: WorkLogDraft): Promise<WorkLogEntry>;
  byId(id: string): Promise<WorkLogEntry | null>;
  /** 倒序（新的在前）。 */
  list(taskId: TaskId, query: WorkLogQuery): Promise<WorkLogEntry[]>;
  /** 最近一条未被修订的、人或 agent 写的日志（「当前进展」和新会话背景的来源）。 */
  latestNote(taskId: TaskId): Promise<WorkLogEntry | null>;
}
