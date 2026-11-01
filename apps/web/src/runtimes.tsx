import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type WorkerInfoDto } from './api.ts';
import { localTime } from './local-time.ts';

type Harness = NonNullable<WorkerInfoDto['agentModels']>[number];
type Job = NonNullable<WorkerInfoDto['runtimeJob']>;

const AGENT_NAME: Record<string, string> = { pi: 'Pi', opencode: 'OpenCode', grok: 'Grok' };
const nameOf = (id: string): string => AGENT_NAME[id] ?? id;

/** 机器自带 / hub 安装 vX / 未安装 */
function sourceLabel(harness: Harness): string {
  const provision = harness.provision;
  if (!provision) return '';
  if (provision.source === 'machine') return '机器自带';
  if (provision.source === 'hub') return `hub 安装 v${provision.version ?? '?'}`;
  return '未安装';
}

/**
 * 运行时（ADR 0010）：每个 agent 在这台机器上从哪来，能装就给「安装 / 升级 / 卸载」。
 * 机器自带的只显示、不动；老 Worker 不报 provision，这一节整个不出现。
 */
export function RuntimeSection({ worker }: { worker: WorkerInfoDto }) {
  const harnesses = (worker.agentModels ?? []).filter((harness) => harness.provision);
  if (harnesses.length === 0) return null;
  const job = worker.runtimeJob;
  const running = job?.state === 'running';
  return (
    <>
      <dt className="text-tertiary">运行时</dt>
      <dd className="min-w-0" data-testid="runtime-section">
        <ul className="flex flex-col gap-1">
          {harnesses.map((harness) => (
            <RuntimeRow key={harness.agentId} worker={worker} harness={harness} busy={running} />
          ))}
        </ul>
        {job ? <JobPanel job={job} /> : null}
      </dd>
    </>
  );
}

function RuntimeRow({ worker, harness, busy }: { worker: WorkerInfoDto; harness: Harness; busy: boolean }) {
  const queryClient = useQueryClient();
  const provision = harness.provision!;
  const [armed, setArmed] = useState<'install' | 'uninstall' | null>(null);
  const start = useMutation({
    mutationFn: (action: 'install' | 'uninstall') => api.runtimeJob(worker.workerId, harness.agentId, { action }),
    onSettled: () => {
      setArmed(null);
      void queryClient.invalidateQueries({ queryKey: ['workers'] });
    }
  });
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), 5000);
    return () => clearTimeout(timer);
  }, [armed]);

  const recommended = provision.recommended;
  let action: { kind: 'install' | 'uninstall'; label: string; confirm: string } | null = null;
  let upgrade: { label: string; confirm: string } | null = null;
  if (provision.source === 'missing' && recommended && !provision.blocker) {
    action = { kind: 'install', label: '安装', confirm: `确认安装 v${recommended}` };
  }
  if (provision.source === 'hub') {
    action = { kind: 'uninstall', label: '卸载', confirm: '确认卸载' };
    if (recommended && provision.version !== recommended) upgrade = { label: `升级到 v${recommended}`, confirm: `确认升级到 v${recommended}` };
  }
  const reason =
    provision.source === 'machine'
      ? '这台机器自己装的，以它为准，hub 不动'
      : provision.blocker ?? (start.isError ? (start.error as Error).message : '');

  const button = (kind: 'install' | 'uninstall', key: string, label: string, confirm: string, danger = false) => (
    <button
      key={key}
      data-testid={`runtime-${harness.agentId}-${key}`}
      className={`shrink-0 rounded-sm border px-2 py-0.5 text-xs ${
        armed === kind ? (danger ? 'border-rust bg-rust text-canvas' : 'border-ink bg-ink text-canvas') : 'border-hair text-secondary hover:border-ink hover:text-ink'
      } disabled:opacity-50`}
      disabled={busy || start.isPending}
      onClick={() => (armed === kind ? start.mutate(kind) : setArmed(kind))}
    >
      {armed === kind ? confirm : label}
    </button>
  );

  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5" data-testid={`runtime-${harness.agentId}`}>
      <span className="text-secondary">{nameOf(harness.agentId)}</span>
      <span className="rounded-sm border border-hair px-1 text-xs text-tertiary" data-testid={`runtime-${harness.agentId}-source`}>
        {sourceLabel(harness)}
      </span>
      {upgrade ? button('install', 'upgrade', upgrade.label, upgrade.confirm) : null}
      {action ? button(action.kind, action.kind, action.label, action.confirm, action.kind === 'uninstall') : null}
      {reason ? (
        <span className="basis-full text-xs text-tertiary" role={start.isError ? 'alert' : undefined}>
          {reason}
        </span>
      ) : null}
    </li>
  );
}

