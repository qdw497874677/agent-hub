import type { ProjectId, TaskId } from '../ids.ts';
import type { Task } from '../task.ts';

export interface TaskRepository {
  /**
   * 整行 upsert。**更新已有行时不写 `archivedAt`**：归档 / 恢复只能走 `setArchived`，
   * 否则归档或恢复之后迟到的旧快照（`archivedAt` 为 null 或旧时间戳）会把状态回滚。
   */
  save(task: Task): Promise<void>;
  /** 只改分支字段（`UPDATE tasks SET branch=? WHERE id=?`）；不整行覆盖，免得并发改的 status 被回滚。 */
  setBranch(taskId: TaskId, branch: string | null): Promise<boolean>;
  /**
   * 归档 / 恢复的唯一写入点，比较并设置（CAS）：
   * 仅当库里当前的 `archivedAt` 仍等于 `expectedArchivedAt` 时才写入 `archivedAt`
   * （null = 恢复；epoch ms = 归档于该时刻），返回这次写入是否落到行上。
   *
   * 调用方应先把读到的当前值作为 expected 传进来：false 表示期望已过期（别处已归档 / 恢复），
   * 需要重新读再决定。相同目标值 + 相同 expected 的重复调用是幂等的（仍然是 true）。
   * 只写归档一列，不碰 status / 摘要 / updatedAt。
   */
  setArchived(taskId: TaskId, archivedAt: number | null, expectedArchivedAt: number | null): Promise<boolean>;
  byId(id: TaskId): Promise<Task | null>;
  /** 不过滤归档：归档只影响展示策略，不藏数据。 */
  listByProject(projectId: ProjectId): Promise<Task[]>;
}
