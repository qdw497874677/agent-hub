import { useSyncExternalStore } from 'react';

/** 手指还是鼠标：决定要不要提示 ⌘↵ 之类的键盘捷径。 */
export const coarsePointer = (): boolean => window.matchMedia('(pointer: coarse)').matches;

/**
 * 用户要求减少动效吗（系统设置里的「减少动态效果」）。
 *
 * 只在真的要开动画的那一刻问一次：这条设置可能在页面开着的时候被改，
 * 每次动之前现问，比在挂载时记一个布尔值更跟得上。
 */
export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const NARROW = '(max-width: 767px)';
const COMPACT = '(max-width: 639px)';

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', notify);
      return () => media.removeEventListener('change', notify);
    },
    () => window.matchMedia(query).matches
  );
}

/**
 * 窄屏（手机竖屏）。和 Tailwind 的 `md` 断点同一条线：CSS 管样子，这里只管「默认进哪个视图」这类行为。
 */
export function useNarrow(): boolean {
  return useMedia(NARROW);
}

/**
 * 手机窄栏（<640）。比 `sm` 早一像素：这里只决定「哪些入口收进 ⋯」，样式仍由各页自己写。
 * 用 JS 断点而不是 CSS 隐藏双份，是为了 DOM 里不出现重复的 testid。
 */
export function useCompact(): boolean {
  return useMedia(COMPACT);
}

/** 宽屏（≥1024，Tailwind 的 lg）：会话详情能停靠在对话右边、不压住对话。 */
export function useWide(): boolean {
  return useMedia('(min-width: 1024px)');
}
