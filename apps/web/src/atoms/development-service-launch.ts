import { createContext, useContext, useLayoutEffect, useRef } from 'react';

/** Scope changes invalidate pending launches, including cards that survive a workspace switch. */
export const DevelopmentLaunchScope = createContext('');
export function useDevelopmentLaunch(sessionId?: string) {
  const scope = useContext(DevelopmentLaunchScope);
  const pending = useRef<{ popup: Window | null; active: boolean } | null>(null);
  useLayoutEffect(() => () => {
    if (pending.current) {
      pending.current.active = false;
      pending.current.popup?.close();
      pending.current = null;
    }
  }, [scope, sessionId]);
  return () => {
    if (pending.current) {
      pending.current.active = false;
      pending.current.popup?.close();
    }
    const popup = window.open('', '_blank');
    if (popup) popup.opener = null;
    const request = { popup, active: true };
    pending.current = request;
    return {
      popup,
      active: () => request.active,
      finish: () => { request.active = false; if (pending.current === request) pending.current = null; }
    };
  };
}
