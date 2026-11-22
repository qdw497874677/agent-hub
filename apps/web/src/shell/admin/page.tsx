import { useAccount } from '../auth.tsx';
import { AppShell, PageBody, PageHeader } from '../page-shell.tsx';
import { formatRoute, type AdminTab } from '../route.ts';
import { Overview } from './overview.tsx';
import { Users } from './users.tsx';
import { Audit } from './audit.tsx';
import { Components } from './components.tsx';
import { Assets, useUpgradableCount } from './assets.tsx';
import { ADMIN_PAGE_TABS, resolveAdminTab } from './tabs.ts';

/**
 * 运营后台（#/admin/<分页>），只有主人能进；服务端对 /api/admin/* 同样只认主人。
 * 窄屏下分页是顶部横向滚动的一排，宽屏是左侧栏。分页清单在 ./tabs.ts，和单测共用一份。
 */
export function AdminPage({ tab }: { tab: AdminTab }) {
  const account = useAccount();
  const upgradable = useUpgradableCount(account?.clusterAdmin === true);
  // 别名映射：收藏夹或旧消息里的 #/admin/settings 不该白屏。
  const active: AdminTab = resolveAdminTab(tab);
  if (account?.clusterAdmin !== true) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-head text-primary">只有 hub 管理员能进运营后台</p>
        <a className="text-meta text-link" href={formatRoute({ page: 'home' })}>
          回首页
        </a>
      </div>
    );
  }
  return (
    <AppShell>
      <PageHeader
        title="运营后台"
        tabsLabel="后台分页"
        activeTab={active}
        tabs={ADMIN_PAGE_TABS.map((item) => ({
          id: item.id,
          href: formatRoute({ page: 'admin', tab: item.id }),
          label: (
            <>
              {item.label}
              {item.id === 'assets' && upgradable > 0 ? (
                <span
                  data-testid="asset-update-badge"
                  title={`${upgradable} 个资产有新版本`}
                  className="ml-1.5 rounded-full bg-action px-1.5 text-meta text-action-fg"
                >
                  {upgradable}
                </span>
              ) : null}
            </>
          )
        }))}
      />
      <PageBody wide>
          {active === 'overview' && <Overview />}
          {active === 'users' && <Users />}
          {active === 'assets' && <Assets />}
          {active === 'components' && <Components />}
          {active === 'audit' && <Audit />}
      </PageBody>
    </AppShell>
  );
}
