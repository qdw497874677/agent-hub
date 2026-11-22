import { Icon, type IconName } from '../atoms/icons.tsx';
import { useAccount } from './auth.tsx';
import { activeGlobalNavId, globalNavGroups } from './global-nav.ts';
import { useRoute } from './use-route.ts';

const ICONS: Readonly<Record<string, IconName>> = {
  home: 'home',
  messages: 'chat',
  bots: 'bot',
  memory: 'brain',
  workspaces: 'folder',
  machines: 'server',
  market: 'package',
  observe: 'activity',
  admin: 'shield'
};

/**
 * 全站导航：只放路由链接，运维组整组只对管理员出现。
 *
 * - `list`（默认）：桌面是一列「图标 + 名字」的紧凑行，组与组之间只留一点空隙，不写组标题；
 *   窄屏（抽屉 / 首页顶部）改成四列图标格，两行就能放下，不把任务列表挤到屏幕外。
 * - `rail`：侧栏收起成图标栏时只剩图标，名字进 tooltip。
 */
export function GlobalNav({ layout = 'list' }: { layout?: 'list' | 'rail' }) {
  const account = useAccount();
  const [route] = useRoute();
  const active = activeGlobalNavId(route?.page ?? null);
  const items = globalNavGroups(account?.clusterAdmin === true).flatMap((group, index) =>
    group.items.map((item, at) => ({ ...item, gap: index > 0 && at === 0 }))
  );

  if (layout === 'rail') {
    return (
      <nav aria-label="全站导航" data-testid="global-nav" className="flex flex-col items-center gap-0.5">
        {items.map((item) => {
          const on = item.id === active;
          return (
            <a
              key={item.id}
              href={item.href}
              data-testid={`nav-${item.id}`}
              aria-current={on ? 'page' : undefined}
              aria-label={item.label}
              title={item.label}
              className={`flex size-9 items-center justify-center rounded-md ${item.gap ? 'mt-1.5' : ''} ${
                on ? 'bg-selected text-primary' : 'text-tertiary hover:bg-hover hover:text-primary'
              }`}
            >
              <Icon name={ICONS[item.id] ?? 'grid'} />
            </a>
          );
        })}
      </nav>
    );
  }

  return (
    <nav aria-label="全站导航" data-testid="global-nav" className="grid grid-cols-4 gap-0.5 md:grid-cols-2 lg:flex lg:flex-col">
      {items.map((item) => {
        const on = item.id === active;
        return (
          <a
            key={item.id}
            href={item.href}
            data-testid={`nav-${item.id}`}
            aria-current={on ? 'page' : undefined}
            className={`flex min-h-12 flex-col items-center justify-center gap-1 rounded-md px-1 text-meta lg:min-h-7 lg:flex-row lg:justify-start lg:gap-2.5 lg:px-2 lg:text-sub ${
              item.gap ? 'lg:mt-2' : ''
            } ${on ? 'bg-selected text-primary' : 'text-secondary hover:bg-hover hover:text-primary'}`}
          >
            <Icon name={ICONS[item.id] ?? 'grid'} className={on ? 'text-primary' : 'text-tertiary'} />
            <span className="truncate">{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