const STATE_TEXT: Record<Job['state'], string> = { running: '进行中', succeeded: '完成', failed: '失败', refused: '没做' };

/** 最近一次任务：状态一行，日志可展开；跑的时候默认展开看进度。 */
function JobPanel({ job }: { job: Job }) {
  const running = job.state === 'running';
  const [open, setOpen] = useState(running);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  const tone = job.state === 'failed' || job.state === 'refused' ? 'text-rust' : job.state === 'succeeded' ? 'text-secondary' : 'text-ink';
  return (
    <div className="mt-1.5 min-w-0 rounded-sm border border-hair" data-testid="runtime-job">
      <button className="flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left text-xs" onClick={() => setOpen((value) => !value)}>
        <span className={`shrink-0 ${tone}`} data-testid="runtime-job-state">
          {running ? '⏳ ' : ''}
          {job.componentId ? `组件 ${job.componentId}` : nameOf(job.agentId)} {job.action === 'install' || job.action === 'install_component' ? '安装' : '卸载'} · {STATE_TEXT[job.state]}
        </span>
        <span className="min-w-0 flex-1 truncate text-tertiary" data-testid="runtime-job-message">
          {job.message}
        </span>
        <span className="shrink-0 text-tertiary">{open ? '▾' : '▸'}</span>
      </button>
      {open && job.log ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all border-t border-hair px-2 py-1 font-mono text-[11px] leading-snug text-tertiary">
          {job.log}
        </pre>
      ) : null}
    </div>
  );
}

type Inventory = NonNullable<WorkerInfoDto['inventory']>;
type Drift = NonNullable<WorkerInfoDto['drift']>;

/**
 * 套件清单（ADR 0021 §7，P1 只读）：运行时 + 组件。外部安装的只显示（不由 hub 管理、不参与调度）；
 * 漂移的组件标「不可信」，修复要人手动触发（P2 才有安装入口）。老 Worker 不报清单，这一节不出现。
 */
export function InventorySection({ worker }: { worker: WorkerInfoDto }) {
  const inventory: Inventory | undefined = worker.inventory;
  if (!inventory) return null;
  const drift: Drift = worker.drift ?? { items: [], trusted: [], untrusted: [] };
  const problems = drift.items.filter((item) => item.kind !== 'external');
  return (
    <>
      <dt className="text-tertiary">组件</dt>
      <dd className="min-w-0" data-testid="inventory-section">
        {inventory.components.length === 0 ? (
          <p className="text-tertiary">没有装组件</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {inventory.components.map((component) => {
              const bad = problems.find((item) => item.componentId === component.id && item.runtime === component.runtime);
              return (
                <li key={`${component.runtime}:${component.id}`} className="min-w-0 break-words" data-testid="inventory-component">
                  <span className="font-mono">{component.id}</span> <span className="text-tertiary">{component.version}</span>{' '}
                  <span className="text-tertiary">（{nameOf(component.runtime)}）</span>{' '}
                  {component.managedBy === 'external' ? (
                    <span className="text-tertiary" data-testid="inventory-external">外部安装（不由 hub 管理，不参与调度）</span>
                  ) : bad ? (
                    <span className="text-red-500">⚠ 不可信：{bad.kind === 'unexpected' ? '不是 hub 装的' : '版本或哈希不一致'}，需要重新安装</span>
                  ) : (
                    <span>✓</span>
                  )}
                  {component.enabled ? null : <span className="text-tertiary">（已停用）</span>}
                </li>
              );
            })}
          </ul>
        )}
        {problems
          .filter((item) => item.kind === 'missing')
          .map((item) => (
            <p key={`missing:${item.runtime}:${item.componentId}`} className="text-red-500">
              ⚠ 缺失：{item.componentId} {item.expected}（{nameOf(item.runtime)}），能力不可信，需要重新安装
            </p>
          ))}
        {inventory.componentInstall ? <ComponentActions worker={worker} /> : null}
        <p className="text-tertiary" data-testid="inventory-drift">
          漂移：{problems.length === 0 ? '无' : `${problems.length} 项`}　上次清单：{localTime(inventory.collectedAt)}
        </p>
      </dd>
    </>
  );
}

