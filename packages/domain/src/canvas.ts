import type { ProjectId, Seq, SessionId, TaskId } from './ids.ts';
import type { Session } from './session.ts';
import type { Task } from './task.ts';

/** 画布坐标。布局是视图状态，但它必须活过浏览器重启（S6.3 / S7.1）。 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 卡片尺寸（画布单位）。没存过的卡片用视图自己的默认尺寸。 */
export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface CanvasLayout {
  readonly projectId: ProjectId;
  /** 键是 TaskId 或 SessionId 的字符串形式。 */
  readonly positions: Readonly<Record<string, Point>>;
  /** 用户拖过大小的卡片；键同 positions。 */
  readonly sizes: Readonly<Record<string, Size>>;
  readonly updatedAt: number;
}

/** 一次布局变更：拖动只带 positions，改尺寸通常两者都带（左/上边的把手会同时移动原点）。 */
export interface LayoutPatch {
  readonly positions?: Readonly<Record<string, Point>>;
  readonly sizes?: Readonly<Record<string, Size>>;
}

export const emptyLayout = (projectId: ProjectId, now: number): CanvasLayout => ({
  projectId,
  positions: {},
  sizes: {},
  updatedAt: now
});

/** 尺寸必须是有限正数；最小/最大值是视图的事，领域只拒绝无意义的值。 */
export const isValidSize = (size: Size): boolean =>
  Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;

/** 合并一次布局变更。无效尺寸被忽略而不是让整次保存失败——位置照样要记住。 */
export function applyLayoutPatch(layout: CanvasLayout, patch: LayoutPatch, now: number): CanvasLayout {
  const sizes = { ...layout.sizes };
  for (const [nodeId, size] of Object.entries(patch.sizes ?? {})) {
    if (isValidSize(size)) sizes[nodeId] = { width: size.width, height: size.height };
  }
  return {
    projectId: layout.projectId,
    positions: { ...layout.positions, ...patch.positions },
    sizes,
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
