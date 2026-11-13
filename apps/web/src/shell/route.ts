/**
 * 地址栏就是导航状态：`#/home` 首页，`#/p/<项目>/<视图>[/<会话>]`，`#/admin/<分页>` 运营后台，`#/assets/<分页>` / `#/assets/review/<提交>` 资产市场与审核，`#/memory[/<作用域>]` 记忆，`#/bots[/<项目>]` bot（持久智能体）。
 *
 * `#/observe` 可观测列表，`#/observe/<来源>/<id>` 一条链。
 * 为什么用 hash 而不是 history 路由：server 只托管一个 index.html，hash 不需要它配合回退；
 * 手机上「返回」手势、刷新、把链接发给自己另一台设备，都能回到同一个画面。
 * 纯函数在这里，React 的那一层在 use-route.ts。
 */
export type View = 'canvas' | 'list' | 'focus';

export type AdminTab = 'overview' | 'users' | 'workers' | 'assets' | 'settings' | 'audit' | 'components';
export const ADMIN_TABS: readonly AdminTab[] = ['overview', 'users', 'workers', 'assets', 'settings', 'audit', 'components'];

export type MarketTab = 'catalog' | 'mine' | 'pending' | 'settings';
export const MARKET_TABS: readonly MarketTab[] = ['catalog', 'mine', 'pending', 'settings'];

import { imSurface } from '../surfaces/im/manifest.ts';
import { workbenchSurface } from '../surfaces/workbench/manifest.ts';
import type { Surface } from './surface.ts';

/**
 * 产品形态注册表：新形态加进来只改这一行。
 *
 * 顺序 = 认领路由的优先级（当前几段前缀互不重叠，顺序只影响未来可能的重叠）。
 * 注意：manifest 只 `import type` 本文件，运行时不会绕回来，没有循环依赖。
 */
export const SURFACES: readonly Surface[] = [workbenchSurface, imSurface];

export type Route =
  | { readonly page: 'home' }
  | { readonly page: 'workspaces' }
  | { readonly page: 'assets'; readonly tab: MarketTab; readonly reviewId: string | null }
  | { readonly page: 'admin'; readonly tab: AdminTab }
  | { readonly page: 'memory'; readonly scope: string | null }
  | { readonly page: 'bots'; readonly projectId: string | null }
  | { readonly page: 'messages'; readonly projectId: string | null; readonly groupId: string | null }
  | { readonly page: 'observe'; readonly source: string | null; readonly id: string | null }
  | { readonly page: 'project'; readonly projectId: string; readonly view: View; readonly sessionId: string | null };

/** 壳自己的页（跨形态的基础设施：工作空间、记忆、资产市场、可观测、运营后台）。 */
function parseShellRoute(parts: readonly string[]): Route | null {
  if (parts[0] === 'admin') return { page: 'admin', tab: ADMIN_TABS.find((tab) => tab === parts[1]) ?? 'overview' };
  if (parts[0] === 'workspaces') return { page: 'workspaces' };
  if (parts[0] === 'memory') return { page: 'memory', scope: parts[1] ?? null };
  if (parts[0] === 'observe') return { page: 'observe', source: parts[1] ?? null, id: parts[2] ?? null };
  if (parts[0] === 'assets') {
    if (parts[1] === 'review' && parts[2]) return { page: 'assets', tab: 'pending', reviewId: parts[2] };
    return { page: 'assets', tab: MARKET_TABS.find((tab) => tab === parts[1]) ?? 'catalog', reviewId: null };
  }
  return { page: 'home' };
}

export function parseRoute(hash: string): Route | null {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return null;
  for (const surface of SURFACES) {
    const route = surface.parse(parts);
    if (route) return route;
  }
  return parseShellRoute(parts);
}

export function formatRoute(route: Route): string {
  for (const surface of SURFACES) {
    const href = surface.format(route);
    if (href) return href;
  }
  if (route.page === 'workspaces') return '#/workspaces';
  if (route.page === 'admin') return `#/admin/${route.tab}`;
  if (route.page === 'memory') return route.scope ? `#/memory/${encodeURIComponent(route.scope)}` : '#/memory';
  if (route.page === 'observe') {
    if (!route.source || !route.id) return '#/observe';
    return `#/observe/${encodeURIComponent(route.source)}/${encodeURIComponent(route.id)}`;
  }
  if (route.page === 'assets') return route.reviewId ? `#/assets/review/${encodeURIComponent(route.reviewId)}` : `#/assets/${route.tab}`;
  return '#/home';
}
