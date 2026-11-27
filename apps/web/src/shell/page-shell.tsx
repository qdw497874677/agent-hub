import type { ReactNode } from 'react';
import { Icon } from '../atoms/icons.tsx';
import { MessagesEntry } from '../atoms/messages-entry.tsx';
import { AccountMenu } from './auth.tsx';
import { GlobalNav } from './global-nav.tsx';
import { NotificationBell } from './market/notifications.tsx';
import { formatRoute } from './route.ts';
import { SettingsEntry } from './settings-navigation.tsx';

/**
 * 全站页面骨架（项目工作台以外的页面：记忆、资产、Bot、群、运行记录、工作目录、运营后台）。
 *
 * - 桌面左边一条常驻图标栏：品牌 + 全站导航 + 消息 / 通知 / 账号。离开项目也随时能跳。
 * - 统一的 PageHeader：标题（可带一级面包屑）在左，主操作在右；页签固定在页头下方。
 * - 内容区居中、限宽，自己滚动。
 * 只管排版，不拉数据；各页把自己的东西塞进 actions / tabs / children。
 */
export function AppShell({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="flex h-full" data-testid={testId}>
      <aside
        aria-label="全站"
        data-testid="app-rail"
        className="hidden w-14 shrink-0 flex-col items-center gap-2 border-r border-hair bg-panel py-2.5 lg:flex"
      >
        <a
          href={formatRoute({ page: 'home' })}
          aria-label="agent-hub 首页"
          title="agent-hub"
          className="mb-1 flex size-8 items-center justify-center rounded-md bg-fg text-[13px] font-semibold text-bg"
        >
          A
        </a>
        <GlobalNav layout="rail" />
        <div className="mt-auto flex flex-col items-center gap-1.5">
          <MessagesEntry />
          <NotificationBell placement="up" />
          <SettingsEntry />
          <AccountMenu placement="up" />
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/** 页签：固定在页头下方，一种样式。 */
export interface PageTab {
  readonly id: string;
  readonly label: ReactNode;
  readonly href: string;
  readonly testId?: string;
}

export function PageHeader({
  title,
  parent,
  actions,
  tabs,
  activeTab,
  tabsLabel
}: {
  title: ReactNode;
  /** 一级面包屑：手机上就是返回。缺省回首页。 */
  parent?: { readonly label: string; readonly href: string };
  actions?: ReactNode;
  tabs?: readonly PageTab[];
  activeTab?: string | null;
  tabsLabel?: string;
}) {
  const up = parent ?? { label: '首页', href: formatRoute({ page: 'home' }) };
  return (
    <>
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-hair px-3 lg:px-5" data-testid="page-header">
        <a
          href={up.href}
          aria-label={`返回${up.label}`}
          title={up.label}
          className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary lg:hidden"
        >
          <Icon name="chevron-left" />
        </a>
        {parent ? (
          <nav aria-label="位置" className="hidden min-w-0 shrink-0 items-center gap-1.5 text-sub text-tertiary lg:flex">
            <a href={parent.href} className="truncate hover:text-primary">
              {parent.label}
            </a>
            <span aria-hidden>/</span>
          </nav>
        ) : null}
        <h1 className="min-w-0 truncate text-head font-medium text-primary">{title}</h1>
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
          {actions}
          <span className="flex items-center gap-1.5 lg:hidden">
            <SettingsEntry />
            <AccountMenu />
          </span>
        </div>
      </header>
      {tabs && tabs.length > 0 ? (
        <nav aria-label={tabsLabel ?? '分页'} className="flex shrink-0 gap-1 overflow-x-auto border-b border-hair px-0.5 lg:px-2.5">
          {tabs.map((tab) => {
            const on = tab.id === activeTab;
            return (
              <a
                key={tab.id}
                href={tab.href}
                data-testid={tab.testId}
                aria-current={on ? 'page' : undefined}
                className={`-mb-px shrink-0 border-b-2 px-2.5 py-2 text-body ${
                  on ? 'border-fg text-primary' : 'border-transparent text-tertiary hover:text-primary'
                }`}
              >
                {tab.label}
              </a>
            );
          })}
        </nav>
      ) : null}
    </>
  );
}

/** 页面内容区：自己滚，居中限宽。`wide` 给表格多的页面（运营后台）。 */
export function PageBody({ children, wide = false, className = '' }: { children: ReactNode; wide?: boolean; className?: string }) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 lg:px-5 lg:py-5">
      <div className={`min-w-0 ${wide ? 'max-w-[1080px]' : 'max-w-[880px]'} ${className}`}>{children}</div>
    </main>
  );
}
