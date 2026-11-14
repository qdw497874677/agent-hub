import type { ProjectId, WorkspaceGroup, WorkspaceGroupId } from '../index.ts';

/** 组合工作空间的仓储（docs/design/multi-repo.md §11.1）。成员是 workspaces 表里的行，这里只存归属。 */
export interface WorkspaceGroupRepository {
  byId(id: WorkspaceGroupId): Promise<WorkspaceGroup | null>;
  /** 新→旧。 */
  listByProject(projectId: ProjectId): Promise<readonly WorkspaceGroup[]>;
  save(group: WorkspaceGroup): Promise<void>;
  /** 只删组与成员归属，不删成员自己的工作空间行。 */
  remove(id: WorkspaceGroupId): Promise<void>;
}
