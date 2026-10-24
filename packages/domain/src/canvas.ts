import type { ProjectId, Seq, SessionId, TaskId } from './ids.ts';
import type { Session } from './session.ts';
import type { Task } from './task.ts';

/** 画布坐标。布局是视图状态，但它必须活过浏览器重启（S6.3 / S7.1）。 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface CanvasLayout {
  readonly projectId: ProjectId;
  /** 键是 TaskId 或 SessionId 的字符串形式。 */
  readonly positions: Readonly<Record<string, Point>>;
  readonly updatedAt: number;
}

export const emptyLayout = (projectId: ProjectId, now: number): CanvasLayout => ({
  projectId,
  positions: {},
  updatedAt: now
});

export function place(layout: CanvasLayout, nodeId: string, point: Point, now: number): CanvasLayout {
  return {
    projectId: layout.projectId,
    positions: { ...layout.positions, [nodeId]: point },
    updatedAt: now
  };
}

/** 血缘边。线型由 kind 决定：derive 实线、fork 虚线（视觉方向 §3）。 */
export type LineageEdge =
  | { readonly kind: 'derive'; readonly taskId: TaskId; readonly sessionId: SessionId }
  | {
      readonly kind: 'fork';
      readonly fromSessionId: SessionId;
      readonly toSessionId: SessionId;
      readonly atSeq: Seq;
    };

export function buildLineage(tasks: readonly Task[], sessions: readonly Session[]): LineageEdge[] {
  const knownTasks = new Set(tasks.map((t) => t.id));
  const edges: LineageEdge[] = [];
  for (const session of sessions) {
    if (!knownTasks.has(session.taskId)) continue;
    edges.push({ kind: 'derive', taskId: session.taskId, sessionId: session.id });
    if (session.origin.kind === 'fork') {
      edges.push({
        kind: 'fork',
        fromSessionId: session.origin.fromSessionId,
        toSessionId: session.id,
        atSeq: session.origin.atSeq
      });
    }
  }
  return edges;
}

export function nodesOf(tasks: readonly Task[], sessions: readonly Session[]): string[] {
  return [...tasks.map((t) => t.id as string), ...sessions.map((s) => s.id as string)];
}
