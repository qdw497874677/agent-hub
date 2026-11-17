import { useSyncExternalStore } from 'react';

/**
 * 主题：跟随系统 / 深色 / 浅色。偏好记在本机（不跟账号走：同一个人在白天的笔记本和晚上的手机上可能想要不同的）。
 * 结果写到 <html data-theme="dark|light">，styles.css 只按这个属性换语义层的值。
 * index.html 里有一段同样逻辑的内联脚本，首帧之前就写好属性，刷新时不闪。
 */
import { parseThemePref, resolveTheme, THEME_KEY, type Theme, type ThemePref } from './theme-core.ts';

export { parseThemePref, resolveTheme, THEME_KEY, type Theme, type ThemePref } from './theme-core.ts';

const LIGHT_QUERY = '(prefers-color-scheme: light)';

function readPref(): ThemePref {
  try {
    return parseThemePref(globalThis.localStorage?.getItem(THEME_KEY));
  } catch {
    return 'auto';
  }
}

const listeners = new Set<() => void>();
let current: ThemePref = typeof window === 'undefined' ? 'auto' : readPref();

function systemLight(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(LIGHT_QUERY).matches;
}

export function applyTheme(pref: ThemePref = current): Theme {
  const theme = resolveTheme(pref, systemLight());
  if (typeof document !== 'undefined') {
    document.documentElement.dataset['theme'] = theme;
    // 手机状态栏 / 地址栏跟着底色
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f6f5f2' : '#14181a');
  }
  return theme;
}

export function setThemePref(pref: ThemePref): void {
  current = pref;
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // 隐私模式写不进去：这次照样生效
  }
  applyTheme(pref);
  for (const listener of listeners) listener();
}

/** 启动时调一次：写属性，并在「跟随系统」时跟着系统切换。 */
export function initTheme(): void {
  applyTheme();
  window.matchMedia(LIGHT_QUERY).addEventListener('change', () => {
    if (current === 'auto') {
      applyTheme();
      for (const listener of listeners) listener();
    }
  });
}

export function useThemePref(): [ThemePref, Theme, (pref: ThemePref) => void] {
  const pref = useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => current
  );
  return [pref, resolveTheme(pref, systemLight()), setThemePref];
}

/** 现在实际是哪个主题（给 shiki / xterm 这类要自己挑配色的组件）。 */
export function currentTheme(): Theme {
  return typeof document !== 'undefined' && document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark';
}
