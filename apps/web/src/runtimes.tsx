import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type WorkerInfoDto } from './api.ts';

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
          {nameOf(job.agentId)} {job.action === 'install' ? '安装' : '卸载'} · {STATE_TEXT[job.state]}
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
