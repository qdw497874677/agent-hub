import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../atoms/icons.tsx';
import { RefreshButton, useRefresh } from '../atoms/refresh-button.tsx';
import { adminApi, type AdminWorkerDto, type WorkerInfoDto } from './api.ts';
import { AddMachineDialog } from './add-machine.tsx';
import { HarnessBadges, RecheckButton } from './harness.tsx';
import { InventorySection, RuntimeSection } from './runtimes.tsx';
import { AgentAliasesSection } from './worker-agents.tsx';
import { ResourceDetails, ResourceSummary, formatBytes } from './resources.tsx';
import { LinkBadge } from './link-badge.tsx';
import { AppShell, PageHeader } from './page-shell.tsx';
import { formatRoute, type MachineTab } from './route.ts';
import { useRoute } from './use-route.ts';
import { machineActions, machineUpdateView, machineVersion, type MachineActions } from './machine-actions.ts';
import { canAdminister, useAccount } from './account-context.ts';
import { CapabilityLine, ConnectionLine, Dot, UpdateLine, relativeTime, useWorkers } from './workers.tsx';

/**
 * 机器：一台登记进 hub、真正跑 agent 的机器。全站只有这一个家。
 *
 * - 列表一行一台（Tailscale 式），点进去是 `#/machines/<id>`，可直链、可刷新、手机返回回列表。
 * - 详情三页签进 URL：概览（资源 / 组件）、Agent（运行时 / 别名）、设置（连接 / 凭据 / 危险区）。
 * - 能做哪些管理动作由服务端给的 `actions` 决定；没有的就不出按钮，换成一句「为什么」。
 * - 更新状态和更新动作挨着放：看得见状态，就看得见该怎么动它。
 */

/** 列表回到详情再退回来时，停在原来的滚动位置。 */
let listScrollTop = 0;

const TAB_LABELS: readonly { id: MachineTab; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'agent', label: 'Agent' },
  { id: 'settings', label: '设置' }
];

/** 没带页签的链接（分享、刷新）回落到这台机器上次看的页签。 */
const tabKeyOf = (workerId: string) => `agent-hub:machine-tab:${workerId}`;
const storedTab = (workerId: string): MachineTab => {
  try {
    const saved = globalThis.sessionStorage?.getItem(tabKeyOf(workerId));
    return TAB_LABELS.some((item) => item.id === saved) ? (saved as MachineTab) : 'overview';
  } catch {
    return 'overview';
  }
};
const rememberTab = (workerId: string, tab: MachineTab) => {
  try {
    globalThis.sessionStorage?.setItem(tabKeyOf(workerId), tab);
  } catch {
    // 隐私模式写不进去：这次能切换就行。
  }
};

const buildText = (build: { version: string; commit: string | null } | null | undefined): string =>
  build ? `v${build.version}${build.commit ? ` · ${build.commit.slice(0, 7)}` : ''}` : '版本未知（旧版）';

