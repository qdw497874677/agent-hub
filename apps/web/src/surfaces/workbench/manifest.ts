/**
 * 工作台形态：首页与项目（画布 / 列表 / 专注对话）。
 *
 * 项目是共享基础设施，工作台只是它的主要入口；IM 形态通过 `#/bots/<项目>` 借同一个项目，
 * 所以项目本身不搬进这个目录。
 */
import type { Route, View } from '../../shell/route.ts';
import type { Surface, SurfaceNavItem } from '../../shell/surface.ts';

export const WORKBENCH_NAV: readonly SurfaceNavItem[] = [
  { id: 'home', label: '首页', href: '#/home', page: 'home', group: 'work' }
];

const VIEWS: readonly View[] = ['canvas', 'list', 'focus'];

export function parseWorkbenchRoute(parts: readonly string[]): Route | null {
  if (parts[0] === 'home') return { page: 'home' };
  if (parts[0] !== 'p' || !parts[1]) return null;
  const view = VIEWS.find((candidate) => candidate === parts[2]) ?? 'canvas';
  const sessionId = parts[3] ?? null;
  // 专注对话一定要知道是谁；没有会话 id 的 focus 退回画布。
  return { page: 'project', projectId: parts[1], view: view === 'focus' && !sessionId ? 'canvas' : view, sessionId };
}

export function formatWorkbenchRoute(route: Route): string | null {
  if (route.page === 'home') return '#/home';
  if (route.page !== 'project') return null;
  const tail = route.sessionId ? `/${encodeURIComponent(route.sessionId)}` : '';
  return `#/p/${encodeURIComponent(route.projectId)}/${route.view}${tail}`;
}

export const workbenchSurface: Surface = {
  id: 'workbench',
  nav: WORKBENCH_NAV,
  parse: parseWorkbenchRoute,
  format: formatWorkbenchRoute
};
