import type { AdminTab } from '../route.ts';

/**
 * 运营后台的分页：顺序与文案。窄屏是顶部横向滚动的一排，宽屏是左侧栏，两边共用这一份。
 *
 * 「设置」不在这份列表里——平台级两个开关（开放注册、成员可以加机器）不常改，并进了概览底部。
 * 路由解析仍然认 `settings`，展示层用 resolveAdminTab 落回概览，旧书签不至于白屏。
 */
export const ADMIN_PAGE_TABS: readonly { readonly id: AdminTab; readonly label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'users', label: '用户' },
  { id: 'workers', label: '机器' },
  { id: 'assets', label: '资产' },
  { id: 'components', label: '运行时组件' },
  { id: 'audit', label: '审计' }
];

/** 地址里还带着已合并分页的，显示到它的新家。 */
export function resolveAdminTab(tab: AdminTab): AdminTab {
  return tab === 'settings' ? 'overview' : tab;
}
