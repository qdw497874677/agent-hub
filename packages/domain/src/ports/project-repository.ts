import type { ProjectId } from '../ids.ts';
import type { Project } from '../project.ts';

export interface ProjectRepository {
  save(project: Project): Promise<void>;
  byId(id: ProjectId): Promise<Project | null>;
  list(): Promise<Project[]>;
  /**
   * 删掉项目和它名下的全部数据（任务、日志、会话、事件、产物记录、画布布局），同一次提交。
   * 只动库，不碰磁盘上的目录。
   */
  remove(id: ProjectId): Promise<void>;
}
