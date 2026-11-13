/**
 * IM 形态：持久智能体（bot）与群聊。
 *
 * 这两个页面的路由与导航项只在这里声明——壳不再认识 `#/bots` / `#/messages` 的具体形状。
 * 底层仍是同一套 domain 用例（会话、派工、群、投递），形态只决定「用户从哪儿进来」。
 */
import type { Route } from '../../shell/route.ts';
import type { Surface, SurfaceNavItem } from '../../shell/surface.ts';

export const IM_NAV: readonly SurfaceNavItem[] = [
  { id: 'messages', label: '消息', href: '#/messages', page: 'messages', group: 'mine' },
  { id: 'bots', label: 'Bot', href: '#/bots', page: 'bots', group: 'mine' }
];

export function parseImRoute(parts: readonly string[]): Route | null {
  if (parts[0] === 'bots') return { page: 'bots', projectId: parts[1] ?? null };
  if (parts[0] === 'messages') {
    const projectId = parts[1] ?? null;
    return { page: 'messages', projectId, groupId: projectId ? (parts[2] ?? null) : null };
  }
  return null;
}

export function formatImRoute(route: Route): string | null {
  if (route.page === 'bots') return route.projectId ? `#/bots/${encodeURIComponent(route.projectId)}` : '#/bots';
  if (route.page === 'messages') {
    if (!route.projectId) return '#/messages';
    return `#/messages/${encodeURIComponent(route.projectId)}${route.groupId ? `/${encodeURIComponent(route.groupId)}` : ''}`;
  }
  return null;
}

export const imSurface: Surface = {
  id: 'im',
  nav: IM_NAV,
  parse: parseImRoute,
  format: formatImRoute
};
