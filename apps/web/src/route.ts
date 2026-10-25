/**
 * 地址栏就是导航状态：`#/home` 首页，`#/p/<项目>/<视图>[/<会话>]`，`#/admin/<分页>` 运营后台。
 *
 * 为什么用 hash 而不是 history 路由：server 只托管一个 index.html，hash 不需要它配合回退；
 * 手机上「返回」手势、刷新、把链接发给自己另一台设备，都能回到同一个画面。
 * 纯函数在这里，React 的那一层在 use-route.ts。
 */
export type View = 'canvas' | 'list' | 'focus';

export type AdminTab = 'overview' | 'users' | 'workers' | 'settings' | 'audit';
export const ADMIN_TABS: readonly AdminTab[] = ['overview', 'users', 'workers', 'settings', 'audit'];

export type Route =
  | { readonly page: 'home' }
  | { readonly page: 'admin'; readonly tab: AdminTab }
  | { readonly page: 'project'; readonly projectId: string; readonly view: View; readonly sessionId: string | null };

const VIEWS: readonly View[] = ['canvas', 'list', 'focus'];

export function parseRoute(hash: string): Route | null {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return null;
  if (parts[0] === 'admin') return { page: 'admin', tab: ADMIN_TABS.find((tab) => tab === parts[1]) ?? 'overview' };
  if (parts[0] !== 'p' || !parts[1]) return { page: 'home' };
  const view = VIEWS.find((candidate) => candidate === parts[2]) ?? 'canvas';
  const sessionId = parts[3] ?? null;
  // 专注对话一定要知道是谁；没有会话 id 的 focus 退回画布。
  return { page: 'project', projectId: parts[1], view: view === 'focus' && !sessionId ? 'canvas' : view, sessionId };
}

export function formatRoute(route: Route): string {
  if (route.page === 'home') return '#/home';
  if (route.page === 'admin') return `#/admin/${route.tab}`;
  const tail = route.sessionId ? `/${encodeURIComponent(route.sessionId)}` : '';
  return `#/p/${encodeURIComponent(route.projectId)}/${route.view}${tail}`;
}
