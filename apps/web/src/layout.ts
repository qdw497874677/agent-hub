/**
 * 画布布局（纯函数，可单测）。
 *
 * 规则只有两条：
 * 1. 会话排在「父节点」右边一列：从任务派生的挂在任务右边，分叉出来的挂在来源会话右边；
 *    同一个父节点的孩子纵向堆叠，按**真实尺寸**（拖过的、量到的，没有就按上限估）留间距。
 * 2. 用户拖过、存进库的位置不动——只有显式点「整理布局」才整体重排。
 *
 * 之前的默认布局按固定格子（列宽 360、行距 420）排，拖大的卡、内容长的卡、
 * 后来才出现的卡都会压到邻居身上。
 */
export type Point = { readonly x: number; readonly y: number };
export type Size = { readonly width: number; readonly height: number };
export type Rect = Point & Size;

export interface LayoutTask {
  readonly id: string;
}
export interface LayoutSession {
  readonly id: string;
  readonly taskId: string;
  readonly origin: { readonly kind: string; readonly fromSessionId?: string };
}
export interface LayoutInput {
  readonly tasks: readonly LayoutTask[];
  readonly sessions: readonly LayoutSession[];
}

export const LAYOUT = { originX: 80, originY: 80, gapX: 96, gapY: 40, taskGap: 80 } as const;

/** 树形排布：返回每个节点左上角。sizeOf 给出卡片尺寸（拖过的 / 量到的 / 估计的）。 */
export function arrange(input: LayoutInput, sizeOf: (id: string) => Size): Record<string, Point> {
  const ids = new Set(input.sessions.map((session) => session.id));
  const children = new Map<string, string[]>();
  for (const session of input.sessions) {
    const from = session.origin.fromSessionId;
    const parent = session.origin.kind === 'fork' && from !== undefined && ids.has(from) ? from : session.taskId;
    children.set(parent, [...(children.get(parent) ?? []), session.id]);
  }

  const placed: Record<string, Point> = {};
  const visiting = new Set<string>();
  // 返回这棵子树占的高度
  const place = (id: string, x: number, y: number): number => {
    if (visiting.has(id)) return 0;
    visiting.add(id);
    placed[id] = { x, y };
    const size = sizeOf(id);
    let cursor = y;
    for (const child of children.get(id) ?? []) {
      cursor += place(child, x + size.width + LAYOUT.gapX, cursor) + LAYOUT.gapY;
    }
    const childrenHeight = cursor === y ? 0 : cursor - y - LAYOUT.gapY;
    return Math.max(size.height, childrenHeight);
  };

  let y = LAYOUT.originY;
  for (const task of input.tasks) y += place(task.id, LAYOUT.originX, y) + LAYOUT.taskGap;
  // 父节点不在画布上的会话（数据不完整）：排在最下面，至少不叠
  for (const session of input.sessions) {
    if (placed[session.id] === undefined) y += place(session.id, LAYOUT.originX, y) + LAYOUT.taskGap;
  }
  return placed;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * 给还没有位置的节点找位置：先放到树形排布给的地方，压到别人就往下挪，直到不压。
 * 已有位置的一个不动；没有新节点时返回原对象。
 */
export function placeMissing(
  current: Readonly<Record<string, Point>>,
  desired: Readonly<Record<string, Point>>,
  sizeOf: (id: string) => Size
): Record<string, Point> {
  const missing = Object.keys(desired).filter((id) => current[id] === undefined);
  if (missing.length === 0) return current as Record<string, Point>;
  const next: Record<string, Point> = { ...current };
  const rects: Rect[] = Object.entries(current).map(([id, point]) => ({ ...point, ...sizeOf(id) }));
  for (const id of missing) {
    const size = sizeOf(id);
    const start = desired[id] as Point;
    let rect: Rect = { ...start, ...size };
    for (let guard = 0; guard < 1000; guard += 1) {
      const hit = rects.find((other) => overlaps(rect, other));
      if (hit === undefined) break;
      rect = { ...rect, y: hit.y + hit.height + LAYOUT.gapY };
    }
    next[id] = { x: rect.x, y: rect.y };
    rects.push(rect);
  }
  return next;
}

/** 两两检查是否重叠，给测试和修库脚本用。 */
export function findOverlaps(rects: Readonly<Record<string, Rect>>): [string, string][] {
  const entries = Object.entries(rects);
  const hits: [string, string][] = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [a, ra] = entries[i] as [string, Rect];
      const [b, rb] = entries[j] as [string, Rect];
      if (overlaps(ra, rb)) hits.push([a, b]);
    }
  }
  return hits;
}
