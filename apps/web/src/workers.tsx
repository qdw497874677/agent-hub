import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi, api, type WorkerInfoDto } from './api.ts';
import { AddMachineDialog } from './add-machine.tsx';
import { HarnessBadges, RecheckButton, harnessReason } from './harness.tsx';

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
              ? `${worker.sessionCount ?? 0} 条会话在跑 · ${
                  (worker.agentIds ?? []).map((id) => (harnessReason(worker, id) ? `${id}（${harnessReason(worker, id)}）` : id)).join(' / ') ||
                  '没有 agent'
                }`
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
                <span className="mt-1 block font-sans text-xs text-tertiary" title="在那台机器的 ~/.config/agent-hub/worker.env 里改 WORKER_ROOTS（冒号分隔），再 systemctl --user restart agent-hub-worker">
                  hub 只能访问这些目录；要放开改那台的 WORKER_ROOTS
                </span>
              </dd>
            </>
          ) : null}
          {online && (worker.agentModels ?? []).length > 0 ? (
            <>
              <dt className="text-tertiary">agent</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
                <HarnessBadges harnesses={worker.agentModels ?? []} />
                <RecheckButton workerId={worker.workerId} />
              </dd>
            </>
          ) : null}
          {worker.origin === 'remote' ? <RevokeButton worker={worker} /> : null}
        </dl>
      ) : null}
    </li>
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
 * 顶栏的 Worker 状态 + 管理面板。面板本身就是 Worker 列表：
 * 在线的排前面，离线的留着（带最后在线时间和原因），点开看主机、目录、ID。
 */
export function WorkersBadge({ placement = 'down' }: { placement?: 'down' | 'up' }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
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
          <EnrollFooter onAdd={() => { setOpen(false); setAdding(true); }} />
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
  const option = (id: string | null, text: string, online: boolean, disabled = false, why: string | null = null) => (
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
          return option(worker.workerId, worker.label, worker.state === 'online', worker.state !== 'online' || why !== null, why);
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
