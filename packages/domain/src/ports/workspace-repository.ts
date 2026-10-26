import type { ProjectId, TaskId, WorkspaceId } from '../ids.ts';
import type { Workspace } from '../workspace.ts';

export interface WorkspaceRepository {
  save(workspace: Workspace): Promise<void>;
  byId(id: WorkspaceId): Promise<Workspace | null>;
  /** 项目名下的全部登记（含 removed，调用方自己筛）。 */
  byProject(projectId: ProjectId): Promise<Workspace[]>;
  byTask(taskId: TaskId): Promise<Workspace[]>;
  /** 所有还没 removed 的临时工作空间——清理扫描用。 */
  temporaries(): Promise<Workspace[]>;
}
