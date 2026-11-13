/**
 * 全站导航的纯逻辑：分组、按权限过滤、当前路由高亮，界面只负责渲染。
 *
 * 不 import React / DOM / contract 包，`node:test` 可以直接跑（和 `provider-models.ts` 一样，
 * 根 tsconfig 只把 web 的单测拉进编译，而它没有 DOM lib）。
 *
 * 这里的 `page` 用字符串而不是 `route.ts` 的 `Route['page']`：导航只需要认「在哪一页」，
 * 不必跟着路由的字段形状一起变；`project` 不在导航里，所以永远没有高亮。
 */
export type GlobalNavPage =
  | 'home'
  | 'memory'
  | 'messages'
  | 'bots'
  | 'workspaces'
  | 'assets'
  | 'observe'
  | 'admin';

export type GlobalNavGroupId = 'work' | 'mine' | 'team' | 'manage';

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
export const GLOBAL_NAV_GROUPS: readonly GlobalNavGroup[] = [
  {
    id: 'work',
    label: '工作',
    items: [{ id: 'home', label: '首页', href: '#/home', page: 'home' }]
  },
  {
    id: 'mine',
    label: '我的',
    items: [
      { id: 'memory', label: '记忆', href: '#/memory', page: 'memory' },
      { id: 'messages', label: '消息', href: '#/messages', page: 'messages' },
      { id: 'bots', label: 'Bot', href: '#/bots', page: 'bots' }
    ]
  },
  {
    id: 'team',
    label: '团队',
    items: [
      { id: 'workspaces', label: '工作空间', href: '#/workspaces', page: 'workspaces' },
      // 资产市场的真实路由是 `#/assets/<tab>`（route.ts），没有 `#/market`。
      { id: 'market', label: '资产市场', href: '#/assets/catalog', page: 'assets' },
      // 可观测对所有人开放（observe.tsx 与服务端都没有角色门禁），不属于管理组。
      { id: 'observe', label: '可观测', href: '#/observe', page: 'observe' }
    ]
  },
  {
    id: 'manage',
    label: '管理',
    items: [{ id: 'admin', label: '运营后台', href: '#/admin/overview', page: 'admin', adminOnly: true }]
  }
];

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
