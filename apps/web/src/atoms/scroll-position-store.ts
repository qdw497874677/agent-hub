import type { ScrollGeometry } from './stick-to-bottom.ts';

export type ScrollPositionKey = readonly [account: string, project: string, host: string, session: string];
export interface ScrollPosition {
  readonly scrollTop: number;
  readonly following: boolean;
}
export interface ScrollPositionStore {
  read(key: ScrollPositionKey): ScrollPosition | undefined;
  write(key: ScrollPositionKey, position: ScrollPosition): void;
}

/** Memory only: keep one instance for the authenticated account's lifetime. */
export function createScrollPositionStore(): ScrollPositionStore {
  const positions = new Map<string, ScrollPosition>();
  return {
    read: (key) => positions.get(JSON.stringify(key)),
    write: (key, position) => { positions.set(JSON.stringify(key), { ...position }); }
  };
}

/** Do not clamp an older reading position to a partial history or invisible layout. */
export function canRestorePosition(position: ScrollPosition, geometry: ScrollGeometry, historyReady: boolean): boolean {
  return historyReady && geometry.clientHeight > 0 &&
    Math.max(0, geometry.scrollHeight - geometry.clientHeight) >= position.scrollTop;
}
