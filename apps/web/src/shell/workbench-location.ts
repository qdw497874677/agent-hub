import { formatRoute, parseRoute, type Route } from './route.ts';

export type ProjectLocation = Extract<Route, { page: 'project' }>;
type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function browserStorage(): StorageAccess | undefined {
  return (globalThis as { localStorage?: StorageAccess }).localStorage;
}

function key(accountId: string): string {
  return `agent-hub:last-workbench:${encodeURIComponent(accountId)}`;
}

/** Store only a canonical project location that the workspace has confirmed. */
export function readWorkbenchLocation(accountId: string, storage?: StorageAccess): ProjectLocation | null {
  try {
    const hash = (storage ?? browserStorage())?.getItem(key(accountId));
    if (!hash) return null;
    const route = parseRoute(hash);
    return route?.page === 'project' && formatRoute(route) === hash ? route : null;
  } catch {
    return null;
  }
}

export function rememberWorkbenchLocation(accountId: string, route: ProjectLocation, storage?: StorageAccess): void {
  try {
    const hash = formatRoute(route);
    const local = storage ?? browserStorage();
    if (local && local.getItem(key(accountId)) !== hash) local.setItem(key(accountId), hash);
  } catch { /* optional local preferences */ }
}

export function forgetWorkbenchLocation(accountId: string, route: ProjectLocation, storage?: StorageAccess): void {
  try {
    const local = storage ?? browserStorage();
    if (local?.getItem(key(accountId)) === formatRoute(route)) local.removeItem(key(accountId));
  } catch { /* optional local preferences */ }
}
