import { useCallback, useSyncExternalStore } from 'react';
import { formatRoute, parseRoute, type Route } from './route.ts';

const subscribe = (notify: () => void): (() => void) => {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
};

/**
 * 当前路由 + 导航。push 进历史（手机返回手势能退回来）；replace 用于「只是换了选中」这种不值得占一格历史的变化。
 */
export function useRoute(): readonly [Route | null, (route: Route, mode?: 'push' | 'replace') => void] {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const navigate = useCallback((route: Route, mode: 'push' | 'replace' = 'push') => {
    const next = formatRoute(route);
    if (next === window.location.hash) return;
    if (mode === 'replace') {
      window.history.replaceState(null, '', next);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else {
      window.location.hash = next;
    }
  }, []);
  return [parseRoute(hash), navigate] as const;
}
