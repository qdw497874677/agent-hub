import type { ProjectId } from '../ids.ts';
import type { Project } from '../project.ts';
import type { ProjectWorkspaceLink, Workspace } from '../workspace.ts';
import type { WorkspaceClaim } from './workspace-repository.ts';

export type ProjectWorkspaceClaimOutcome =
  | { status: 'saved'; link: ProjectWorkspaceLink }
  | { status: 'conflict'; owner: ProjectWorkspaceLink }
  | { status: 'ambiguous'; candidates: readonly Workspace[] };

export interface ProjectRepository {
  save(project: Project): Promise<void>;
  /**
   * #233：建项目和认领已有工作空间在同一个 BEGIN IMMEDIATE 里。
   * 冲突 / 历史重复时不写项目，任一步失败都整体回滚（工作空间本身可以保持未认领）。
   */
  saveWithWorkspaceClaim(project: Project, claim: WorkspaceClaim): Promise<ProjectWorkspaceClaimOutcome>;
  byId(id: ProjectId): Promise<Project | null>;
  /** 不含回收站里的。 */
  list(): Promise<Project[]>;
  /** 回收站：软删的项目，最近删的在前。 */
  listDeleted(): Promise<Project[]>;
  /**
   * 彻底删掉（清空回收站用）项目和它名下的全部数据（任务、日志、会话、事件、产物记录、画布布局），同一次提交。
   * 只动库，不碰磁盘上的目录。
   */
  remove(id: ProjectId): Promise<void>;
}
