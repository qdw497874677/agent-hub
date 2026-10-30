import type { ProjectId } from '../ids.ts';
import type { Project } from '../project.ts';

export interface ProjectRepository {
  save(project: Project): Promise<void>;
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
