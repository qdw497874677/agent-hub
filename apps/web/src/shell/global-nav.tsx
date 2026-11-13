import { useAccount } from './auth.tsx';
import { activeGlobalNavId, globalNavGroups } from './global-nav.ts';
import { useRoute } from './use-route.ts';

/**
 * 全站导航：工作 / 我的 / 团队 / 管理，四组只放路由链接。
 *
 * 刻意做成「小标题 + 一排小链接」而不是卡片或图标墙：侧栏和首页左栏都是窄栏，
 * 任务/会话树才是主角，这组入口要能一眼扫完、不抢高度。
 * 组与组之间只用 1px 分隔线，不再额外留白。
 */
export function GlobalNav() {
  const account = useAccount();
  const [route] = useRoute();
  const active = activeGlobalNavId(route?.page ?? null);
  const groups = globalNavGroups(account?.clusterAdmin === true);

  return (
    <nav aria-label="全站导航" data-testid="global-nav" className="divide-y divide-hair">
      {groups.map((group) => (
        <div key={group.id} className="flex items-start gap-2 px-1.5 py-1">
          <p className="w-7 shrink-0 pt-2.5 text-meta text-tertiary lg:pt-1">{group.label}</p>
          <div className="flex min-w-0 flex-wrap items-center gap-0.5">
            {group.items.map((item) => {
              const on = item.id === active;
              return (
                <a
                  key={item.id}
                  href={item.href}
                  data-testid={`nav-${item.id}`}
                  aria-current={on ? 'page' : undefined}
                  className={`flex min-h-11 items-center rounded-sm px-1.5 text-meta lg:min-h-6 lg:px-1 ${
                    on ? 'bg-card-raised text-primary' : 'text-secondary hover:bg-card hover:text-primary'
                  }`}
                >
                  {item.label}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
