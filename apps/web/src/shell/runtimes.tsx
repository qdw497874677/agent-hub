import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CatalogComponentDto, type WorkerInfoDto } from './api.ts';
import { SMALL_BUTTON } from './dialog-shell.tsx';
import { localTime } from './local-time.ts';
import { runtimeView, versionError } from './runtime-view.ts';

type Harness = NonNullable<WorkerInfoDto['agentModels']>[number];
type Job = NonNullable<WorkerInfoDto['runtimeJob']>;

const AGENT_NAME: Record<string, string> = { pi: 'Pi', opencode: 'OpenCode', grok: 'Grok' };
const nameOf = (id: string): string => AGENT_NAME[id] ?? id;

/** 已经在等着确认的按钮亮起来；其余用 SMALL_BUTTON。 */
const ARMED_BUTTON = 'shrink-0 rounded-sm border border-accent bg-accent px-2 py-1 text-meta text-canvas';
const ARMED_DANGER = 'shrink-0 rounded-sm border border-rust bg-rust px-2 py-1 text-meta text-primary';

/**
 * 运行时（ADR 0010）：每个 agent 在这台机器上从哪来、装的是哪一份。
 * 机器自带的那份会把版本号报上来；hub 可以另装一份，两份之间显式切换。
 * 切换 / 安装都只对下次新建的会话生效，正在跑的会话继续用旧的。
 * 老 Worker 不报 provision，这一节整个不出现。
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

type Arming = 'install' | 'upgrade' | 'uninstall' | 'switch';

function RuntimeRow({ worker, harness, busy }: { worker: WorkerInfoDto; harness: Harness; busy: boolean }) {
  const queryClient = useQueryClient();
  const id = harness.agentId;
  const view = runtimeView(harness.provision!);
  const [armed, setArmed] = useState<Arming | null>(null);
  const [version, setVersion] = useState('');
  const start = useMutation({
    mutationFn: (input: { action: 'install' | 'uninstall' | 'switch'; version?: string; source?: 'machine' | 'hub' }) =>
      api.runtimeJob(worker.workerId, id, input),
    onSettled: () => {
      setArmed(null);
      setVersion('');
      void queryClient.invalidateQueries({ queryKey: ['workers'] });
    }
  });
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => {
      setArmed(null);
      setVersion('');
    }, 10_000);
    return () => clearTimeout(timer);
  }, [armed]);

  const preset = view.install?.preset ?? null;
  const problem = versionError(version, preset);
  const picked = version.trim() || preset;
  const upgradeTo = view.hub?.upgradeTo ?? null;
  const other = view.other;

  const arm = (key: Arming) => {
    if (key === 'install') setVersion(preset ?? '');
    setArmed(key);
  };
  const runInstall = () => {
    if (problem) return;
    start.mutate({ action: 'install', ...(picked ? { version: picked } : {}) });
  };
  const chip = (key: 'upgrade' | 'uninstall' | 'switch', label: string, confirm: string, run: () => void) => (
    <button
      key={key}
      data-testid={`runtime-${id}-${key}`}
      className={armed === key ? (key === 'uninstall' ? ARMED_DANGER : ARMED_BUTTON) : SMALL_BUTTON}
      disabled={busy || start.isPending}
      onClick={() => (armed === key ? run() : arm(key))}
    >
      {armed === key ? confirm : label}
    </button>
  );
  // 安装 / 切换都只影响新会话：一句话说清楚，别让用户以为点完正在跑的会话就换了。
  const actionable = Boolean(view.install || view.hub || view.other);
  const note =
    view.notice ??
    (view.other
      ? '切换对下次新建的会话生效，正在跑的会话继续用旧版本'
      : actionable
        ? '对下次新建的会话生效，正在跑的会话继续用旧版本'
        : view.blocker);

  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-testid={`runtime-${id}`}>
      <span className="text-secondary">{nameOf(id)}</span>
      <span className="rounded-sm border border-hair px-1 text-meta text-tertiary" data-testid={`runtime-${id}-source`}>
        {view.activeLabel}
        {view.both ? '（生效中）' : ''}
        {view.other ? ` · ${view.other.label}` : ''}
      </span>
      {view.install ? (
        armed === 'install' ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            <input
              data-testid={`runtime-${id}-version`}
              aria-label="hub 安装的版本"
              className={`w-24 min-w-0 rounded-sm border bg-card px-1.5 py-0.5 font-mono text-meta text-primary outline-none placeholder:text-tertiary focus:border-accent ${
                problem ? 'border-rust' : 'border-hair'
              }`}
              placeholder={preset ?? '2.2.2'}
              inputMode="numeric"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') runInstall();
              }}
            />
            <button data-testid={`runtime-${id}-install`} className={ARMED_BUTTON} disabled={busy || start.isPending || Boolean(problem)} onClick={runInstall}>
              {picked ? `确认安装 v${picked}` : '确认安装'}
            </button>
            <button
              data-testid={`runtime-${id}-install-cancel`}
              className={SMALL_BUTTON}
              onClick={() => {
                setArmed(null);
                setVersion('');
              }}
            >
              取消
            </button>
            {problem ? (
              <span role="alert" className="basis-full text-meta text-rust" data-testid={`runtime-${id}-version-error`}>
                {problem}
              </span>
            ) : null}
          </span>
        ) : (
          <button data-testid={`runtime-${id}-install`} className={SMALL_BUTTON} disabled={busy || start.isPending} onClick={() => arm('install')}>
            {view.install.label}
          </button>
        )
      ) : null}
      {upgradeTo ? chip('upgrade', `升级到 v${upgradeTo}`, `确认升级到 v${upgradeTo}`, () => start.mutate({ action: 'install', version: upgradeTo })) : null}
      {other ? chip('switch', other.button, '确认切换', () => start.mutate({ action: 'switch', source: other.side })) : null}
      {view.hub ? chip('uninstall', '卸载', '确认卸载', () => start.mutate({ action: 'uninstall' })) : null}
      {armed ? (
        <span className="text-meta text-accent" data-testid={`runtime-${id}-confirm-hint`}>
          再点一次确认 · 10 秒内有效
        </span>
      ) : null}
      {start.isError ? (
        <span role="alert" className="basis-full text-meta text-rust">
          {(start.error as Error).message}
        </span>
      ) : note ? (
        <span className="basis-full text-meta text-tertiary" data-testid={`runtime-${id}-note`}>
          {note}
        </span>
      ) : null}
    </li>
  );
}

const STATE_TEXT: Record<Job['state'], string> = { running: '进行中', succeeded: '完成', failed: '失败', refused: '没做' };
const ACTION_TEXT: Record<string, string> = {
  install: '安装',
  install_component: '安装',
  uninstall: '卸载',
  uninstall_component: '卸载',
  switch: '切换'
};

/** 最近一次任务：状态一行，日志可展开；跑的时候默认展开看进度。 */
function JobPanel({ job }: { job: Job }) {
  const running = job.state === 'running';
  const [open, setOpen] = useState(running);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  const tone = job.state === 'failed' || job.state === 'refused' ? 'text-rust' : job.state === 'succeeded' ? 'text-secondary' : 'text-primary';
  return (
    <div className="mt-1.5 min-w-0 rounded-sm border border-hair" data-testid="runtime-job">
      <button className="flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left text-xs" onClick={() => setOpen((value) => !value)}>
        <span className={`shrink-0 ${tone}`} data-testid="runtime-job-state">
          {running ? '⏳ ' : ''}
          {job.componentId ? `组件 ${job.componentId}` : nameOf(job.agentId)} {ACTION_TEXT[job.action] ?? job.action} · {STATE_TEXT[job.state]}
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
  const button = 'shrink-0 rounded-sm border border-hair px-2 py-1 text-xs text-secondary hover:border-strong hover:text-primary disabled:opacity-50';
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
      {inventory.bundleInstall && approved.length ? <BundleInstall worker={worker} approved={approved} busy={busy} /> : null}
      {job.isError ? <p role="alert" className="text-xs text-rust">{(job.error as Error).message}</p> : null}
    </div>
  );
}

