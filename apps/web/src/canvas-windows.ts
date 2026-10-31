/**
 * 画布里展开的会话窗口（docs/design/canvas-expanded-sessions.md）。
 *
 * 纯函数，不认识 React、DOM、localStorage：窗口集合怎么变、平铺怎么算都在这里，单测覆盖。
 * 坐标一律是窗口层（屏幕）坐标；自由窗口存的是相对可视区的比例，浏览器尺寸变了照样落在原处。
 */

export type WindowMode = 'tiled' | 'free' | 'min' | 'max';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SessionWindow {
  readonly sessionId: string;
  readonly mode: WindowMode;
  /** 自由窗口的位置大小，相对可视区的比例（0–1）。 */
  readonly frac?: Rect;
  /** 最小化/最大化前是平铺还是自由，恢复时回到那里。 */
  readonly restore?: 'tiled' | 'free';
  /** 越大越靠上；也是「最近聚焦」的顺序。 */
  readonly z: number;
}

export interface WindowSet {
  readonly windows: readonly SessionWindow[];
}

export const EMPTY: WindowSet = { windows: [] };

/** 平铺最多几格（再多的自动最小化到窗口条）。 */
export const MAX_TILES = 4;
export const MIN_TILE = { width: 360, height: 320 } as const;
const GAP = 12;

const topZ = (set: WindowSet): number => set.windows.reduce((max, w) => Math.max(max, w.z), 0);
const find = (set: WindowSet, id: string) => set.windows.find((w) => w.sessionId === id);
const update = (set: WindowSet, id: string, patch: (w: SessionWindow) => SessionWindow): WindowSet => ({
  windows: set.windows.map((w) => (w.sessionId === id ? patch(w) : w))
});

/** 这块区域最多放几格平铺窗口（每格不小于 MIN_TILE，最多 MAX_TILES）。 */
export function tileCapacity(area: Pick<Rect, 'width' | 'height'>): number {
  const cols = Math.max(1, Math.min(2, Math.floor((area.width + GAP) / (MIN_TILE.width + GAP))));
  const rows = Math.max(1, Math.min(2, Math.floor((area.height + GAP) / (MIN_TILE.height + GAP))));
  return Math.min(MAX_TILES, cols * rows);
}

/**
 * 把 count 个窗口平铺进 area，互不重叠。
 * 1 个：靠右，宽 min(720, 55%)，留出左边看画布；2 个：左右两列；3 个：左一大、右两小；4 个：2×2。
 * 放不下（窄、矮）就按 tileCapacity 少放：只返回放得下的那几格。
 */
export function tileWindows(area: Rect, count: number): Rect[] {
  const n = Math.min(count, tileCapacity(area));
  if (n <= 0) return [];
  const { x, y, width, height } = area;
  const cols = Math.min(2, Math.floor((width + GAP) / (MIN_TILE.width + GAP))) >= 2 ? 2 : 1;
  if (n === 1) {
    const w = Math.max(Math.min(width, MIN_TILE.width), Math.min(720, Math.round(width * 0.55)));
    return [{ x: x + width - w, y, width: w, height }];
  }
  const half = (size: number) => Math.floor((size - GAP) / 2);
  if (cols === 1) {
    // 只有一列：上下叠
    const h = half(height);
    return Array.from({ length: n }, (_, i) => ({ x, y: y + i * (h + GAP), width, height: h }));
  }
  const w = half(width);
  const right = x + w + GAP;
  if (n === 2) return [{ x, y, width: w, height }, { x: right, y, width: w, height }];
  const h = half(height);
  if (n === 3) return [{ x, y, width: w, height }, { x: right, y, width: w, height: h }, { x: right, y: y + h + GAP, width: w, height: h }];
  return [
    { x, y, width: w, height: h },
    { x: right, y, width: w, height: h },
    { x, y: y + h + GAP, width: w, height: h },
    { x: right, y: y + h + GAP, width: w, height: h }
  ];
}

/** 平铺中的窗口超过容量：最久没聚焦的那几个最小化。 */
function overflow(set: WindowSet, capacity: number): WindowSet {
  const tiled = set.windows.filter((w) => w.mode === 'tiled').sort((a, b) => b.z - a.z);
  const out = new Set(tiled.slice(Math.max(1, capacity)).map((w) => w.sessionId));
  if (out.size === 0) return set;
  return { windows: set.windows.map((w) => (out.has(w.sessionId) ? { ...w, mode: 'min', restore: 'tiled' } : w)) };
}

/** 展开一条会话：已开着就聚焦（最小化的恢复），不重复开。 */
export function openWindow(set: WindowSet, sessionId: string, capacity: number): WindowSet {
  if (find(set, sessionId)) return restoreWindow(set, sessionId, capacity);
  return overflow({ windows: [...set.windows, { sessionId, mode: 'tiled', z: topZ(set) + 1 }] }, capacity);
}

export function focusWindow(set: WindowSet, sessionId: string): WindowSet {
  const w = find(set, sessionId);
  if (!w || w.z === topZ(set)) return set;
  const z = topZ(set) + 1;
  return update(set, sessionId, (current) => ({ ...current, z }));
}

export function minimizeWindow(set: WindowSet, sessionId: string): WindowSet {
  return update(set, sessionId, (w) =>
    w.mode === 'min' ? w : { ...w, mode: 'min', restore: w.mode === 'free' ? 'free' : w.mode === 'max' ? (w.restore ?? 'tiled') : 'tiled' }
  );
}

export function restoreWindow(set: WindowSet, sessionId: string, capacity: number): WindowSet {
  const w = find(set, sessionId);
  if (!w) return set;
  const z = topZ(set) + 1;
  const mode: WindowMode = w.mode === 'min' ? (w.restore === 'free' && w.frac ? 'free' : 'tiled') : w.mode;
  return overflow(update(set, sessionId, (current) => ({ ...current, mode, z })), capacity);
}

