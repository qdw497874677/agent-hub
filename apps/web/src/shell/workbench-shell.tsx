import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AttentionAnnouncement, AttentionInbox, useAttention } from '../atoms/attention.tsx';
import { Icon, type IconName } from '../atoms/icons.tsx';
import { useGroupUnread } from '../atoms/messages-entry.tsx';
import { useAccount } from './account-context.ts';
import { roleLabel, useLogout } from './auth.tsx';
import { useWide } from './device.ts';
import { DialogShell } from './dialog-shell.tsx';
import { useModalFocus } from './focus-trap.ts';
import { globalNavGroups, type GlobalNavItem } from './global-nav.ts';
import { NotificationList, useNotifications } from './market/notifications.tsx';
import { formatRoute, type Route } from './route.ts';
import { openSettings } from './settings-navigation.tsx';
import { useRoute } from './use-route.ts';

type Panel = 'inbox' | 'messages' | 'more' | null;
type ShellContextValue = { openMenu(trigger: HTMLButtonElement): void; inboxOpen: boolean; panelOpen: boolean; attention: number; notifications: number; unread: number };
const ShellContext = createContext<ShellContextValue | null>(null);

/** 由窄屏页头提供唯一的全站入口，宽屏不挂载。 */
export function GlobalMenuButton() {
  const shell = useContext(ShellContext);
  const wide = useWide();
  const descriptionId = useId();
  if (wide || !shell) return null;
  const summary = `待处理 ${shell.attention}，站内通知未读 ${shell.notifications}，群聊未读 ${shell.unread}`;
  const hasUpdates = shell.attention > 0 || shell.notifications > 0 || shell.unread > 0;
  return <><button type="button" aria-label="全局菜单" aria-describedby={descriptionId} title={`全局菜单：${summary}`} aria-haspopup="dialog" aria-expanded={shell.panelOpen} data-testid="global-menu-button"
    className="relative flex size-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary"
    onClick={(event) => shell.openMenu(event.currentTarget)}><Icon name="grid" />{hasUpdates ? <span aria-hidden data-testid="global-menu-updates" className="absolute right-1.5 top-1.5 size-2 rounded-full bg-rust" /> : null}</button><span id={descriptionId} className="sr-only">{summary}</span></>;
}

/** 首页和弹出的收件箱不能同时呈现可操作的同一份待办。 */
export function useShellInboxOpen() { return useContext(ShellContext)?.inboxOpen ?? false; }

const itemIcons: Record<string, IconName> = { memory: 'brain', market: 'package', machines: 'server', workspaces: 'folder', observe: 'activity', admin: 'shield', messages: 'chat', bots: 'bot' };
const row = 'flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-body text-secondary hover:bg-hover hover:text-primary';

/** 宽屏浮层贴住触发入口，不参与布局；模态焦点与现有对话框共用同一栈。 */
function RailDialog({ title, panel, trigger, onClose, children }: { title: string; panel: Exclude<Panel, null>; trigger: HTMLButtonElement | null; onClose(): void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const isTop = useModalFocus(panelRef);
  const [position, setPosition] = useState({ left: 76, top: 8 });
  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element || !trigger) return;
    const update = () => {
      const anchor = trigger.getBoundingClientRect();
      const rail = trigger.closest('aside')?.getBoundingClientRect();
      const height = element.getBoundingClientRect().height;
      const bottomLimit = Math.max(8, window.innerHeight - height - 8);
      setPosition({ left: (rail?.right ?? anchor.right) + 8, top: panel === 'more' ? bottomLimit : Math.max(8, Math.min(anchor.top, bottomLimit)) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [panel, trigger]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isTop()) { event.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isTop, onClose]);
  return createPortal(<div className="fixed inset-0 z-50" onClick={onClose} data-testid="shell-overlay">
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} data-testid={`shell-panel-${panel}`}
      style={{ left: position.left, top: position.top }}
      className="fixed max-h-[calc(100dvh-16px)] w-[min(420px,calc(100vw-92px))] overflow-y-auto overscroll-contain rounded-overlay border border-strong bg-overlay p-4 shadow-overlay outline-none"
      onClick={(event) => event.stopPropagation()}>{children}</div>
  </div>, document.body);
}

