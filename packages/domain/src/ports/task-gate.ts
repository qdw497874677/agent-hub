import type { TaskId } from '../ids.ts';

/** Single-Hub admission: work may overlap work, never an archive decision. */
export interface TaskGate {
  enter(taskId: TaskId): (() => void) | null;
  exclusive(taskId: TaskId): (() => void) | null;
}
