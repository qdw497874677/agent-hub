/**
 * 产品形态（surface）的契约：每个形态在自己的目录里声明「我占哪几个导航项、我认哪几种路由」，
 * 壳只负责把它们拼起来。加一个产品面 = 加一个目录 + 一个 manifest，不改 `app.tsx` / `route.ts` 的
 * 具体分支。
 *
 * 这里只有类型，运行时的那份注册表在 `route.ts`（`SURFACES`）——manifest 只 `import type`
 * 本文件与 `route.ts`，不产生运行时循环依赖。
 */
import type { Route } from './route.ts';

export type SurfaceId = 'im' | 'workbench';

/** 导航分组由壳统一排序与命名，形态只说自己属于哪一组。 */
export type SurfaceNavGroupId = 'work' | 'mine' | 'team' | 'manage';

export interface SurfaceNavItem {
  /** 稳定 id：也是 `data-testid="nav-<id>"` 的后半段。 */
  readonly id: string;
  readonly label: string;
  readonly href: string;
  /** 地址栏落在这一页时高亮这一项。 */
  readonly page: string;
  readonly group: SurfaceNavGroupId;
  /** 组内排序，小的在前；缺省 100（形态贡献的项默认排在壳的基础设施项之后）。 */
  readonly order?: number;
  /** 只有 `account.clusterAdmin === true` 才渲染。 */
  readonly adminOnly?: true;
}

export interface Surface {
  readonly id: SurfaceId;
  /** 本形态贡献的导航项，顺序即界面顺序。 */
  readonly nav: readonly SurfaceNavItem[];
  /** 认领一段路由（已切分、已解码）；不认领返回 null。 */
  parse(parts: readonly string[]): Route | null;
  /** 给路由出地址；不属于本形态返回 null。 */
  format(route: Route): string | null;
}
