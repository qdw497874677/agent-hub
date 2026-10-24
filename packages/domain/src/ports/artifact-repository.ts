import type { SessionId, TaskId } from '../ids.ts';
import type { Artifact } from '../artifact.ts';

export interface ArtifactRepository {
  save(artifact: Artifact): Promise<void>;
  bySession(sessionId: SessionId): Promise<Artifact[]>;
  byTask(taskId: TaskId): Promise<Artifact[]>;
}
