import { useSyncExternalStore } from 'react';

/** 手指还是鼠标：决定要不要提示 ⌘↵ 之类的键盘捷径。 */
export const coarsePointer = (): boolean => window.matchMedia('(pointer: coarse)').matches;

const NARROW = '(max-width: 767px)';

/**
 * 窄屏（手机竖屏）。和 Tailwind 的 `md` 断点同一条线：CSS 管样子，这里只管「默认进哪个视图」这类行为。
 */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(NARROW);
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia(NARROW).matches
  );
}
