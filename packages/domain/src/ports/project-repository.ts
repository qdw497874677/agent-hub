import type { ProjectId } from '../ids.ts';
import type { Project } from '../project.ts';

export interface ProjectRepository {
  save(project: Project): Promise<void>;
  byId(id: ProjectId): Promise<Project | null>;
  list(): Promise<Project[]>;
}