/**
 * 组件安装入口（ADR 0021 §8，P2）：从已批准的目录里选一个装；hub 装的可以卸载，漂移 / 缺失的可以修复（重装钉住的版本）。
 * 升级只对新会话生效：正在跑的会话继续用旧目录。没有权限的人服务端会拒，按钮上直接把原话亮出来。
 */
function ComponentActions({ worker }: { worker: WorkerInfoDto }) {
  const queryClient = useQueryClient();
  const catalog = useQuery({ queryKey: ['components'], queryFn: api.components, staleTime: 30_000 });
  const [picked, setPicked] = useState('');
  const job = useMutation({
    mutationFn: (input: { componentId: string; action: 'install' | 'uninstall'; version?: string }) =>
      api.componentJob(worker.workerId, input.componentId, { action: input.action, ...(input.version ? { version: input.version } : {}) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['workers'] })
  });
  const busy = worker.runtimeJob?.state === 'running' || job.isPending;
  const inventory = worker.inventory!;
  const hubManaged = inventory.components.filter((c) => c.managedBy !== 'external');
  const broken = (worker.drift?.items ?? []).filter((item) => item.kind === 'missing' || item.kind === 'mismatch');
  const approved = (catalog.data ?? []).filter((c) => c.status === 'approved');
  const button = 'shrink-0 rounded-sm border border-hair px-2 py-1 text-xs text-secondary hover:border-ink hover:text-ink disabled:opacity-50';
  return (
    <div className="mt-1.5 flex min-w-0 flex-col gap-1.5" data-testid="component-actions">
      {broken.map((item) => (
        <div key={`fix:${item.componentId}`} className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-all text-tertiary">{item.componentId} {item.expected}</span>
          <button className={button} data-testid={`component-repair-${item.componentId}`} disabled={busy}
            onClick={() => job.mutate({ componentId: item.componentId, action: 'install', version: item.expected })}>
            修复
          </button>
        </div>
      ))}
      {hubManaged.map((component) => (
        <div key={`rm:${component.id}`} className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-all font-mono text-tertiary">{component.id}</span>
          <button className={button} data-testid={`component-uninstall-${component.id}`} disabled={busy}
            onClick={() => window.confirm(`卸载 ${component.id}？正在跑的会话不受影响`) && job.mutate({ componentId: component.id, action: 'uninstall' })}>
            卸载
          </button>
        </div>
      ))}
      {approved.length ? (
        <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center">
          <select className="min-w-0 rounded-sm border border-hair bg-card px-2 py-1.5 text-xs" data-testid="component-pick" value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">选一个已批准的组件…</option>
            {approved.map((c) => (
              <option key={`${c.id}@${c.version}`} value={`${c.id}@${c.version}`}>
                {c.id} v{c.version}{Object.keys(c.scripts).length ? '（声明了安装脚本，不会执行，可能用不了）' : ''}
              </option>
            ))}
          </select>
          <button className={button} data-testid="component-install" disabled={busy || !picked}
            onClick={() => {
              const at = picked.lastIndexOf('@');
              job.mutate({ componentId: picked.slice(0, at), action: 'install', version: picked.slice(at + 1) }, { onSuccess: () => setPicked('') });
            }}>
            安装 / 升级
          </button>
          <span className="text-xs text-tertiary">升级只对新会话生效</span>
        </div>
      ) : null}
      {job.isError ? <p role="alert" className="text-xs text-rust">{(job.error as Error).message}</p> : null}
    </div>
  );
}
