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
  /** 跑在哪台 worker 上；null 是本机（或还没分到）。同一台的会话在画布上同框。 */
  readonly workerId?: string | null;
}
export interface LayoutInput {
  readonly tasks: readonly LayoutTask[];
  readonly sessions: readonly LayoutSession[];
}

export const LAYOUT = { originX: 80, originY: 80, gapX: 96, gapY: 40, taskGap: 80 } as const;
/** worker 框：内边距、标题栏高度、框与框的间距。 */
export const FRAME = { pad: 24, header: 36, gap: 56 } as const;

/** 会话属于哪个框：按 worker 分，没有 worker 的归「本机」。 */
export const frameKey = (session: Pick<LayoutSession, 'workerId'>): string => `frame:${session.workerId ?? 'local'}`;

/** 按 worker 分组，保持会话第一次出现的顺序。 */
export function frameGroups<T extends Pick<LayoutSession, 'workerId'>>(sessions: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const session of sessions) groups.set(frameKey(session), [...(groups.get(frameKey(session)) ?? []), session]);
  return groups;
}

/**
 * 树形排布 + 按 worker 分框：任务一列在左；会话按 worker 分组，每组一个框，框从上往下排；
 * 框里派生的会话纵向堆叠，分叉出来的挂在来源右边（来源在别的框就自己当一棵树的根）。
 * 返回每个节点左上角。sizeOf 给出卡片尺寸（拖过的 / 量到的 / 估计的）。
 */
export function arrange(input: LayoutInput, sizeOf: (id: string) => Size): Record<string, Point> {
  const placed: Record<string, Point> = {};
  const taskWidth = Math.max(0, ...input.tasks.map((task) => sizeOf(task.id).width));
  const sessionX = LAYOUT.originX + (input.tasks.length > 0 ? taskWidth + LAYOUT.gapX : 0) + FRAME.pad;

  let frameY = LAYOUT.originY;
  for (const members of frameGroups(input.sessions).values()) {
    const inFrame = new Set(members.map((session) => session.id));
    const children = new Map<string, string[]>();
    const roots: string[] = [];
    for (const session of members) {
      const from = session.origin.fromSessionId;
      if (session.origin.kind === 'fork' && from !== undefined && inFrame.has(from)) children.set(from, [...(children.get(from) ?? []), session.id]);
      else roots.push(session.id);
    }
    const visiting = new Set<string>();
    const place = (id: string, x: number, y: number): number => {
      if (visiting.has(id)) return 0;
      visiting.add(id);
      placed[id] = { x, y };
      const size = sizeOf(id);
      let cursor = y;
      for (const child of children.get(id) ?? []) cursor += place(child, x + size.width + LAYOUT.gapX, cursor) + LAYOUT.gapY;
      return Math.max(size.height, cursor === y ? 0 : cursor - y - LAYOUT.gapY);
    };
    let y = frameY + FRAME.header;
    for (const root of roots) y += place(root, sessionX, y) + LAYOUT.gapY;
    // 分叉成环的（数据坏了）：至少放出来
    for (const session of members) if (placed[session.id] === undefined) y += place(session.id, sessionX, y) + LAYOUT.gapY;
    frameY = y - LAYOUT.gapY + FRAME.pad + FRAME.gap;
  }

  // 任务一列：尽量和自己第一条会话对齐，压到上一个任务就往下排
  let taskY = LAYOUT.originY;
  for (const task of input.tasks) {
    const first = input.sessions.find((session) => session.taskId === task.id && placed[session.id]);
    const y = Math.max(taskY, first ? (placed[first.id] as Point).y : taskY);
    placed[task.id] = { x: LAYOUT.originX, y };
    taskY = y + sizeOf(task.id).height + LAYOUT.taskGap;
  }
  return placed;
}

/** 框的矩形：框住组里所有会话，加内边距和标题栏。组里一个有位置的都没有返回 null。 */
export function frameRect(ids: readonly string[], positions: Readonly<Record<string, Point>>, sizeOf: (id: string) => Size): Rect | null {
  const rects = ids.flatMap((id) => (positions[id] ? [{ ...(positions[id] as Point), ...sizeOf(id) }] : []));
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.x)) - FRAME.pad;
  const top = Math.min(...rects.map((r) => r.y)) - FRAME.header;
  const right = Math.max(...rects.map((r) => r.x + r.width)) + FRAME.pad;
  const bottom = Math.max(...rects.map((r) => r.y + r.height)) + FRAME.pad;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 拖框：组里每张卡一起平移。 */
export function shiftFrame(
  positions: Readonly<Record<string, Point>>,
  ids: readonly string[],
  delta: Point
): Record<string, Point> {
  if (delta.x === 0 && delta.y === 0) return positions as Record<string, Point>;
  const next = { ...positions };
  for (const id of ids) {
    const point = positions[id];
    if (point) next[id] = { x: point.x + delta.x, y: point.y + delta.y };
  }
  return next;
}

/** 卡片松手的地方压进了别的 worker 的框（以卡片中心为准）吗？worker 是定死的，压进去就弹回。 */
export function landsInForeignFrame(card: Rect, foreign: readonly Rect[]): boolean {
  const cx = card.x + card.width / 2;
  const cy = card.y + card.height / 2;
  return foreign.some((frame) => cx > frame.x && cx < frame.x + frame.width && cy > frame.y && cy < frame.y + frame.height);
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
