import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type WorkerInfoDto } from './api.ts';

/**
 * Worker：一台登记进 hub、真正跑 agent 的机器。
 *
 * 设计取向（见 docs/design/multi-worker-research.md）：像 Tailscale 的机器列表那样，
 * 一行一台、状态点 + 名字 + 一句「最后一次见到」，细节按需展开；
 * 只有一台机器时整套多机界面都不出现——单机用户不该为没用到的能力付出注意力。
 */

export function useWorkers() {
  const query = useQuery({ queryKey: ['workers'], queryFn: api.workers, refetchInterval: 5000 });
  const list = query.data ?? [];
  return {
    list,
    online: list.filter((worker) => worker.state === 'online'),
    /** 多于一台（含离线的）才需要在界面上区分「在哪台」。 */
    multi: list.length > 1,
    byId: (id: string | null | undefined) => list.find((worker) => worker.workerId === id)
  };
}

/** 本机 worker 的项目 / 会话里 workerId 记作 null：解析成「本机那台」。 */
export function resolveWorker(workers: readonly WorkerInfoDto[], id: string | null | undefined) {
  if (id) return workers.find((worker) => worker.workerId === id);
  return workers.find((worker) => worker.origin === 'local');
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

function WorkerRow({ worker }: { worker: WorkerInfoDto }) {
  const [open, setOpen] = useState(false);
  const online = worker.state === 'online';
  const host = [worker.hostname, worker.platform].filter(Boolean).join(' · ');
  return (
    <li className="border-b border-hair last:border-b-0">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-card-raised"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Dot online={online} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-body text-primary">{worker.label}</span>
            {worker.origin === 'local' && worker.label !== '本机' ? <span className="text-meta text-tertiary">本机</span> : null}
          </span>
          <span className="block truncate text-meta text-tertiary">
            {online
              ? `${worker.sessionCount ?? 0} 条会话在跑 · ${(worker.agentIds ?? []).join(' / ') || '没有 agent'}`
              : `离线 · ${relativeTime(worker.lastSeenAt)}${worker.reason ? ` · ${worker.reason}` : ''}`}
          </span>
        </span>
        <span className="shrink-0 text-meta text-tertiary">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1 px-3 pb-2.5 pl-[1.6rem] text-meta">
          <dt className="text-tertiary">ID</dt>
          <dd className="truncate font-mono text-secondary">{worker.workerId}</dd>
          {host ? (
            <>
              <dt className="text-tertiary">主机</dt>
              <dd className="truncate text-secondary">{host}</dd>
            </>
          ) : null}
          <dt className="text-tertiary">最后在线</dt>
          <dd className="text-secondary">{online ? '现在' : relativeTime(worker.lastSeenAt)}</dd>
          {(worker.roots ?? []).length > 0 ? (
            <>
              <dt className="text-tertiary">可用目录</dt>
              <dd className="min-w-0 font-mono text-secondary">
                {(worker.roots ?? []).map((root) => (
                  <span key={root} className="block truncate">
                    {root}
                  </span>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </li>
  );
}

/**
 * 顶栏的 Worker 状态 + 管理面板。面板本身就是 Worker 列表：
 * 在线的排前面，离线的留着（带最后在线时间和原因），点开看主机、目录、ID。
 */
export function WorkersBadge({ placement = 'down' }: { placement?: 'down' | 'up' }) {
  const [open, setOpen] = useState(false);
  const { list, online } = useWorkers();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
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
        className="flex items-center gap-1.5 rounded-sm border border-hair px-2.5 py-1 text-meta text-secondary hover:border-accent hover:text-accent"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={`Worker：${online.length}/${list.length} 在线`}
        title="Worker：跑 agent 的机器"
      >
        <span className={`block size-[7px] rounded-full ${tone}`} />
        {list.length === 0 ? '没有 Worker' : list.length === 1 ? (list[0]?.label ?? 'Worker') : `${online.length}/${list.length} Worker`}
      </button>

      {open ? (
        <div className={`z-30 ${
            placement === 'up'
              ? // 窄屏贴底成一张 sheet（拇指够得着）；宽屏浮在侧栏左下、徽标上方
                'fixed inset-x-3 bottom-3 md:inset-x-auto md:bottom-14 md:left-3 md:w-[340px]'
              : 'absolute right-0 top-9 w-[min(340px,calc(100vw-1.5rem))]'
          }`}><div className="overflow-hidden rounded-md border border-strong bg-panel shadow-lg">
          <header className="flex items-baseline justify-between border-b border-hair px-3 py-2">
            <span className="text-sub text-primary">Worker</span>
            <span className="text-meta text-tertiary">
              {online.length} 在线{list.length > online.length ? ` · ${list.length - online.length} 离线` : ''}
            </span>
          </header>
          {list.length === 0 ? (
            <p className="px-3 py-3 text-meta text-tertiary">还没有 Worker 连上。它起来后会自己报到——刚启动的话等几秒。</p>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto">
              {list.map((worker) => (
                <WorkerRow key={worker.workerId} worker={worker} />
              ))}
            </ul>
          )}
          <footer className="border-t border-hair px-3 py-2 text-meta text-tertiary">
            加一台机器：在那台机器上运行
            <code className="mx-1 font-mono text-secondary">scripts/install-worker.sh</code>
            ，见 docs/remote-access.md
          </footer>
        </div>
        </div>
      ) : null}
    </div>
  );
}

/** 分段选择：选「在哪台跑」。只有一台时不渲染。 */
export function WorkerPicker({
  value,
  onChange,
  workers,
  allowAuto,
  label = '在哪台跑'
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  workers: readonly WorkerInfoDto[];
  allowAuto?: boolean;
  label?: string;
}) {
  if (workers.length < 2) return null;
  const option = (id: string | null, text: string, online: boolean, disabled = false) => (
    <button
      key={id ?? 'auto'}
      type="button"
      role="radio"
      aria-checked={value === id}
      disabled={disabled}
      onClick={() => onChange(id)}
      className={`flex min-w-0 items-center gap-1.5 rounded-sm border px-2 py-1 text-meta disabled:opacity-40 ${
        value === id ? 'border-accent text-primary' : 'border-hair text-secondary hover:border-strong'
      }`}
    >
      {id === null ? null : <Dot online={online} />}
      <span className="truncate">{text}</span>
    </button>
  );
  return (
    <div className="mb-3">
      <p className="mb-1 text-meta text-secondary">{label}</p>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {allowAuto ? option(null, '自动', true) : null}
        {workers.map((worker) => option(worker.workerId, worker.label, worker.state === 'online', worker.state !== 'online'))}
      </div>
    </div>
  );
}