export function MachinesPage({ workerId, tab }: { workerId: string | null; tab: MachineTab | null }) {
  const [, navigate] = useRoute();
  const account = useAccount();
  const { list, online } = useWorkers();
  const [adding, setAdding] = useState(false);
  const scroll = useRef<HTMLElement>(null);
  const owner = account?.clusterAdmin === true;
  // ['workers'] 就是首页 MachinesBadge 与侧栏共用的那一条：刷这里，别处的在线数一起新。
  const refresh = useRefresh(owner ? [['workers'], ['admin', 'workers']] : [['workers']]);

  // 版本、过期、日志只在管理员接口里；不是管理员就不发这个请求。
  const admin = useQuery({
    queryKey: ['admin', 'workers'],
    queryFn: adminApi.workers,
    enabled: owner,
    refetchInterval: (current) =>
      (current.state.data?.workers ?? []).some((row) => row.update?.state === 'updating' || row.update?.state === 'trial') ? 2000 : 10_000
  });
  const enroll = useQuery({ queryKey: ['enroll-info'], queryFn: adminApi.enrollInfo, staleTime: 60_000 });
  const updateAll = useMutation({
    mutationFn: () => adminApi.updateOutdated(),
    onSuccess: () => {
      void admin.refetch();
    }
  });

  const selected = workerId ? list.find((worker) => worker.workerId === workerId) : undefined;
  const selectedAdmin = selected ? admin.data?.workers.find((row) => row.workerId === selected.workerId) : undefined;
  const hubVersion = admin.data ? `v${admin.data.hub.version}` : null;
  // 版本状态由服务端算（成员也能拿到）：outdated 才敢说过期，unknown 就是不知道。
  const outdated = new Set(list.filter((worker) => machineVersion(worker) === 'outdated').map((worker) => worker.workerId));
  const updatable = list.filter((worker) => machineVersion(worker) === 'outdated' && machineActions(worker).update);

  const rememberScroll = () => {
    listScrollTop = scroll.current?.scrollTop ?? 0;
  };
  // 手机上进详情从顶部看起；退回列表时恢复刚才的位置（桌面两侧并排，列表不动）。
  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    if (workerId) {
      if (globalThis.matchMedia?.('(max-width: 1023px)').matches) node.scrollTop = 0;
    } else {
      node.scrollTop = listScrollTop;
    }
  }, [workerId]);

  const openAdd = enroll.data?.allowed === true ? () => setAdding(true) : undefined;

  return (
    <AppShell testId="machines-page">
      <PageHeader
        title="机器"
        parent={{ label: '首页', href: formatRoute({ page: 'home' }) }}
        actions={
          <>
            <RefreshButton
              testId="machines-refresh"
              label="刷新机器列表"
              busy={refresh.busy}
              error={refresh.error}
              onRefresh={refresh.refresh}
            />
            {openAdd ? (
              <button
                className="flex h-8 items-center gap-1 rounded-sm border border-hair px-2.5 text-sub text-secondary hover:border-strong hover:text-primary"
                onClick={openAdd}
                data-testid="machines-add"
              >
                <span aria-hidden>＋</span> 添加机器
              </button>
            ) : null}
          </>
        }
      />
      <main ref={scroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 lg:px-5 lg:py-5">
        <div className="min-w-0 max-w-[1080px]">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-sub text-secondary" data-testid="machines-summary">
              {list.length === 0 ? '还没有机器' : `${online.length} 在线${list.length > online.length ? ` · ${list.length - online.length} 离线` : ''}`}
            </p>
            {owner && admin.data ? (
              <p className="text-meta text-tertiary" data-testid="hub-version">
                hub {buildText(admin.data.hub)}
              </p>
            ) : null}
            {updatable.length > 0 ? (
              <span className="flex items-center gap-2 text-meta text-tertiary">
                <span>
                  {updatable.length} 台落后于 hub{hubVersion ? ` ${hubVersion}` : ''}
                </span>
                {/* 只有一台时，那一台自己的「更新」就够了；批量按钮出来只添乱。 */}
                {updatable.length > 1 ? (
                  <button
                    className="rounded-sm border border-hair px-2 py-0.5 text-meta text-secondary hover:border-strong hover:text-primary disabled:opacity-50"
                    data-testid="machines-update-all"
                    disabled={updateAll.isPending}
                    onClick={() => updateAll.mutate()}
                  >
                    {updateAll.isPending ? '更新中…' : '全部更新'}
                  </button>
                ) : null}
              </span>
            ) : null}
            {updateAll.isError ? (
              <span role="alert" className="text-meta text-rust">
                {(updateAll.error as Error).message}
              </span>
            ) : null}
          </div>

          {refresh.error ? (
            <p role="alert" data-testid="machines-refresh-error" className="mb-3 text-meta text-rust">
              刷新没成功：{refresh.error}
            </p>
          ) : null}

          <div className="lg:grid lg:grid-cols-[300px_minmax(0,1fr)] lg:items-start lg:gap-5">
            <aside aria-label="机器列表" className={workerId ? 'hidden lg:block' : ''}>
              {list.length === 0 ? (
                <div className="rounded-lg border border-hair bg-panel px-4 py-6">
                  <p className="text-body text-secondary">还没有机器连上。它起来后会自己报到——刚启动的话等几秒。</p>
                  {openAdd ? (
                    <p className="mt-3 text-meta text-tertiary">点右上角「添加机器」生成一行命令，在要加入的机器上运行。</p>
                  ) : enroll.data && !enroll.data.allowed ? (
                    <p className="mt-3 text-meta text-tertiary">要加机器请联系主人</p>
                  ) : null}
                </div>
              ) : (
                <>
                  <ul className="overflow-hidden rounded-lg border border-hair bg-panel">
                    {list.map((worker) => (
                      <MachineRow
                        key={worker.workerId}
                        worker={worker}
                        current={worker.workerId === workerId}
                        outdated={outdated.has(worker.workerId)}
                        onOpen={rememberScroll}
                      />
                    ))}
                  </ul>
                  {openAdd ? null : enroll.data && !enroll.data.allowed ? (
                    <p className="px-1 pt-2 text-meta text-tertiary">要加机器请联系主人</p>
                  ) : null}
                </>
              )}
            </aside>

            <section aria-label="机器详情" className={`min-w-0 ${workerId ? '' : 'hidden lg:block'}`}>
              {selected ? (
                <MachineDetail
                  key={selected.workerId}
                  worker={selected}
                  adminRow={selectedAdmin}
                  tab={tab ?? storedTab(selected.workerId)}
                  onTab={(next) => {
                    rememberTab(selected.workerId, next);
                    navigate({ page: 'machines', workerId: selected.workerId, tab: next }, 'replace');
                  }}
                  onRevoked={() => navigate({ page: 'machines', workerId: null, tab: null }, 'replace')}
                />
              ) : workerId ? (
                <div className="rounded-lg border border-hair bg-panel px-4 py-6" data-testid="machine-missing">
                  <p className="text-body text-secondary">这台机器不在了——可能刚被吊销。</p>
                  <a href={formatRoute({ page: 'machines', workerId: null, tab: null })} className="mt-2 inline-block text-sub text-secondary underline hover:text-primary">
                    回机器列表
                  </a>
                </div>
              ) : (
                <div className="hidden rounded-lg border border-dashed border-hair px-4 py-8 lg:block">
                  <p className="text-body text-tertiary">选左边一台机器，看它的状态、运行时和凭据。</p>
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
      {adding ? <AddMachineDialog workers={list} onClose={() => setAdding(false)} /> : null}
    </AppShell>
  );
}

/** 列表一行：状态点、名字、一句状态、资源摘要；过期是小小一个标记，不抢注意力。 */
function MachineRow({
  worker,
  current,
  outdated,
  onOpen
}: {
  worker: WorkerInfoDto;
  current: boolean;
  outdated: boolean;
  onOpen: () => void;
}) {
  const online = worker.state === 'online';
  const down = (worker.agentModels ?? []).filter((harness) => harness.readiness?.state === 'unavailable').length;
  const link = worker.link && worker.link.state !== 'live' ? worker.link : undefined;
  return (
    <li className="border-b border-hair last:border-b-0" data-testid="machine-row">
      <a
        href={formatRoute({ page: 'machines', workerId: worker.workerId, tab: null })}
        onClick={onOpen}
        aria-current={current ? 'page' : undefined}
        className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-hover ${current ? 'bg-selected' : ''}`}
      >
        <Dot online={online} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-1.5">
            <span className="truncate text-body text-primary">{worker.label}</span>
            {worker.origin === 'local' && worker.label !== '本机' ? <span className="text-meta text-tertiary">本机</span> : null}
            {outdated ? (
              <span className="rounded-sm border border-hair px-1 text-meta text-tertiary" data-testid="machine-outdated">
                过期
              </span>
            ) : null}
            {online ? <LinkBadge link={link} /> : null}
          </span>
          <span className="block truncate text-meta text-tertiary">
            {online
              ? `${worker.sessionCount ?? 0} 个会话${down > 0 ? ` · ${down} 个 agent 不可用` : ''}`
              : `离线 · ${relativeTime(worker.lastSeenAt)}${worker.reason ? ` · ${worker.reason}` : ''}`}
          </span>
          <ResourceSummary worker={worker} />
        </span>
        <Icon name="chevron-right" size={14} className="text-tertiary" />
      </a>
    </li>
  );
}

/** 详情里的一块：灰色小标题 + 两列表格（左边短标签，右边内容）。 */
function DetailSection({ title, children, testId }: { title?: string; children: ReactNode; testId?: string }) {
  return (
    <section className="border-t border-hair px-3 py-3 first:border-t-0 first:pt-0" data-testid={testId}>
      {title ? <h4 className="mb-2 text-meta text-tertiary">{title}</h4> : null}
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 text-meta">{children}</dl>
    </section>
  );
}

/** 概览：四个数字，压力偏高的那项变色。没上报资源的老 worker 不显示。 */
function WorkerStats({ worker }: { worker: WorkerInfoDto }) {
  const r = worker.resources;
  if (worker.state !== 'online' || !r) return null;
  const m = r.sample.machine;
  const mem = m.memTotal > 0 ? Math.round(((m.memTotal - m.memAvailable) / m.memTotal) * 100) : 0;
  const free = m.disks.length === 0 ? null : Math.min(...m.disks.map((disk) => disk.free));
  const gpu = m.gpus?.length ? Math.round(Math.max(...m.gpus.map((item) => item.utilPercent ?? 0))) : null;
  const hot = r.pressure.level === 'ok' ? 'text-primary' : r.pressure.level === 'warn' ? 'text-rust' : 'text-red-500';
  const tiles: { label: string; value: string; tone?: string }[] = [
    { label: 'CPU', value: m.cpuPercent === null ? '—' : `${Math.round(m.cpuPercent)}%` },
    { label: '内存', value: `${mem}%`, tone: mem >= 85 ? hot : 'text-primary' },
    { label: '磁盘剩余', value: free === null ? '—' : formatBytes(free) },
    gpu === null ? { label: '会话', value: String(worker.sessionCount ?? 0) } : { label: 'GPU', value: `${gpu}%` }
  ];
  return (
    <div className="grid grid-cols-4 gap-1.5 pb-3" data-testid="worker-stats">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-md bg-card px-2 py-1.5">
          <p className="text-meta text-tertiary">{tile.label}</p>
          <p className={`text-head tabular-nums ${tile.tone ?? 'text-primary'}`}>{tile.value}</p>
        </div>
      ))}
    </div>
  );
}

function MachineDetail({
  worker,
  adminRow,
  tab,
  onTab,
  onRevoked
}: {
  worker: WorkerInfoDto;
  adminRow: AdminWorkerDto | undefined;
  tab: MachineTab;
  onTab: (tab: MachineTab) => void;
  onRevoked: () => void;
}) {
  const account = useAccount();
  const actions = machineActions(worker);
  const online = worker.state === 'online';
  const host = [worker.hostname, worker.platform].filter(Boolean).join(' · ');
  const harnesses = worker.agentModels ?? [];
  const link = worker.link && worker.link.state !== 'live' ? worker.link : undefined;

  // WAI-ARIA 页签：←/→ 在页签间移动并激活，Home/End 到两端。
  const onTabKey = (event: React.KeyboardEvent<HTMLElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const at = TAB_LABELS.findIndex((item) => item.id === tab);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? TAB_LABELS.length - 1
          : (at + (event.key === 'ArrowRight' ? 1 : -1) + TAB_LABELS.length) % TAB_LABELS.length;
    const picked = TAB_LABELS[next];
    if (!picked) return;
    onTab(picked.id);
    event.currentTarget.querySelector<HTMLElement>(`#machine-tab-${picked.id}`)?.focus();
  };

  return (
    <div className="rounded-lg border border-hair bg-panel" data-testid="worker-detail">
      <header className="flex flex-wrap items-center gap-2 px-3 pb-2 pt-3">
        <a
          href={formatRoute({ page: 'machines', workerId: null, tab: null })}
          className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary lg:hidden"
          aria-label="返回机器列表"
          title="返回机器列表"
        >
          <Icon name="chevron-left" />
        </a>
        <Dot online={online} />
        <h2 className="min-w-0 truncate text-head text-primary">{worker.label}</h2>
        <span className="shrink-0 rounded-sm bg-card px-1.5 text-meta text-tertiary">{worker.origin === 'local' ? '本机' : '远程'}</span>
        {machineVersion(worker) === 'outdated' ? (
          <span className="shrink-0 rounded-sm border border-hair px-1 text-meta text-tertiary" data-testid="worker-outdated">
            过期
          </span>
        ) : null}
        <span className="ml-auto flex min-w-0 shrink-0 items-center gap-2 text-meta text-tertiary">
          <span data-testid="worker-version">{adminRow?.build ? buildText(adminRow.build) : worker.connection?.version ? buildText({ version: worker.connection.version, commit: null }) : '版本未知（旧版）'}</span>
          {online ? <LinkBadge link={link} /> : <span>离线 · {relativeTime(worker.lastSeenAt)}</span>}
        </span>
      </header>

      <UpdatePanel worker={worker} actions={actions} adminRow={adminRow} />

      <div role="tablist" aria-label="机器详情" className="flex gap-1 border-b border-hair px-3" onKeyDown={onTabKey}>
        {TAB_LABELS.map((item) => (
          <button
            key={item.id}
            role="tab"
            id={`machine-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`machine-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            data-testid={`worker-tab-${item.id}`}
            className={`-mb-px border-b-2 px-2 py-1.5 text-sub ${tab === item.id ? 'border-primary text-primary' : 'border-transparent text-tertiary hover:text-secondary'}`}
            onClick={() => onTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`machine-panel-${tab}`} aria-labelledby={`machine-tab-${tab}`} className="pb-2 pt-3">
        {tab === 'overview' ? (
          <>
            <div className="px-3">
              <WorkerStats worker={worker} />
            </div>
            {online && worker.resources ? (
              <DetailSection title="资源">
                <ResourceDetails worker={worker} canConfigure={actions.configureResources} />
              </DetailSection>
            ) : null}
            {online && worker.inventory ? (
              <DetailSection title="组件">
                <InventorySection worker={worker} canInstall={actions.installComponent} />
              </DetailSection>
            ) : null}
            {!online ? <p className="px-3 pb-2 text-meta text-tertiary">离线，回来之后再看</p> : null}
          </>
        ) : null}

        {tab === 'agent' ? (
          online ? (
            <DetailSection>
              {harnesses.length > 0 ? (
                <>
                  <dt className="text-tertiary">可用</dt>
                  <dd className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="worker-harnesses">
                    <HarnessBadges harnesses={harnesses} />
                    <RecheckButton workerId={worker.workerId} />
                  </dd>
                </>
              ) : null}
              <RuntimeSection worker={worker} canInstall={actions.installRuntime} />
              <AgentAliasesSection worker={worker} />
              {canAdminister(account) ? null : (
                <p className="col-span-2 text-meta text-tertiary" data-testid="machine-aliases-note">
                  运行时别名只有 owner / admin 能看和改。
                </p>
              )}
            </DetailSection>
          ) : (
            <p className="px-3 pb-2 text-meta text-tertiary">离线，回来之后再看</p>
          )
        ) : null}

        {tab === 'settings' ? (
          <>
            <DetailSection title="连接" testId="machine-settings-connection">
              {host ? (
                <>
                  <dt className="text-tertiary">主机</dt>
                  <dd className="truncate text-secondary">{host}</dd>
                </>
              ) : null}
              {worker.connection ? (
                <>
                  <dt className="text-tertiary">连接</dt>
                  <dd className="min-w-0 text-secondary">
                    <ConnectionLine connection={worker.connection} />
                  </dd>
                </>
              ) : (
                <>
                  <dt className="text-tertiary">最后在线</dt>
                  <dd className="text-secondary">{online ? '现在' : relativeTime(worker.lastSeenAt)}</dd>
                </>
              )}
              {(worker.roots ?? []).length > 0 ? (
                <>
                  <dt className="text-tertiary">可用目录</dt>
                  <dd
                    className="min-w-0 font-mono text-secondary"
                    title="hub 只能访问这些目录。要放开，在那台机器上改 WORKER_ROOTS（装成服务的在 ~/.config/agent-hub/worker.env）后重启 agent-hub-worker。"
                  >
                    {(worker.roots ?? []).map((root) => (
                      <span key={root} className="block truncate">
                        {root}
                      </span>
                    ))}
                  </dd>
                </>
              ) : null}
              <dt className="text-tertiary">ID</dt>
              <dd className="truncate font-mono text-tertiary">{worker.workerId}</dd>
            </DetailSection>

            {worker.capabilities || worker.origin === 'remote' ? (
              <DetailSection title="安全" testId="machine-settings-security">
                {worker.capabilities ? (
                  <>
                    <dt className="text-tertiary">权限</dt>
                    <dd className="min-w-0 text-secondary">
                      <CapabilityLine capabilities={worker.capabilities} />
                    </dd>
                  </>
                ) : null}
                {actions.rotateCredential ? <RotateCredential worker={worker} online={online} /> : null}
                {worker.origin === 'remote' && !actions.rotateCredential && !actions.revokeCredential ? (
                  <p className="col-span-2 text-meta text-tertiary" data-testid="machine-managed-by-owner">
                    这台机器由接入它的人管理。
                  </p>
                ) : null}
              </DetailSection>
            ) : null}

            <DangerZone worker={worker} actions={actions} online={online} onRevoked={onRevoked} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 更新：状态和动作挨着。
 *
 * 一行说清现在处在哪一步（已是最新 / 落后 / 更新中 / 失败回退 / 不接受远程更新 / 和 hub 同源），
 * 右边是此刻唯一有意义的动作。没权限的人看到同一句状态 + 一句「等谁来做」。
 */
function UpdatePanel({
  worker,
  actions,
  adminRow
}: {
  worker: WorkerInfoDto;
  actions: MachineActions;
  adminRow: AdminWorkerDto | undefined;
}) {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: () => adminApi.updateWorker(worker.workerId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['workers'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'workers'] });
    }
  });
  const version = machineVersion(worker);
  const view = machineUpdateView(worker, actions);
  const failed = worker.update?.state === 'failed' || worker.update?.state === 'rolled_back';
  const logTail = adminRow?.update?.logTail ?? '';

  // 同一时刻只给一个动作：失败就只给「重试」，不再并排一个「更新」。
  const label = update.isPending ? '提交中…' : view.action === 'retry' ? '重试' : view.action === 'update' ? '更新' : '试运行一次';
  const action = (() => {
    switch (view.action) {
      case 'none':
        return null;
      case 'blocked-online':
        return <span className="text-meta text-tertiary">回来之后才能更新</span>;
      case 'busy':
        return <span className="text-meta text-tertiary">更新中…</span>;
      case 'blocked-owner':
        return <span className="text-meta text-tertiary">等 hub 主人更新这台机器</span>;
      case 'blocked-version':
        return <span className="text-meta text-tertiary">版本核对好之后才能更新</span>;
      default:
        return (
          <button
            className="shrink-0 rounded-sm border border-hair px-2.5 py-1 text-meta text-secondary hover:border-strong hover:text-primary disabled:opacity-50"
            data-testid="machine-update-button"
            disabled={update.isPending}
            title={version === 'outdated' || failed ? '失败会自动回退到当前版本' : '已是最新：只做一次演练，不会重启'}
            onClick={() => update.mutate()}
          >
            {label}
          </button>
        );
    }
  })();

  return (
    <div className="mx-3 mb-3 flex flex-wrap items-start justify-between gap-2 rounded-md border border-hair bg-card px-2.5 py-2" data-testid="machine-update">
      <div className="min-w-0 flex-1">
        <p className="text-meta text-tertiary">更新</p>
        <p
          className={`min-w-0 break-words text-meta ${failed ? 'text-rust' : 'text-secondary'}`}
          data-testid="worker-update-line"
        >
          {worker.update ? <UpdateLine update={worker.update} /> : view.status}
        </p>
        {worker.update ? (
          <p className={`min-w-0 break-words text-meta ${failed ? 'text-rust' : 'text-tertiary'}`} data-testid="worker-update">
            {view.status}
          </p>
        ) : null}
        {update.isError ? (
          <p role="alert" className="text-meta text-rust">
            {(update.error as Error).message}
          </p>
        ) : null}
        {actions.updateLogs && logTail ? (
          <details className="mt-1" data-testid="machine-update-logs">
            <summary className="cursor-pointer text-meta text-tertiary hover:text-secondary">日志</summary>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-snug text-tertiary">{logTail}</pre>
          </details>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 pt-4">{action}</div>
    </div>
  );
}

/** 危险区：断开（owner，远程在线）与吊销（管得了这台机器的人）。都两步确认，4 秒内不点就收回。 */
function DangerZone({
  worker,
  actions,
  online,
  onRevoked
}: {
  worker: WorkerInfoDto;
  actions: MachineActions;
  online: boolean;
  onRevoked: () => void;
}) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['workers'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'workers'] });
  };
  const disconnect = useMutation({ mutationFn: () => adminApi.disconnect(worker.workerId), onSettled: refresh });
  const revoke = useMutation({
    mutationFn: () => adminApi.revokeWorker(worker.workerId),
    onSuccess: () => {
      refresh();
      onRevoked();
    }
  });
  const remote = worker.origin === 'remote';
  if (!actions.disconnect && !actions.revokeCredential) return null;
  return (
    <DetailSection title="危险区" testId="machine-danger-zone">
      {actions.disconnect && online && remote ? (
        <p className="col-span-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 text-tertiary">断开：它不会自动重连，要重新接一次。</span>
          <ArmedAction
            label="断开"
            confirm="确认断开"
            busy={disconnect.isPending}
            error={disconnect.isError ? (disconnect.error as Error).message : null}
            onConfirm={() => disconnect.mutate()}
            testId="machine-disconnect"
          />
        </p>
      ) : null}
      {actions.revokeCredential && remote ? (
        <p className="col-span-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 text-tertiary">吊销：作废凭据并立刻断开，要重新「添加机器」才能回来。</span>
          <ArmedAction
            label="吊销这台机器"
            confirm="确认吊销"
            busy={revoke.isPending}
            error={revoke.isError ? (revoke.error as Error).message : null}
            onConfirm={() => revoke.mutate()}
            testId="machine-revoke"
          />
        </p>
      ) : null}
    </DetailSection>
  );
}

function ArmedAction({
  label,
  confirm,
  busy,
  error,
  onConfirm,
  testId
}: {
  label: string;
  confirm: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  testId: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <span className="flex shrink-0 flex-col items-end gap-0.5">
      <button
        className={`shrink-0 rounded-sm border px-2.5 py-1 text-meta ${
          armed ? 'border-rust bg-rust text-canvas' : 'border-hair text-secondary hover:border-rust hover:text-rust'
        }`}
        data-testid={testId}
        disabled={busy}
        onClick={() => (armed ? onConfirm() : setArmed(true))}
      >
        {busy ? '处理中…' : armed ? confirm : label}
      </button>
      {error ? (
        <span role="alert" className="max-w-56 break-words text-right text-xs text-rust">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/**
 * 轮换凭据（ADR 0030 D3，只手动）：新凭据经当前连接下发，Worker 写进 worker.env 后用它重连；
 * 旧凭据宽限 5 分钟，没换上就作废新的、留旧的。离线不能轮换。
 */
function RotateCredential({ worker, online }: { worker: WorkerInfoDto; online: boolean }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['workers', worker.workerId, 'credential'],
    queryFn: () => adminApi.credentialStatus(worker.workerId),
    retry: false,
    refetchInterval: (query) => (query.state.data?.rotation === 'pending' ? 3000 : false)
  });
  const rotate = useMutation({
    mutationFn: () => adminApi.rotateWorker(worker.workerId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['workers', worker.workerId, 'credential'] })
  });
  if (!status.data) return null;
  const s = status.data;
  const text =
    s.rotation === 'pending'
      ? '轮换中：等它用新凭据重连…'
      : s.rotation === 'failed'
        ? `上次轮换失败（${relativeTime(s.rotationFailedAt ?? Date.now())}），旧凭据仍有效`
        : s.rotation === 'rotated'
          ? `${relativeTime(s.rotatedAt ?? Date.now())}轮换过`
          : '从未轮换';
  return (
    <>
      <dt className="text-tertiary">凭据</dt>
      <dd className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-secondary" data-testid="credential-rotation">
        <span className={`min-w-0 ${s.rotation === 'failed' ? 'text-rust' : ''}`} role={rotate.isError ? 'alert' : undefined}>
          {rotate.isError ? (rotate.error as Error).message : text}
        </span>
        <button
          className="shrink-0 rounded-sm border border-hair px-2.5 py-1 text-meta text-secondary hover:border-strong hover:text-primary disabled:opacity-50"
          disabled={!online || rotate.isPending || s.rotation === 'pending'}
          title={online ? '生成新凭据并下发，旧的 5 分钟后作废' : '机器离线不能轮换；只能吊销后重新配对'}
          onClick={() => rotate.mutate()}
        >
          {rotate.isPending ? '下发中…' : '轮换凭据'}
        </button>
      </dd>
    </>
  );
}
