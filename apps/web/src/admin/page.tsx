import { AccountMenu, useAccount } from '../auth.tsx';
import { formatRoute, type AdminTab } from '../route.ts';
import { Overview } from './overview.tsx';
import { Users } from './users.tsx';
import { Workers } from './workers.tsx';
import { Settings } from './settings.tsx';
import { Audit } from './audit.tsx';
import { Components } from './components.tsx';
import { Assets, useUpgradableCount } from './assets.tsx';

/**
 * 运营后台（#/admin/<分页>），只有主人能进；服务端对 /api/admin/* 同样只认主人。
 * 窄屏下分页是顶部横向滚动的一排，宽屏是左侧栏。
 */
const TABS: readonly { readonly id: AdminTab; readonly label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'users', label: '用户' },
  { id: 'workers', label: '机器' },
  { id: 'assets', label: '资产' },
  { id: 'components', label: '组件' },
  { id: 'settings', label: '设置' },
  { id: 'audit', label: '审计' }
];

export function AdminPage({ tab }: { tab: AdminTab }) {
  const account = useAccount();
  const upgradable = useUpgradableCount(account?.clusterAdmin === true);
  if (account?.clusterAdmin !== true) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-head text-primary">只有 hub 管理员能进运营后台</p>
        <a className="text-meta text-accent" href={formatRoute({ page: 'home' })}>
          回首页
        </a>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col md:flex-row">
      <nav aria-label="后台分页" className="shrink-0 border-b border-hair md:w-[200px] md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 px-3 pt-3 md:pt-4">
          <div className="min-w-0">
            <a className="text-meta text-tertiary hover:text-accent" href={formatRoute({ page: 'home' })}>
              ← agent-hub
            </a>
            <p className="text-head text-primary">运营后台</p>
          </div>
          <AccountMenu />
        </div>
        <ul className="flex gap-1 overflow-x-auto px-2 py-2 md:flex-col md:gap-0.5 md:px-2 md:py-3">
          {TABS.map((item) => (
            <li key={item.id} className="shrink-0">
              <a
                href={formatRoute({ page: 'admin', tab: item.id })}
                aria-current={item.id === tab ? 'page' : undefined}
                className={`block rounded-sm px-3 py-1.5 text-body ${
                  item.id === tab ? 'bg-card text-primary' : 'text-secondary hover:bg-card'
                }`}
              >
                {item.label}
                {item.id === 'assets' && upgradable > 0 ? (
                  <span
                    data-testid="asset-update-badge"
                    title={`${upgradable} 个资产有新版本`}
                    className="ml-1.5 rounded-full bg-accent px-1.5 text-meta text-canvas"
                  >
                    {upgradable}
                  </span>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6">
        <div className="mx-auto max-w-[880px] min-w-0">
          {tab === 'overview' && <Overview />}
          {tab === 'users' && <Users />}
          {tab === 'workers' && <Workers />}
          {tab === 'assets' && <Assets />}
          {tab === 'components' && <Components />}
          {tab === 'settings' && <Settings />}
          {tab === 'audit' && <Audit />}
        </div>
      </main>
    </div>
  );
}