export function WorkbenchShell({ route, onWorkbench, children }: { route: Route | null; onWorkbench(): void; children: ReactNode }) {
  const wide = useWide();
  const account = useAccount();
  const [, navigate] = useRoute();
  const [panel, setPanel] = useState<Panel>(null);
  const [tab, setTab] = useState<'attention' | 'notifications'>('attention');
  const trigger = useRef<HTMLButtonElement | null>(null);
  const attention = useAttention().data?.items.length ?? 0;
  const notifications = useNotifications().data?.unread ?? 0;
  const unread = useGroupUnread().data?.total ?? 0;
  const leave = useLogout();
  const groups = globalNavGroups(account?.clusterAdmin === true);
  const items = groups.flatMap((group) => group.items);
  const byId = (id: string) => items.find((item) => item.id === id);
  const close = () => setPanel(null);
  const open = (next: Panel, from: HTMLButtonElement) => { trigger.current = from; if (next === 'inbox') setTab('attention'); setPanel(next); };
  const routeKey = route ? formatRoute(route) : '';
  useEffect(() => { setPanel(null); }, [routeKey]);
  useEffect(() => { setPanel(null); }, [wide]);
  const navLink = (item: GlobalNavItem | undefined, label?: string) => item ? <a key={item.id} href={item.href} data-testid={`nav-${item.id}`} className={row} onClick={close}>
    <Icon name={itemIcons[item.id] ?? 'grid'} className="text-tertiary" /><span className="flex-1">{label ?? item.label}</span><Icon name="chevron-right" className="text-tertiary" />
  </a> : null;
  const settings = () => {
    const durable = trigger.current ?? undefined;
    close();
    openSettings(navigate, null, durable);
  };
  const railButton = (id: Exclude<Panel, null>, label: string, icon: IconName, badge?: number) => <button
    type="button" data-testid={id === 'messages' ? 'messages-entry' : `shell-${id}`} aria-label={id === 'inbox' ? `收件箱（${attention} 待处理，${notifications} 条通知未读）` : badge ? `${label}（${badge} 条未读）` : label} title={label}
    aria-haspopup="dialog" aria-expanded={panel === id} onClick={(event) => open(id, event.currentTarget)}
    className={`relative flex w-14 flex-col items-center gap-1 rounded-md py-2 text-[10px] ${panel === id ? 'bg-selected text-primary' : 'text-tertiary hover:bg-hover hover:text-primary'}`}>
    <Icon name={icon} size={18} /><span>{label}</span>{badge ? <span data-testid={id === 'messages' ? 'messages-unread' : 'attention-count'} className="absolute right-1 top-1 min-w-[16px] rounded-full bg-rust px-1 text-center text-[10px] leading-4 text-canvas">{badge > 99 ? '99+' : badge}</span> : null}{id === 'inbox' && notifications ? <span aria-hidden data-testid="notification-unread" className="absolute left-1 top-1 size-2 rounded-full bg-action" /> : null}
  </button>;
  const panelTitle = panel === 'inbox' ? '收件箱' : panel === 'messages' ? '消息' : '全局菜单';
  const panelContent = panel ? <div className="pb-2 pt-1 text-meta">
        <div className="mb-3 flex items-center justify-between px-2"><h2 className="text-head font-medium text-primary">{panel === 'inbox' ? '收件箱' : panel === 'messages' ? '消息' : '更多功能'}</h2><button type="button" aria-label="关闭" className="flex size-11 items-center justify-center rounded-md text-tertiary hover:bg-hover" onClick={close}><Icon name="x" /></button></div>
        {panel === 'inbox' ? <>
          <div role="tablist" aria-label="收件箱" className="mb-4 flex gap-4 border-b border-hair px-2">
            <button role="tab" aria-selected={tab === 'attention'} className={`border-b-2 pb-2 ${tab === 'attention' ? 'border-fg text-primary' : 'border-transparent text-tertiary'}`} onClick={() => setTab('attention')}>等我处理 {attention || ''}</button>
            <button role="tab" aria-selected={tab === 'notifications'} className={`border-b-2 pb-2 ${tab === 'notifications' ? 'border-fg text-primary' : 'border-transparent text-tertiary'}`} onClick={() => setTab('notifications')}>站内通知 {notifications || ''}</button>
          </div>
          {tab === 'attention' ? <AttentionInbox onOpen={(item) => { close(); navigate({ page: 'project', projectId: item.projectId, view: 'focus', sessionId: item.sessionId }, 'push', { fromHub: true, returnTo: window.location.hash }); }} /> : <NotificationList onNavigate={close} />}
        </> : panel === 'messages' ? <>{navLink(byId('messages'), '群聊')}{navLink(byId('bots'))}</> : <>
          {!wide ? <><button className={row} onClick={() => { close(); onWorkbench(); }}><Icon name="layers" />工作台</button>
            <button className={row} onClick={() => { setTab('attention'); setPanel('inbox'); }}><Icon name="queue" />收件箱 {attention ? `· ${attention} 待处理` : ''}{notifications ? ` · ${notifications} 通知未读` : ''}</button>
            <button className={row} onClick={() => setPanel('messages')}><Icon name="chat" />消息 {unread ? `· ${unread} 未读` : ''}</button></> : null}
          {([['资源', ['memory', 'market']], ['环境', ['machines', 'workspaces']], ['排查', ['observe']]] as const).map(([label, ids]) => <div key={label} className="mt-3"><p className="px-3 py-1 text-[11px] text-tertiary">{label}</p>{ids.map((id) => navLink(byId(id)))}</div>)}
          <div className="mt-3"><p className="px-3 py-1 text-[11px] text-tertiary">系统</p>
            <button className={row} onClick={settings}><Icon name="settings" />设置</button>
            <a className={row} href="#/access" data-testid="menu-access" onClick={close}><Icon name="external" />外部接入（MCP）</a>
            {navLink(byId('admin'))}
            {account ? <div className="mt-2 border-t border-hair px-3 pt-3"><p className="truncate text-primary">{account.displayName}</p><p className="truncate text-tertiary">{account.email}</p><p className="text-tertiary">{account.clusterAdmin ? '集群管理员' : roleLabel(account.role)}</p><button className="mt-2 min-h-11 text-secondary hover:text-rust disabled:opacity-40" data-testid="menu-logout" disabled={leave.isPending} onClick={() => leave.mutate()}>退出登录</button></div> : null}
          </div>
        </>}
      </div> : null;
  return <ShellContext.Provider value={{ openMenu: (from) => open('more', from), inboxOpen: panel === 'inbox' && tab === 'attention', panelOpen: panel !== null, attention, notifications, unread }}>
    <div className="flex h-full min-h-0 min-w-0" data-testid="workbench-shell">
      {wide ? <aside aria-label="全局导航" data-testid="app-rail" className="flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-hair bg-panel py-3">
        <div aria-hidden className="mb-4 flex size-8 items-center justify-center rounded-lg bg-fg text-sm font-semibold text-bg">a</div>
        <button type="button" data-testid="shell-workbench" aria-label="工作台" title="工作台" aria-current={route === null || route.page === 'home' || route.page === 'project' ? 'page' : undefined}
          className={`flex w-14 flex-col items-center gap-1 rounded-md py-2 text-[10px] ${route === null || route.page === 'home' || route.page === 'project' ? 'bg-selected text-primary' : 'text-tertiary hover:bg-hover hover:text-primary'}`} onClick={onWorkbench}><Icon name="layers" size={18} />工作台</button>
        {railButton('inbox', '收件箱', 'queue', attention)}
        {railButton('messages', '消息', 'chat', unread)}
        <div className="mt-auto">{railButton('more', '更多', 'more')}</div>
      </aside> : null}
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
      <AttentionAnnouncement count={attention} />
    </div>
    {panel ? wide ? <RailDialog title={panelTitle} panel={panel} trigger={trigger.current} onClose={close}>{panelContent}</RailDialog> : <DialogShell title={panelTitle} onClose={close} testId={`shell-panel-${panel}`}>{panelContent}</DialogShell> : null}
  </ShellContext.Provider>;
}
