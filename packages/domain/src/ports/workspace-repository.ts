import type { ProjectId, TaskId, WorkspaceId } from '../ids.ts';
import type { ProjectWorkspaceLink, Workspace } from '../workspace.ts';

export interface WorkspaceRepository {
  /** 第一次保存带 projectId 的长期工作空间时，同时把它关联到那个项目（为项目新建 = 建 + 关联）。 */
  save(workspace: Workspace): Promise<void>;
  byId(id: WorkspaceId): Promise<Workspace | null>;
  /**
   * 项目能用的全部登记（含 removed，调用方自己筛）：关联到它的长期工作空间 + 它自己的临时工作空间（ADR 0026）。
   */
  byProject(projectId: ProjectId): Promise<Workspace[]>;
  byTask(taskId: TaskId): Promise<Workspace[]>;
  /** 所有还没 removed 的临时工作空间——清理扫描用。 */
  temporaries(): Promise<Workspace[]>;
  /** 某台机器（null = 和 Server 同机）上还没 removed 的登记——唯一性检查用。 */
  onMachine(workerId: string | null): Promise<Workspace[]>;
  /** 所有还没 removed 的长期工作空间（团队页，调用方按团队 / 权限筛）。 */
  longLived(): Promise<Workspace[]>;
  /** 关联（幂等）。 */
  link(link: ProjectWorkspaceLink): Promise<void>;
  unlink(projectId: ProjectId, workspaceId: WorkspaceId): Promise<void>;
  /** 这个工作空间关联了哪些项目。 */
  linksOf(workspaceId: WorkspaceId): Promise<ProjectWorkspaceLink[]>;
}
