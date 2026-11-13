/**
 * 全站导航的纯逻辑：分组、按权限过滤、当前路由高亮，界面只负责渲染。
 *
 * 导航项由两处合成：壳自己的跨形态入口（记忆 / 工作空间 / 资产市场 / 可观测 / 运营后台）与
 * 各产品形态 manifest（`surfaces` 下每个形态一个 `manifest.ts`）贡献的项。加一个产品面只改 manifest，
 * 不改这个文件。
 *
 * 不 import React / DOM / contract 包，`node:test` 可以直接跑（和 `provider-models.ts` 一样，
 * 根 tsconfig 只把 web 的单测拉进编译，而它没有 DOM lib）。
 */
import { SURFACES } from './route.ts';
import type { SurfaceNavGroupId, SurfaceNavItem } from './surface.ts';

/** 导航只认「在哪一页」，不跟着路由的字段形状一起变；项目页不在导航里，所以永远没有高亮。 */
export type GlobalNavPage = string;

export type GlobalNavGroupId = SurfaceNavGroupId;

export interface GlobalNavItem {
  /** 稳定 id：也是 `data-testid="nav-<id>"` 的后半段。 */
  readonly id: string;
  readonly label: string;
  readonly href: string;
  /** 地址栏落在这一页时高亮这一项。 */
  readonly page: GlobalNavPage;
  /** 只有 `account.clusterAdmin === true` 才渲染。 */
  readonly adminOnly?: true;
}

export interface GlobalNavGroup {
  readonly id: GlobalNavGroupId;
  readonly label: string;
  readonly items: readonly GlobalNavItem[];
}

/** 顺序即界面顺序：工作 → 我的 → 团队 → 管理。 */
const GROUP_ORDER: readonly GlobalNavGroupId[] = ['work', 'mine', 'team', 'manage'];
const GROUP_LABELS: Readonly<Record<GlobalNavGroupId, string>> = {
  work: '工作',
  mine: '我的',
  team: '团队',
  manage: '管理'
};

/** 壳自己的入口：不属于任何产品形态，跨形态共用。 */
export const SHELL_NAV: readonly SurfaceNavItem[] = [
  { id: 'memory', label: '记忆', href: '#/memory', page: 'memory', group: 'mine', order: 10 },
  { id: 'workspaces', label: '工作空间', href: '#/workspaces', page: 'workspaces', group: 'team', order: 10 },
  // 资产市场的真实路由是 `#/assets/<tab>`（route.ts），没有 `#/market`。
  { id: 'market', label: '资产市场', href: '#/assets/catalog', page: 'assets', group: 'team', order: 20 },
  // 可观测对所有人开放（observe.tsx 与服务端都没有角色门禁），不属于管理组。
  { id: 'observe', label: '可观测', href: '#/observe', page: 'observe', group: 'team', order: 30 },
  { id: 'admin', label: '运营后台', href: '#/admin/overview', page: 'admin', group: 'manage', order: 10, adminOnly: true }
];

/** 壳的入口 + 所有形态贡献的入口，按组内 order 排序（同 order 保持声明顺序）。 */
export const GLOBAL_NAV_ITEMS: readonly SurfaceNavItem[] = [
  ...SHELL_NAV,
  ...SURFACES.flatMap((surface) => surface.nav)
];

export const GLOBAL_NAV_GROUPS: readonly GlobalNavGroup[] = GROUP_ORDER.map((id) => ({
  id,
  label: GROUP_LABELS[id],
  items: GLOBAL_NAV_ITEMS.filter((item) => item.group === id)
    .slice()
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    .map((item) => ({
      id: item.id,
      label: item.label,
      href: item.href,
      page: item.page,
      ...(item.adminOnly === true ? { adminOnly: true as const } : {})
    }))
})).filter((group) => group.items.length > 0);

/** 去掉当前账号看不到的项，顺手丢掉空组（非管理员没有「管理」组就整组不出现）。 */
export function globalNavGroups(clusterAdmin: boolean): GlobalNavGroup[] {
  return GLOBAL_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.adminOnly !== true || clusterAdmin)
  })).filter((group) => group.items.length > 0);
}

/** 地址栏的页名 → 高亮的项；不在导航里（项目页 / 没解析出来）就是 null。 */
export function activeGlobalNavId(page: string | null | undefined): string | null {
  if (!page) return null;
  for (const group of GLOBAL_NAV_GROUPS) {
    for (const item of group.items) {
      if (item.page === page) return item.id;
    }
  }
  return null;
}
