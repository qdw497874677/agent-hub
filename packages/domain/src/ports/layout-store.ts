import type { ProjectId } from '../ids.ts';
import type { CanvasLayout } from '../canvas.ts';

export interface LayoutStore {
  load(projectId: ProjectId): Promise<CanvasLayout | null>;
  save(layout: CanvasLayout): Promise<void>;
}
