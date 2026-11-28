import { useEffect, useRef } from 'react';
import { parseRoute, type Route } from './route.ts';
import { SETTINGS_DIRECTORY, type SettingsRoute, type SettingsTarget } from './settings-route.ts';
import { useRoute } from './use-route.ts';

type Navigate = ReturnType<typeof useRoute>[1];
type SettingsHistory = { readonly origin: string; readonly depth: 1 | 2 };
let restoreFocus: HTMLElement | null = null;

function settingsHistory(): SettingsHistory | null {
  const state = window.history.state?.settings as Partial<SettingsHistory> | undefined;
  if (typeof state?.origin !== 'string' || !state.origin.startsWith('#') || (state.depth !== 1 && state.depth !== 2)) return null;
  return parseRoute(state.origin)?.page === 'settings' ? null : { origin: state.origin, depth: state.depth };
}

export function settingsBackgroundRoute(): Route {
  const state = settingsHistory();
  return (state ? parseRoute(state.origin) : null) ?? { page: 'home' };
}

export function useRestoreSettingsFocus(open: boolean) {
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) {
      const trigger = restoreFocus;
      requestAnimationFrame(() => {
        if (parseRoute(window.location.hash)?.page !== 'settings' && trigger?.isConnected) trigger.focus({ preventScroll: true });
      });
    }
    wasOpen.current = open;
  }, [open]);
}

export function openSettings(navigate: Navigate, target: SettingsTarget | null = null, trigger?: HTMLElement) {
  restoreFocus = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  navigate({ page: 'settings', target }, 'push', { settings: { origin: window.location.hash || '#/home', depth: 1 } });
}

export function navigateSettings(navigate: Navigate, current: SettingsRoute, next: SettingsRoute) {
  const state = settingsHistory();
  if (next.target === null && state?.depth === 2) {
    window.history.back();
  } else if (current.target === null && next.target !== null && state) {
    navigate(next, 'push', { settings: { ...state, depth: 2 } });
  } else if (current.target === null && next.target !== null) {
    // 独立打开目录也有自己的上一级；退出设置按钮不会回到外部站点。
    navigate(next, 'push', { settings: { origin: '#/home', depth: 1 }, settingsFromStandaloneDirectory: true });
  } else {
    navigate(next, 'replace', window.history.state);
  }
}

export function backToSettingsDirectory(navigate: Navigate, current: SettingsRoute) {
  if (window.history.state?.settingsFromStandaloneDirectory === true) window.history.back();
  else navigateSettings(navigate, current, SETTINGS_DIRECTORY);
}

export function closeSettings(navigate: Navigate) {
  const state = settingsHistory();
  if (state && window.history.state?.settingsFromStandaloneDirectory !== true) window.history.go(-state.depth);
  else navigate({ page: 'home' }, 'replace');
}
