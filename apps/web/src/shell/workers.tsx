import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../atoms/icons.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi, api, type WorkerInfoDto } from './api.ts';
import { AddMachineDialog } from './add-machine.tsx';
import { HarnessBadges, RecheckButton } from './harness.tsx';
import { InventorySection, RuntimeSection } from './runtimes.tsx';
import { AgentAliasesSection } from './worker-agents.tsx';
import { ResourceDetails, ResourceSummary, formatBytes } from './resources.tsx';
import { LinkBadge } from './link-badge.tsx';

/**
 * Worker：一台登记进 hub、真正跑 agent 的机器。
 *
 * 设计取向（见 docs/design/multi-worker-research.md）：像 Tailscale 的机器列表那样，
 * 一行一台、状态点 + 名字 + 一句「最后一次见到」，细节按需展开；
 * 只有一台机器时整套多机界面都不出现——单机用户不该为没用到的能力付出注意力。
 */

export function useWorkers() {
  // 有安装任务在跑时 1 秒刷一次看进度（ADR 0010：轮询，不另开推送通道）
  const query = useQuery({
    queryKey: ['workers'],
    queryFn: api.workers,
    refetchInterval: (current) => ((current.state.data ?? []).some((worker) => worker.runtimeJob?.state === 'running') ? 1000 : 5000)
  });
  const list = query.data ?? [];
  return {
    list,
    online: list.filter((worker) => worker.state === 'online'),
    /** 多于一台（含离线的）才需要在界面上区分「在哪台」。 */
    multi: list.length > 1,
    byId: (id: string | null | undefined) => list.find((worker) => worker.workerId === id)
  };
}

/** 老数据里本机 worker 的 workerId 记作 null（新数据记真实 id）：null 解析成「本机那台」。 */
export function resolveWorker(workers: readonly WorkerInfoDto[], id: string | null | undefined) {
  if (id) return workers.find((worker) => worker.workerId === id);
  return workers.find((worker) => worker.origin === 'local');
}

/**
 * 这条会话所在的机器此刻不在线时，给一句人话；在线（或还没拿到列表）返回 null。
 * 单机也要提示：本机 worker 掉了，发出去的话只会换来一个「不可用」。
 */
export function useOfflineNotice(workerId: string | null | undefined): string | null {
  const { list } = useWorkers();
  if (list.length === 0) return null;
  const worker = resolveWorker(list, workerId);
  if (worker?.state === 'online') return null;
  const name = worker?.label ?? '这台机器';
  return `${name} 离线${worker?.reason ? `（${worker.reason}）` : ''}，回来之后再发`;
}

export function relativeTime(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return '—';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86400)} 天前`;
}

const Dot = ({ online }: { online: boolean }) => (
  <span
    aria-hidden
    className={`block size-[7px] shrink-0 rounded-full ${online ? 'bg-sage' : 'bg-rust'}`}
  />
);

/** 卡片 / 检查器上的「跑在哪台」：一个点加名字，离线时整体变暗。 */
export function WorkerChip({ worker, fallback }: { worker: WorkerInfoDto | undefined; fallback?: string }) {
  const online = worker?.state === 'online';
  const label = worker?.label ?? fallback ?? '未知机器';
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 rounded-sm border border-hair px-1.5 py-px text-meta ${
        online ? 'text-secondary' : 'text-tertiary'
      }`}
      title={worker ? `${worker.label} · ${online ? '在线' : `离线${worker.reason ? `：${worker.reason}` : ''}`}` : label}
    >
      <Dot online={online} />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** 凭据能力的中文名（与 domain WORKER_CAPABILITY_LABELS 同义；web 不直接依赖 domain）。 */
const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  sessions: '跑 agent',
  'files.read': '读文件',
  'files.write': '改文件',
  git: 'git',
  'git.remote': '推送 / 开 PR',
  runtimes: '装运行时',
  update: '远程更新'
};
const ALL_CAPABILITIES = Object.keys(CAPABILITY_LABELS);

