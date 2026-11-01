/**
 * 地址栏就是导航状态：`#/home` 首页，`#/p/<项目>/<视图>[/<会话>]`，`#/admin/<分页>` 运营后台，`#/assets/<分页>` / `#/assets/review/<提交>` 资产市场与审核，`#/memory[/<作用域>]` 记忆，`#/bots[/<项目>]` bot（持久智能体）。
 *
 * 为什么用 hash 而不是 history 路由：server 只托管一个 index.html，hash 不需要它配合回退；
 * 手机上「返回」手势、刷新、把链接发给自己另一台设备，都能回到同一个画面。
 * 纯函数在这里，React 的那一层在 use-route.ts。
 */
export type View = 'canvas' | 'list' | 'focus';

export type AdminTab = 'overview' | 'users' | 'workers' | 'assets' | 'settings' | 'audit' | 'components';
export const ADMIN_TABS: readonly AdminTab[] = ['overview', 'users', 'workers', 'assets', 'settings', 'audit', 'components'];

export type MarketTab = 'catalog' | 'mine' | 'pending' | 'settings';
export const MARKET_TABS: readonly MarketTab[] = ['catalog', 'mine', 'pending', 'settings'];

export type Route =
  | { readonly page: 'home' }
  | { readonly page: 'assets'; readonly tab: MarketTab; readonly reviewId: string | null }
  | { readonly page: 'admin'; readonly tab: AdminTab }
  | { readonly page: 'memory'; readonly scope: string | null }
  | { readonly page: 'bots'; readonly projectId: string | null }
  | { readonly page: 'messages'; readonly projectId: string | null; readonly groupId: string | null }
  | { readonly page: 'project'; readonly projectId: string; readonly view: View; readonly sessionId: string | null };

const VIEWS: readonly View[] = ['canvas', 'list', 'focus'];

export function parseRoute(hash: string): Route | null {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return null;
  if (parts[0] === 'admin') return { page: 'admin', tab: ADMIN_TABS.find((tab) => tab === parts[1]) ?? 'overview' };
  if (parts[0] === 'memory') return { page: 'memory', scope: parts[1] ?? null };
  if (parts[0] === 'bots') return { page: 'bots', projectId: parts[1] ?? null };
  if (parts[0] === 'messages') return { page: 'messages', projectId: parts[1] ?? null, groupId: parts[1] ? (parts[2] ?? null) : null };
  if (parts[0] === 'assets') {
    if (parts[1] === 'review' && parts[2]) return { page: 'assets', tab: 'pending', reviewId: parts[2] };
    return { page: 'assets', tab: MARKET_TABS.find((tab) => tab === parts[1]) ?? 'catalog', reviewId: null };
  }
  if (parts[0] !== 'p' || !parts[1]) return { page: 'home' };
  const view = VIEWS.find((candidate) => candidate === parts[2]) ?? 'canvas';
  const sessionId = parts[3] ?? null;
  // 专注对话一定要知道是谁；没有会话 id 的 focus 退回画布。
  return { page: 'project', projectId: parts[1], view: view === 'focus' && !sessionId ? 'canvas' : view, sessionId };
}

export function formatRoute(route: Route): string {
  if (route.page === 'home') return '#/home';
  if (route.page === 'admin') return `#/admin/${route.tab}`;
  if (route.page === 'memory') return route.scope ? `#/memory/${encodeURIComponent(route.scope)}` : '#/memory';
  if (route.page === 'bots') return route.projectId ? `#/bots/${encodeURIComponent(route.projectId)}` : '#/bots';
  if (route.page === 'messages') {
    if (!route.projectId) return '#/messages';
    return `#/messages/${encodeURIComponent(route.projectId)}${route.groupId ? `/${encodeURIComponent(route.groupId)}` : ''}`;
  }
  if (route.page === 'assets') return route.reviewId ? `#/assets/review/${encodeURIComponent(route.reviewId)}` : `#/assets/${route.tab}`;
  const tail = route.sessionId ? `/${encodeURIComponent(route.sessionId)}` : '';
  return `#/p/${encodeURIComponent(route.projectId)}/${route.view}${tail}`;
}