/**
 * 整套安装（ADR 0021 P3）：勾一组已批准的组件一次装上。全有或全无：
 * Worker 先把每个都装进暂存并核对，全部通过才一起切换；任何一个失败就一个都不换。只装组件，不装运行时本身。
 */
function BundleInstall({ worker, approved, busy }: { worker: WorkerInfoDto; approved: CatalogComponentDto[]; busy: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  // 每个组件只给最新批准的那一版
  const latest = new Map<string, CatalogComponentDto>();
  for (const c of [...approved].sort((a, b) => a.submittedAt - b.submittedAt)) latest.set(c.id, c);
  const runtimes = new Set((worker.inventory?.runtimes ?? []).map((r) => r.agentId));
  const options = [...latest.values()];
  const install = useMutation({
    mutationFn: () => api.bundleInstall(worker.workerId, Object.entries(chosen).map(([componentId, version]) => ({ componentId, version }))),
    onSuccess: () => (setOpen(false), setChosen({})),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['workers'] })
  });
  const button = 'shrink-0 rounded-sm border border-hair px-2 py-1 text-xs text-secondary hover:border-strong hover:text-primary disabled:opacity-50';
  if (!open) {
    return (
      <div>
        <button className={button} data-testid="bundle-install-open" disabled={busy} onClick={() => setOpen(true)}>
          整套安装…
        </button>
      </div>
    );
  }
  return (
    <div className="min-w-0 rounded-sm border border-hair p-2" role="dialog" aria-label="整套安装" data-testid="bundle-install-dialog">
      <p className="text-xs text-secondary">勾选要一起装的组件（每个组件用最新批准的版本）：</p>
      <ul className="mt-1 flex flex-col gap-1">
        {options.map((c) => {
          const missing = !runtimes.has(c.runtime);
          return (
            <li key={c.id} className="flex min-w-0 items-center gap-2 text-xs">
              <input
                type="checkbox"
                data-testid={`bundle-pick-${c.id}`}
                disabled={missing}
                checked={chosen[c.id] === c.version}
                onChange={(e) =>
                  setChosen((prev) => {
                    const next = { ...prev };
                    if (e.target.checked) next[c.id] = c.version;
                    else delete next[c.id];
                    return next;
                  })
                }
              />
              <span className="min-w-0 break-all font-mono">{c.id}</span>
              <span className="text-tertiary">v{c.version}（{nameOf(c.runtime)}{c.source === 'git' ? ' · git' : ''}）</span>
              {missing ? <span className="text-tertiary">这台机器没有 {nameOf(c.runtime)}</span> : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-xs text-tertiary" data-testid="bundle-all-or-nothing">
        全有或全无：先把选中的都装进暂存目录并核对哈希，全部通过才一起切换；任何一个失败就一个都不换。已经装好的会跳过。
      </p>
      <div className="mt-1.5 flex gap-2">
        <button className={button} data-testid="bundle-install-confirm" disabled={busy || install.isPending || Object.keys(chosen).length === 0} onClick={() => install.mutate()}>
          安装 {Object.keys(chosen).length} 个
        </button>
        <button className={button} onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
      {install.isError ? <p role="alert" className="mt-1 text-xs text-rust" data-testid="bundle-install-error">{(install.error as Error).message}</p> : null}
    </div>
  );
}
