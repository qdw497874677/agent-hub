import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type WorkerInfoDto } from './api.ts';

/** 机器资源（ADR 0014）的展示：只读 /api/workers 每 5 秒带下来的最新一份；老 worker 没有就显示「—」。 */
type Resources = NonNullable<WorkerInfoDto['resources']>;
type Level = Resources['pressure']['level'];

export function formatBytes(bytes: number): string {
  const units = ['B', 'K', 'M', 'G', 'T'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

const tone: Record<Level, string> = { ok: 'text-tertiary', warn: 'text-amber-500', full: 'text-red-500' };
const dotTone: Record<Level, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', full: 'bg-red-500' };
const levelText: Record<Level, string> = { ok: '资源正常', warn: '资源偏紧', full: '资源紧张' };

function memPercent(r: Resources): number {
  const { memTotal, memAvailable } = r.sample.machine;
  return memTotal > 0 ? Math.round(((memTotal - memAvailable) / memTotal) * 100) : 0;
}

/** 最空的那块盘还剩多少。 */
function diskFree(r: Resources): number | null {
  const disks = r.sample.machine.disks;
  return disks.length === 0 ? null : Math.min(...disks.map((disk) => disk.free));
}

function title(r: Resources): string {
  return [levelText[r.pressure.level], ...r.pressure.reasons, r.refusing ? '暂不接新会话' : ''].filter(Boolean).join(' · ');
}

/** 机器列表一行的摘要：CPU / 内存 / 盘，按压力着色。 */
export function ResourceSummary({ worker }: { worker: WorkerInfoDto }) {
  const r = worker.resources;
  if (worker.state !== 'online') return null;
  if (!r) {
    return (
      <span className="block truncate text-meta text-tertiary" data-testid="worker-resources" data-level="none" title="这台 worker 版本较老，没有上报资源">
        CPU — · 内存 — · 盘 —
      </span>
    );
  }
  const cpu = r.sample.machine.cpuPercent;
  const free = diskFree(r);
  return (
    <span className={`block truncate text-meta ${tone[r.pressure.level]}`} data-testid="worker-resources" data-level={r.pressure.level} title={title(r)}>
      CPU {cpu === null ? '—' : `${Math.round(cpu)}%`} · 内存 {memPercent(r)}% · 盘剩 {free === null ? '—' : formatBytes(free)}
      {r.sample.machine.gpus?.length ? ` · GPU ${Math.round(Math.max(...r.sample.machine.gpus.map((gpu) => gpu.utilPercent ?? 0)))}%` : ''}
      {r.refusing ? ' · 暂不接新会话' : ''}
    </span>
  );
}

/** 展开后的明细：各盘、GPU、原因，以及「满了拒绝新会话」开关。 */
export function ResourceDetails({ worker }: { worker: WorkerInfoDto }) {
  const r = worker.resources;
  if (worker.state !== 'online' || !r) return null;
  const m = r.sample.machine;
  return (
    <>
      <dt className="text-tertiary">资源</dt>
      <dd className="min-w-0 text-secondary" data-testid="worker-resource-details">
        <span className={`block ${tone[r.pressure.level]}`}>{title(r)}</span>
        <span className="block">
          {m.cores} 核{m.load ? ` · 负载 ${m.load.map((value) => value.toFixed(2)).join(' ')}` : ''} · 内存可用 {formatBytes(m.memAvailable)} / {formatBytes(m.memTotal)}
          {m.swapUsed ? ` · swap ${formatBytes(m.swapUsed)}` : ''}
        </span>
        {m.disks.map((disk) => (
          <span key={disk.root} className="block truncate font-mono">
            {disk.root} 剩 {formatBytes(disk.free)} / {formatBytes(disk.total)}
          </span>
        ))}
        {(m.gpus ?? []).map((gpu, index) => (
          <span key={index} className="block truncate">
            GPU{index} {gpu.name} · {gpu.utilPercent ?? '—'}% · 显存 {gpu.memUsed === null ? '—' : formatBytes(gpu.memUsed)} / {gpu.memTotal === null ? '—' : formatBytes(gpu.memTotal)}
          </span>
        ))}
        <RefuseToggle worker={worker} on={r.refuseWhenFull} />
      </dd>
    </>
  );
}

function RefuseToggle({ worker, on }: { worker: WorkerInfoDto; on: boolean }) {
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: (next: boolean) => api.setResourcePolicy(worker.workerId, next),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['workers'] })
  });
  return (
    <label className="mt-1 flex items-center gap-1.5 text-tertiary">
      <input type="checkbox" data-testid="refuse-when-full" checked={on} disabled={change.isPending} onChange={(event) => change.mutate(event.target.checked)} />
      资源紧张时拒绝新会话
      {change.error ? <span className="text-red-500">{(change.error as Error).message}</span> : null}
    </label>
  );
}

/** 画布机器框上的徽标：桌面显示 CPU/内存，窄屏只剩一个颜色点。 */
export function ResourceBadge({ resources }: { resources: Resources | undefined }) {
  if (!resources) return null;
  const level = resources.pressure.level;
  const cpu = resources.sample.machine.cpuPercent;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-meta" data-testid="worker-frame-resources" data-level={level} title={title(resources)}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotTone[level]}`} />
      <span className={`hidden sm:inline ${tone[level]}`}>
        {cpu === null ? '' : `CPU ${Math.round(cpu)}% · `}内存 {memPercent(resources)}%
      </span>
    </span>
  );
}

/** 会话卡片上的用量：◔ 12% · 480M。 */
export function SessionUsage({ resources, sessionId }: { resources: Resources | undefined; sessionId: string }) {
  const usage = resources?.sample.sessions.find((session) => session.sessionId === sessionId);
  if (!usage) return null;
  return (
    <span className="shrink-0 text-meta text-tertiary" data-testid="session-usage" title="这条会话的 agent 进程树占用">
      ◔ {Math.round(usage.cpuPercent)}% · {formatBytes(usage.rss)}
    </span>
  );
}