export function toggleMaximize(set: WindowSet, sessionId: string, capacity: number): WindowSet {
  const w = find(set, sessionId);
  if (!w) return set;
  if (w.mode === 'max') {
    const mode: WindowMode = w.restore === 'free' && w.frac ? 'free' : 'tiled';
    return overflow(update(set, sessionId, (current) => ({ ...current, mode })), capacity);
  }
  const z = topZ(set) + 1;
  return update(set, sessionId, (current) => ({ ...current, mode: 'max', restore: current.mode === 'free' ? 'free' : 'tiled', z }));
}

export function closeWindow(set: WindowSet, sessionId: string): WindowSet {
  return { windows: set.windows.filter((w) => w.sessionId !== sessionId) };
}

/** 拖过、改过大小：变成自由窗口，不再参与平铺。rect 是屏幕坐标，存成相对 area 的比例。 */
export function moveWindow(set: WindowSet, sessionId: string, rect: Rect, area: Rect): WindowSet {
  const frac = {
    x: (rect.x - area.x) / area.width,
    y: (rect.y - area.y) / area.height,
    width: rect.width / area.width,
    height: rect.height / area.height
  };
  return update(set, sessionId, (w) => ({ ...w, mode: 'free', frac }));
}

/** 「重新平铺」：自由的、最大化的都回到平铺。 */
export function retile(set: WindowSet, capacity: number): WindowSet {
  return overflow({ windows: set.windows.map((w) => (w.mode === 'free' || w.mode === 'max' ? { ...w, mode: 'tiled' } : w)) }, capacity);
}

/** 会话没了（删了、进回收站、没权限）就静默丢掉。 */
export function keepOnly(set: WindowSet, exists: (sessionId: string) => boolean): WindowSet {
  const windows = set.windows.filter((w) => exists(w.sessionId));
  return windows.length === set.windows.length ? set : { windows };
}

/** 当前最上面的那个可见窗口（手机上只显示它）。 */
export function focused(set: WindowSet): SessionWindow | undefined {
  return [...set.windows].filter((w) => w.mode !== 'min').sort((a, b) => b.z - a.z)[0];
}

export const minimized = (set: WindowSet): SessionWindow[] => set.windows.filter((w) => w.mode === 'min');

/**
 * 每个可见窗口画在哪里。平铺的按打开顺序分格（不随聚焦跳来跳去）；自由的按比例还原并夹回区域内；最大化的铺满。
 * 平铺超出容量的（区域刚变小还没来得及最小化）不返回。
 */
export function layoutWindows(set: WindowSet, area: Rect): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const tiled = set.windows.filter((w) => w.mode === 'tiled');
  const capacity = tileCapacity(area);
  const keep = new Set([...tiled].sort((a, b) => b.z - a.z).slice(0, capacity).map((w) => w.sessionId));
  const shown = tiled.filter((w) => keep.has(w.sessionId));
  tileWindows(area, shown.length).forEach((rect, i) => out.set(shown[i]!.sessionId, rect));
  for (const w of set.windows) {
    if (w.mode === 'max') out.set(w.sessionId, area);
    if (w.mode === 'free' && w.frac) out.set(w.sessionId, clampInto(fromFrac(w.frac, area), area));
  }
  return out;
}

function fromFrac(frac: Rect, area: Rect): Rect {
  return {
    x: Math.round(area.x + frac.x * area.width),
    y: Math.round(area.y + frac.y * area.height),
    width: Math.round(frac.width * area.width),
    height: Math.round(frac.height * area.height)
  };
}

function clampInto(rect: Rect, area: Rect): Rect {
  const width = Math.min(Math.max(rect.width, Math.min(MIN_TILE.width, area.width)), area.width);
  const height = Math.min(Math.max(rect.height, Math.min(240, area.height)), area.height);
  const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

/** 持久化格式校验：坏数据当没有，不让一份旧存档把画布弄崩。 */
export function parseWindowSet(raw: string | null): WindowSet {
  if (!raw) return EMPTY;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !Array.isArray((value as WindowSet).windows)) return EMPTY;
    const modes = new Set<WindowMode>(['tiled', 'free', 'min', 'max']);
    const isRect = (r: unknown): r is Rect =>
      !!r && typeof r === 'object' && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite((r as Record<string, unknown>)[k]));
    const windows = (value as { windows: unknown[] }).windows.flatMap((item): SessionWindow[] => {
      const w = item as Partial<SessionWindow>;
      if (typeof w.sessionId !== 'string' || !modes.has(w.mode as WindowMode) || !Number.isFinite(w.z)) return [];
      const mode = w.mode === 'free' && !isRect(w.frac) ? 'tiled' : (w.mode as WindowMode);
      return [{
        sessionId: w.sessionId,
        mode,
        z: w.z as number,
        ...(isRect(w.frac) ? { frac: w.frac } : {}),
        ...(w.restore === 'free' || w.restore === 'tiled' ? { restore: w.restore } : {})
      }];
    });
    const seen = new Set<string>();
    return { windows: windows.filter((w) => (seen.has(w.sessionId) ? false : (seen.add(w.sessionId), true))) };
  } catch {
    return EMPTY;
  }
}

/** 端口：窗口集合存在哪里（浏览器里是 localStorage，测试里是内存）。 */
export interface WindowStore {
  load(key: string): WindowSet;
  save(key: string, set: WindowSet): void;
}

/** 存储键：按账号 + 画布范围分开（#111 的范围到了以后 scope 不止 project）。 */
export const windowsKey = (userId: string | null, scope: string, id: string): string =>
  `agent-hub:canvas-windows:${userId ?? 'anon'}:${scope}:${id}`;