/** 「上次连上 3 分钟前 · 来自 1.2.3.4 · 版本 abc1234」（ADR 0030 D3）。 */
const UPDATE_STATE_TEXT: Record<string, string> = { updating: '更新中', succeeded: '更新成功', failed: '更新失败', refused: '拒绝更新', rolled_back: '已回退' };

/** 最近一次远程更新：试运行（ADR 0030 D2）显示剩余秒数。 */
export function UpdateLine({ update }: { update: NonNullable<WorkerInfoDto['update']> }) {
  const label =
    update.state === 'trial'
      ? `试运行中（剩 ${Math.max(0, Math.ceil((update.trialRemainingMs ?? 0) / 1000))}s）`
      : (UPDATE_STATE_TEXT[update.state] ?? update.state);
  return (
    <span className="block break-words" title={new Date(update.at).toLocaleString()}>
      {label}：{update.message}
    </span>
  );
}

export function ConnectionLine({ connection }: { connection: NonNullable<WorkerInfoDto['connection']> }) {
  const parts = [`${relativeTime(connection.connectedAt)} 连上`];
  if (connection.address) parts.push(`来自 ${connection.address}`);
  if (connection.version) parts.push(`版本 ${connection.version.slice(0, 7)}`);
  return (
    <span className="block truncate" title={new Date(connection.connectedAt).toLocaleString()}>
      {parts.join(' · ')}
    </span>
  );
}

export function CapabilityLine({ capabilities }: { capabilities: readonly string[] }) {
  const missing = ALL_CAPABILITIES.filter((c) => !capabilities.includes(c));
  if (missing.length === 0) return <span>全部</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {ALL_CAPABILITIES.map((c) => (
        <span
          key={c}
          className={
            capabilities.includes(c)
              ? 'rounded border border-hair px-1.5 text-xs text-secondary'
              : 'rounded px-1.5 text-xs text-tertiary line-through'
          }
        >
          {CAPABILITY_LABELS[c]}
        </span>
      ))}
    </span>
  );
}

/** 机器列表的一行：名字、在线状态一句话、资源摘要。点进去看详情。 */
function WorkerRow({ worker, onOpen }: { worker: WorkerInfoDto; onOpen: () => void }) {
  const online = worker.state === 'online';
  const down = (worker.agentModels ?? []).filter((harness) => harness.readiness?.state === 'unavailable').length;
  const link = worker.link && worker.link.state !== 'live' ? worker.link : undefined;
  return (
    <li className="border-b border-hair last:border-b-0">
      <button className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-hover" onClick={onOpen}>
        <Dot online={online} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-body text-primary">{worker.label}</span>
            {worker.origin === 'local' && worker.label !== '本机' ? <span className="text-meta text-tertiary">本机</span> : null}
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
      </button>
    </li>
  );
}

