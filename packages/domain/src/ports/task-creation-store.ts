import type { ProjectId, SessionId, TaskId } from '../ids.ts';
import type { Task } from '../task.ts';

/** 原子创建的结果：首次创建、同键同参回放、同键异参冲突。 */
export type TaskCreationOutcome =
  | { readonly status: 'created'; readonly task: Task }
  | { readonly status: 'replayed'; readonly task: Task }
  | { readonly status: 'conflict' };

/**
 * 带持久回执的任务创建（docs/design/project-session-mcp.md）。
 *
 * 创建任务和写回执必须在同一个事务里：要么任务 + 回执都落库，要么都不落。
 * 端口只暴露「原子创建 + 按父任务查询」，不把存储细节漏给用例。
 */
export interface TaskCreationStore {
  /**
   * 先看键：已有回执且指纹相同 → 回放原任务；指纹不同 → 冲突（不覆盖、不重跑）。
   * 没有回执 → 同一事务里写回执、插任务。
   */
  createWithReplay(intent: {
    readonly key: string;
    readonly fingerprint: string;
    readonly actorId: string;
    readonly sourceSessionId: SessionId | null;
    readonly projectId: ProjectId;
    readonly operation: string;
    readonly task: Task;
  }): Promise<TaskCreationOutcome>;

  /** 同一项目内某个任务的直接子任务（创建顺序）。旧任务无父级，不会被查出来。 */
  listByParent(projectId: ProjectId, parentTaskId: TaskId): Promise<Task[]>;
}
