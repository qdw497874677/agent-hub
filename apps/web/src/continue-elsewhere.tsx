import { useState } from 'react';
import type { ProjectDto, SessionDto } from './api.ts';
import { api } from './api.ts';
import { DirectoryPicker } from './directory-picker.tsx';
import { resolveWorker, useWorkers } from './workers.tsx';

/**
 * 换台机器继续。说法要诚实：agent 自己的会话状态搬不走，
 * 搬过去的是平台记下的对话摘要——在那台机器上开一条新会话，挂成这条的分叉。
 */
export function ContinueElsewhere({
  project,
  session,
  onDone
}: {
  project: ProjectDto;
  session: SessionDto;
  onDone: (created: SessionDto) => void;
}) {
  const workers = useWorkers();
  const [target, setTarget] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const here = resolveWorker(workers.list, session.workerId)?.workerId ?? null;
  const home = resolveWorker(workers.list, project.workerId)?.workerId ?? null;
  const candidates = workers.online.filter(
    (worker) => worker.workerId !== here && (worker.agentIds === undefined || worker.agentIds.includes(session.agentId))
  );
  // 只有一台机器时整块都不出现
  if (!workers.multi) return null;

  const known = (id: string): string | undefined => (id === home ? project.rootPath : project.directories?.[id]);

  async function go(workerId: string, directory: string | null) {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.continueElsewhere(session.id, workerId, directory));
      setTarget(null);
      setPicking(false);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-3" aria-label="换台机器继续">
      <p className="mb-1 text-meta text-tertiary">换台机器继续</p>
      {candidates.length === 0 ? (
        <p className="text-meta text-tertiary">没有别的在线 Worker 装了这个 agent。</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <select
              aria-label="目标 Worker"
              className="min-w-0 flex-1 rounded-sm border border-hair bg-card px-2 py-1 text-meta text-primary"
              value={target ?? ''}
              onChange={(event) => {
                setTarget(event.target.value || null);
                setPicking(false);
                setError(null);
              }}
            >
              <option value="">选一台…</option>
              {candidates.map((worker) => (
                <option key={worker.workerId} value={worker.workerId}>
                  {worker.label}
                </option>
              ))}
            </select>
            <button
              className="rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-sage hover:text-sage disabled:opacity-40"
              disabled={busy || target === null || session.lastSeq === 0}
              onClick={() => {
                if (target === null) return;
                if (known(target)) void go(target, null);
                else setPicking(true);
              }}
            >
              {busy ? '交接中…' : '继续'}
            </button>
          </div>
          {target !== null ? (
            <p className="mt-1 font-mono text-meta text-tertiary">
              {known(target) ? `目录：${known(target)}` : '那台还没登记这个项目的目录，点「继续」先选一个'}
            </p>
          ) : null}
          <p className="mt-1 text-meta text-tertiary">
            agent 自己的会话状态带不过去：会在那台机器上新开一条会话，把这里的对话摘要作为第一条消息发过去，并挂成这条的分叉。
          </p>
        </>
      )}
      {picking && target !== null ? (
        <div className="mt-2">
          <p className="mb-1 text-meta text-secondary">在「{workers.byId(target)?.label ?? target}」上选这个项目的目录</p>
          <DirectoryPicker workerId={target} onPick={(path) => void go(target, path)} />
        </div>
      ) : null}
      {error ? <p className="mt-1 text-meta text-rust">{error}</p> : null}
    </section>
  );
}
