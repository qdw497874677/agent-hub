import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type WorkerInfoDto } from './api.ts';

/**
 * harness 就绪状态的展示（docs/design/harness-readiness.md）。只读 Worker 报的统一 readiness，
 * 不认识任何具体 harness：没报（老 Worker）一律当能用。
 */
export type Readiness = { readonly state: 'ready' } | { readonly state: 'unavailable'; readonly reason: string };

/** 这台机器上这个 agent 不能用的原因；能用或没报是 null。 */
export function harnessReason(worker: WorkerInfoDto | undefined, agentId: string): string | null {
  const readiness = worker?.agentModels?.find((entry) => entry.agentId === agentId)?.readiness;
  return readiness?.state === 'unavailable' ? readiness.reason : null;
}

/** 一排 harness 小标签：不可用的变灰并带上原因。窄屏自动折行。 */
export function HarnessBadges({
  harnesses,
  labelOf = (id) => id
}: {
  harnesses: readonly { readonly agentId: string; readonly readiness?: Readiness | undefined }[];
  labelOf?: (agentId: string) => string;
}) {
  if (harnesses.length === 0) return null;
  return (
    <span data-testid="harness-badges" className="flex flex-wrap gap-1">
      {harnesses.map(({ agentId, readiness }) => {
        const down = readiness?.state === 'unavailable';
        return (
          <span
            key={agentId}
            data-testid="harness-badge"
            data-state={down ? 'unavailable' : 'ready'}
            title={down ? `${labelOf(agentId)} 暂不可用：${readiness.reason}` : `${labelOf(agentId)} 可用`}
            className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-meta ${
              down ? 'border-hair text-tertiary opacity-60' : 'border-hair text-secondary'
            }`}
          >
            <span className={down ? 'line-through' : ''}>{labelOf(agentId)}</span>
            {down ? <span className="text-rust no-underline">{readiness.reason}</span> : null}
          </span>
        );
      })}
    </span>
  );
}

/** 「重新检测」：让那台 Worker 立刻重新探测，过一会儿再拉一次列表（结果是异步回来的）。 */
export function RecheckButton({ workerId, className = '' }: { workerId: string; className?: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function recheck() {
    setBusy(true);
    setError(null);
    try {
      await api.probeWorker(workerId);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workers'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'workers'] })
      ]);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        data-testid="harness-recheck"
        className={`min-h-[28px] rounded-sm border border-hair px-2 text-meta text-secondary hover:border-strong disabled:opacity-40 ${className}`}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          void recheck();
        }}
      >
        {busy ? '检测中…' : '重新检测'}
      </button>
      {error ? <span className="text-meta text-rust">{error}</span> : null}
    </span>
  );
}