/** 详情里的一块：灰色小标题 + 两列表格（左边短标签，右边内容）。 */
function DetailSection({ title, children, testId }: { title?: string; children: ReactNode; testId?: string }) {
  return (
    <section className="border-t border-hair px-3 py-3 first:border-t-0" data-testid={testId}>
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
    <div className="grid grid-cols-4 gap-1.5 px-3 pb-3" data-testid="worker-stats">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-md bg-card px-2 py-1.5">
          <p className="text-meta text-tertiary">{tile.label}</p>
          <p className={`text-head tabular-nums ${tile.tone ?? 'text-primary'}`}>{tile.value}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * 一台机器的详情：头部是名字和状态，下面三个页签——
 * 概览（四个数字 + 资源 / 组件）、Agent（能用哪些、运行时、别名）、设置（连接、权限、凭据，吊销放最后）。
 */
type DetailTab = 'overview' | 'agent' | 'settings';
const DETAIL_TABS: readonly { id: DetailTab; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'agent', label: 'Agent' },
  { id: 'settings', label: '设置' }
];

function WorkerDetail({ worker, onBack }: { worker: WorkerInfoDto; onBack: () => void }) {
  const [tab, setTab] = useState<DetailTab>('overview');
  const online = worker.state === 'online';
  const host = [worker.hostname, worker.platform].filter(Boolean).join(' · ');
  const harnesses = worker.agentModels ?? [];
  return (
    <div data-testid="worker-detail">
      <header className="flex items-center gap-2 px-2 pb-2 pt-2">
        <button
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary"
          aria-label="返回机器列表"
          title="返回机器列表"
          onClick={onBack}
        >
          <Icon name="chevron-left" />
        </button>
        <Dot online={online} />
        <h3 className="min-w-0 truncate text-head text-primary">{worker.label}</h3>
        <span className="shrink-0 rounded-sm bg-card px-1.5 text-meta text-tertiary">{worker.origin === 'local' ? '本机' : '远程'}</span>
        <span className="ml-auto shrink-0 pr-1 text-meta text-tertiary">
          {online ? <LinkBadge link={worker.link} /> : `离线 · ${relativeTime(worker.lastSeenAt)}`}
        </span>
      </header>
      <div role="tablist" aria-label="机器详情" className="flex gap-1 border-b border-hair px-3">
        {DETAIL_TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            id={`worker-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`worker-panel-${item.id}`}
            data-testid={`worker-tab-${item.id}`}
            className={`-mb-px border-b-2 px-2 py-1.5 text-sub ${tab === item.id ? 'border-primary text-primary' : 'border-transparent text-tertiary hover:text-secondary'}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`worker-panel-${tab}`}
        aria-labelledby={`worker-tab-${tab}`}
        className="max-h-[min(65vh,600px)] overflow-y-auto overscroll-contain pb-1 pt-3"
      >
        {tab === 'overview' ? (
          <>
            <WorkerStats worker={worker} />
            {online && worker.resources ? (
              <DetailSection title="资源">
                <ResourceDetails worker={worker} />
              </DetailSection>
            ) : null}
            {online && worker.inventory ? (
              <DetailSection title="组件">
                <InventorySection worker={worker} />
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
                  <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <HarnessBadges harnesses={harnesses} hints={false} />
                    <RecheckButton workerId={worker.workerId} />
                  </dd>
                </>
              ) : null}
              <RuntimeSection worker={worker} />
              <AgentAliasesSection worker={worker} />
            </DetailSection>
          ) : (
            <p className="px-3 pb-2 text-meta text-tertiary">离线，回来之后再看</p>
          )
        ) : null}
        {tab === 'settings' ? (
          <>
            <DetailSection title="连接">
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
              {worker.update ? (
                <>
                  <dt className="text-tertiary">更新</dt>
                  <dd data-testid="worker-update-line" className={`min-w-0 ${worker.update.state === 'failed' || worker.update.state === 'rolled_back' ? 'text-rust' : 'text-secondary'}`}>
                    <UpdateLine update={worker.update} />
                  </dd>
                </>
              ) : null}
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
              <DetailSection title="安全">
                {worker.capabilities ? (
                  <>
                    <dt className="text-tertiary">权限</dt>
                    <dd className="min-w-0 text-secondary">
                      <CapabilityLine capabilities={worker.capabilities} />
                    </dd>
                  </>
                ) : null}
                {worker.origin === 'remote' ? <RotateCredential worker={worker} online={online} /> : null}
                {worker.origin === 'remote' ? <RevokeButton worker={worker} /> : null}
              </DetailSection>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 轮换凭据（ADR 0030 D3，只手动）：新凭据经当前连接下发，Worker 写进 worker.env 后用它重连；
 * 旧凭据宽限 5 分钟，没换上就作废新的、留旧的。离线不能轮换。没有专属凭据（共享令牌接入）的机器不显示。
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
          className="shrink-0 rounded-sm border border-hair px-2.5 py-1 text-meta text-secondary hover:border-accent hover:text-primary disabled:opacity-50"
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

/** 吊销：点一次变成「确认吊销」，再点才真做——这是不可撤销的（那台要重新接入）。 */
function RevokeButton({ worker }: { worker: WorkerInfoDto }) {
  const queryClient = useQueryClient();
  const [armed, setArmed] = useState(false);
  const revoke = useMutation({
    mutationFn: () => adminApi.revokeWorker(worker.workerId),
    onSettled: () => {
      setArmed(false);
      void queryClient.invalidateQueries({ queryKey: ['workers'] });
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    }
  });
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <dd className="col-span-2 mt-1.5 flex items-center justify-between gap-2">
      <span className="min-w-0 text-xs text-rust" role={revoke.isError ? 'alert' : undefined}>
        {revoke.isError ? (revoke.error as Error).message : armed ? '它会立刻断开，要重新接入才能回来' : ''}
      </span>
      <button
        className={`shrink-0 rounded-sm border px-2.5 py-1 text-meta ${
          armed ? 'border-rust bg-rust text-canvas' : 'border-hair text-secondary hover:border-rust hover:text-rust'
        }`}
        disabled={revoke.isPending}
        onClick={() => (armed ? revoke.mutate() : setArmed(true))}
      >
        {revoke.isPending ? '吊销中…' : armed ? '确认吊销' : '吊销这台机器'}
      </button>
    </dd>
  );
}

/**
 * 顶栏的机器状态 + 管理面板。面板本身就是机器列表：
 * 在线的排前面，离线的留着（带最后在线时间和原因），点开看主机、目录、ID。
 */
export function WorkersBadge({ placement = 'down' }: { placement?: 'down' | 'up' }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const { list, online } = useWorkers();
  // 选中的那台被吊销 / 消失了，就回到列表
  const detail = picked ? list.find((worker) => worker.workerId === picked) : undefined;
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    // Esc：在详情里先退回列表，再按一次才收起
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setPicked((current) => {
        if (current === null) setOpen(false);
        return null;
      });
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const tone = list.length === 0 ? 'bg-tertiary' : online.length > 0 ? 'bg-sage' : 'bg-rust';
  return (
    <div className="relative" ref={box}>
      <button
        className="flex h-7 max-w-full items-center gap-1.5 rounded-md px-2 text-meta text-secondary hover:bg-hover hover:text-primary"
        onClick={() => {
          setOpen((current) => !current);
          setPicked(null);
        }}
        aria-expanded={open}
        aria-label={`机器：${online.length}/${list.length} 在线`}
        title="机器：跑 agent 的机器"
      >
        <span className={`block size-[7px] rounded-full ${tone}`} />
        {list.length === 0 ? '没有机器' : list.length === 1 ? (list[0]?.label ?? '机器') : `${online.length}/${list.length} 机器`}
      </button>

      {open ? (
        <div className={`z-30 ${
            placement === 'up'
              ? // 窄屏贴底成一张 sheet（拇指够得着）；宽屏浮在侧栏左下、徽标上方。看详情时宽一点。
                `fixed inset-x-3 bottom-3 md:inset-x-auto md:bottom-12 md:left-3 ${detail ? 'md:w-[420px]' : 'md:w-[340px]'}`
              : `absolute right-0 top-9 ${detail ? 'w-[min(420px,calc(100vw-1.5rem))]' : 'w-[min(340px,calc(100vw-1.5rem))]'}`
          }`}><div className="overflow-hidden rounded-md border border-strong bg-panel shadow-lg">
          {detail ? (
            <WorkerDetail key={detail.workerId} worker={detail} onBack={() => setPicked(null)} />
          ) : (
          <>
          <header className="flex items-baseline justify-between border-b border-hair px-3 py-2">
            <span className="text-sub text-primary">机器</span>
            <span className="text-meta text-tertiary">
              {online.length} 在线{list.length > online.length ? ` · ${list.length - online.length} 离线` : ''}
            </span>
          </header>
          {list.length === 0 ? (
            <p className="px-3 py-3 text-meta text-tertiary">还没有机器连上。它起来后会自己报到——刚启动的话等几秒。</p>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto">
              {list.map((worker) => (
                <WorkerRow key={worker.workerId} worker={worker} onOpen={() => setPicked(worker.workerId)} />
              ))}
            </ul>
          )}
          <EnrollFooter onAdd={() => { setOpen(false); setAdding(true); }} />
          </>
          )}
        </div>
        </div>
      ) : null}
      {adding ? <AddMachineDialog workers={list} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

/** 分段选择：选「在哪台跑」。只有一台时不渲染。 */
export function WorkerPicker({
  value,
  onChange,
  workers,
  allowAuto,
  label = '在哪台跑',
  unavailable = () => null
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  workers: readonly WorkerInfoDto[];
  allowAuto?: boolean;
  label?: string;
  /** 这台上要用的 harness 不可用的原因（变灰、不能选）；null = 能用。 */
  unavailable?: (worker: WorkerInfoDto) => string | null;
}) {
  if (workers.length < 2) return null;
  const option = (
    id: string | null,
    text: string,
    online: boolean,
    disabled = false,
    why: string | null = null,
    origin?: WorkerInfoDto['origin']
  ) => (
    <button
      key={id ?? 'auto'}
      type="button"
      role="radio"
      aria-checked={value === id}
      disabled={disabled}
      onClick={() => onChange(id)}
      title={why ? `${text}：${why}` : undefined}
      className={`flex min-h-[32px] min-w-0 items-center gap-1.5 rounded-sm border px-2 py-1 text-meta disabled:opacity-40 ${
        value === id ? 'border-accent text-primary' : 'border-hair text-secondary hover:border-strong'
      }`}
    >
      {id === null ? null : <Dot online={online} />}
      <span className="truncate">{text}</span>
      {/* 中性标签：机器名的风格不统一（「xxx-本机」和「omarchy」），一眼能看出哪台是 hub 自己 */}
      {origin ? (
        <span className="shrink-0 rounded-sm border border-hair px-1 text-meta leading-[1.4] text-tertiary">
          {origin === 'local' ? 'hub 本机' : '远程'}
        </span>
      ) : null}
      {why ? <span className="shrink-0 text-rust">{why}</span> : null}
    </button>
  );
  return (
    <div className="mb-3">
      <p className="mb-1 text-meta text-secondary">{label}</p>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {allowAuto ? option(null, '自动', true) : null}
        {workers.map((worker) => {
          const why = worker.state === 'online' ? unavailable(worker) : null;
          return option(worker.workerId, worker.label, worker.state === 'online', worker.state !== 'online' || why !== null, why, worker.origin);
        })}
      </div>
    </div>
  );
}

/** 面板底部的「添加机器」。主人关掉「成员可以加机器」后，成员只看到一句说明（服务端也会拒绝签码）。 */
function EnrollFooter({ onAdd }: { onAdd: () => void }) {
  const info = useQuery({ queryKey: ['enroll-info'], queryFn: adminApi.enrollInfo, staleTime: 60_000 });
  if (!info.data) return null;
  return (
    <footer className="border-t border-hair px-3 py-2">
      {info.data.allowed ? (
        <button
          className="flex min-h-9 w-full items-center justify-center gap-1.5 rounded-sm border border-dashed border-strong text-sub text-secondary hover:border-accent hover:text-accent"
          onClick={onAdd}
        >
          <span aria-hidden>＋</span> 添加机器
        </button>
      ) : (
        <p className="text-meta text-tertiary">要加机器请联系主人</p>
      )}
    </footer>
  );
}
