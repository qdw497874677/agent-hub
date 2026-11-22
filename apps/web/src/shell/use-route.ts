import { useCallback, useSyncExternalStore } from 'react';
import { formatRoute, parseRoute, type Route } from './route.ts';

const subscribe = (notify: () => void): (() => void) => {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
};

/**
 * 当前路由 + 导航。push 进历史（手机返回手势能退回来）；replace 用于「只是换了选中」这种不值得占一格历史的变化。
 * state 里可以带 returnTo 之类的入口信息，导航本身不会把它拼进地址栏。
 */
export function useRoute(): readonly [
  Route | null,
  (route: Route, mode?: 'push' | 'replace', state?: unknown) => void
] {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const navigate = useCallback((route: Route, mode: 'push' | 'replace' = 'push', state?: unknown) => {
    const next = formatRoute(route);
    if (next === window.location.hash) {
      if (state !== undefined) window.history.replaceState(state, '', next);
      return;
    }
    if (mode === 'replace') {
      window.history.replaceState(state ?? null, '', next);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else {
      window.history.pushState(state ?? null, '', next);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  }, []);
  return [parseRoute(hash), navigate] as const;
}
