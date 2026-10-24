import type { ArtifactId, SessionId, TaskId } from './ids.ts';
import { newArtifactId } from './ids.ts';
import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/** 产出物。挂在 Session 上，同时能被 Task 汇总（S7.2 两个方向都能看到）。 */
export interface Artifact {
  readonly id: ArtifactId;
  readonly sessionId: SessionId;
  readonly taskId: TaskId;
  readonly path: string;
  readonly bytes: number;
  readonly label: string;
  readonly createdAt: number;
}

export interface CreateArtifactInput {
  readonly sessionId: SessionId;
  readonly taskId: TaskId;
  readonly path: string;
  readonly bytes: number;
  readonly now: number;
  readonly id?: ArtifactId;
}

export function createArtifact(input: CreateArtifactInput): Result<Artifact, DomainError> {
  const path = input.path.trim();
  if (!path) return err(invalid('产出物路径不能为空'));
  if (!Number.isFinite(input.bytes) || input.bytes < 0) return err(invalid('产出物大小不合法'));
  return ok({
    id: input.id ?? newArtifactId(),
    sessionId: input.sessionId,
    taskId: input.taskId,
    path,
    bytes: input.bytes,
    label: path.split('/').pop() ?? path,
    createdAt: input.now
  });
}
