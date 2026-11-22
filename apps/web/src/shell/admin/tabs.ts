import type { AdminTab } from '../route.ts';

/**
 * 运营后台的分页：顺序与文案。窄屏是顶部横向滚动的一排，宽屏是左侧栏，两边共用这一份。
 *
 * 机器不在这里：它是所有人的入口，在自己家 `#/machines`（machines.tsx）。
 * 「设置」也不在这份列表里——平台级两个开关（开放注册、成员可以加机器）不常改，并进了概览底部。
 * 路由解析仍然认 `settings` / `workers`：`workers` 由 App 直接换到 `#/machines`（在老书签撞上管理员门禁之前）。
 */
export const ADMIN_PAGE_TABS: readonly { readonly id: AdminTab; readonly label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'users', label: '用户' },
  { id: 'assets', label: '资产' },
  { id: 'components', label: '运行时组件' },
  { id: 'audit', label: '审计' }
];

/** 地址里还带着已合并分页的，显示到它的新家。 */
export function resolveAdminTab(tab: AdminTab): AdminTab {
  return tab === 'settings' ? 'overview' : tab;
}
