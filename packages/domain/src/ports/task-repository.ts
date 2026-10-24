import type { ProjectId, TaskId } from '../ids.ts';
import type { Task } from '../task.ts';

export interface TaskRepository {
  save(task: Task): Promise<void>;
  byId(id: TaskId): Promise<Task | null>;
  listByProject(projectId: ProjectId): Promise<Task[]>;
}
