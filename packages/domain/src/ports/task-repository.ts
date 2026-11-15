import type { ProjectId, TaskId } from '../ids.ts';
import type { Task } from '../task.ts';

export interface TaskRepository {
  save(task: Task): Promise<void>;
  /** 只改分支字段（`UPDATE tasks SET branch=? WHERE id=?`）；不整行覆盖，免得并发改的 status 被回滚。 */
  setBranch(taskId: TaskId, branch: string | null): Promise<boolean>;
  byId(id: TaskId): Promise<Task | null>;
  listByProject(projectId: ProjectId): Promise<Task[]>;
}
