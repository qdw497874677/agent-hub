import { useQuery } from '@tanstack/react-query';
import { api, type WorkerInfoDto } from './api.ts';

/**
 * Worker：一台登记进 hub、真正跑 agent 的机器。
 *
 * 设计取向（见 docs/design/multi-worker-research.md）：像 Tailscale 的机器列表那样，
 * 一行一台、状态点 + 名字 + 一句「最后一次见到」，细节按需展开；只有一台机器时选择器不出现。
 *
 * 这个文件只放「到处都要用的小件」：取数、徽标、选择器、一行状态。
 * 机器自己的页面在 machines.tsx（`#/machines`），那里才是管理的地方。
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
    /** 第一次拉取还没回来 / 刷新失败：空列表不能当成「一台机器都没有」。 */
    loading: query.isLoading,
    failed: query.isError,
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

export const Dot = ({ online }: { online: boolean }) => (
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

/**
 * 侧栏 / 首页角落的机器入口：一个状态点 + 一句概况，**直接进 `#/machines`**。
 * 不再有弹层——弹层放不下日志和危险区，也不可能给出可分享的地址。
 */
export function MachinesBadge({ className = '' }: { className?: string }) {
  const { list, online } = useWorkers();
  const tone = list.length === 0 ? 'bg-tertiary' : online.length > 0 ? 'bg-sage' : 'bg-rust';
  const text = list.length === 0 ? '没有机器' : list.length === 1 ? (list[0]?.label ?? '机器') : `${online.length}/${list.length} 机器`;
  return (
    <a
      href="#/machines"
      className={`flex h-7 max-w-full items-center gap-1.5 rounded-md px-2 text-meta text-secondary hover:bg-hover hover:text-primary ${className}`}
      aria-label={`机器：${online.length}/${list.length} 在线`}
      title="机器：跑 agent 的机器"
      data-testid="machines-badge"
    >
      <span className={`block size-[7px] rounded-full ${tone}`} />
      <span className="truncate">{text}</span>
    </a>
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
        value === id ? 'border-fg/40 bg-selected text-primary' : 'border-hair text-secondary hover:border-strong'
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
