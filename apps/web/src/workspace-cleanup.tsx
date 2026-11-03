import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CleanupPolicyDto } from './api.ts';
import { api } from './api.ts';
import { SECONDARY_BUTTON } from './dialog-shell.tsx';

const ACTION: Record<'removed' | 'kept' | 'failed', string> = { removed: '已删除', kept: '保留', failed: '失败' };

export function formatSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** 项目设置 · 临时工作空间清理（ADR 0027 阶段 3）：规则开关、立即清理、清理记录、孤儿目录。只删检出目录，分支和检查点历史都留着。 */
export function WorkspaceCleanup({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const policy = useQuery({ queryKey: ['cleanup-policy', projectId], queryFn: () => api.cleanupPolicy(projectId) });
  const records = useQuery({ queryKey: ['cleanup-records', projectId], queryFn: () => api.cleanupRecords(projectId) });
  const [note, setNote] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (input: Partial<CleanupPolicyDto>) => api.saveCleanupPolicy(projectId, input),
    onSuccess: (value) => queryClient.setQueryData(['cleanup-policy', projectId], value),
    onError: (error) => setNote((error as Error).message)
  });
  const sweep = useMutation({
    mutationFn: () => api.sweepProject(projectId),
    onSuccess: (report) => {
      setNote(`删了 ${report.removed.length} 个，保留 ${report.kept.length} 个，跳过 ${report.skipped.length} 个`);
      void queryClient.invalidateQueries({ queryKey: ['cleanup-records', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces', projectId] });
    },
    onError: (error) => setNote((error as Error).message)
  });
  const p = policy.data;
  return (
    <section className="mb-3" data-testid="workspace-cleanup">
      <h3 className="mb-1 text-sub text-primary">临时工作空间清理</h3>
      <p className="mb-2 text-meta text-tertiary">只删检出目录；分支、提交和检查点历史都留着，下次开任务会从分支重新检出。有未提交、未跟踪或未推送内容的一律保留。</p>
      {p ? (
        <div className="mb-2 space-y-1 text-meta text-secondary">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={p.prMerged} onChange={(e) => save.mutate({ prMerged: e.target.checked })} /> PR 合并后删除（含 squash）
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={p.taskEndedClean} onChange={(e) => save.mutate({ taskEndedClean: e.target.checked })} /> 任务完成 / 放弃且没有未保存内容时删除
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <input type="checkbox" checked={p.idleDays !== null} onChange={(e) => save.mutate({ idleDays: e.target.checked ? 14 : null })} /> 闲置超过
            <input
              type="number"
              min={1}
              max={365}
              className="w-16 rounded border border-default bg-transparent px-1"
              disabled={p.idleDays === null}
              value={p.idleDays ?? 14}
              onChange={(e) => {
                const days = Number(e.target.value);
                if (Number.isInteger(days) && days >= 1) save.mutate({ idleDays: days });
              }}
            />
            天删除
          </label>
        </div>
      ) : null}
      <button type="button" className={SECONDARY_BUTTON} disabled={sweep.isPending} onClick={() => sweep.mutate()}>
        {sweep.isPending ? '清理中…' : '立即清理'}
      </button>
      {note ? <p className="mt-1 text-meta text-secondary">{note}</p> : null}
      <h4 className="mb-1 mt-3 text-meta text-secondary">清理记录</h4>
      {records.data && records.data.items.length === 0 ? <p className="text-meta text-tertiary">还没有记录。</p> : null}
      <ul className="space-y-1">
        {(records.data?.items ?? []).slice(0, 50).map((item) => (
          <li key={`${item.runId}-${item.workspaceId}`} className="break-all text-meta text-secondary" data-testid="cleanup-item">
            <span className={item.action === 'removed' ? 'text-primary' : 'text-tertiary'}>{ACTION[item.action]}</span> · {item.branch ?? item.path} · {formatSize(item.sizeBytes)} · {item.reason}
            <span className="text-tertiary"> · {new Date(item.at).toLocaleString()}</span>
          </li>
        ))}
      </ul>
      {records.data && records.data.orphans.length > 0 ? (
        <>
          <h4 className="mb-1 mt-3 text-meta text-secondary">没有登记的目录（不会自动删）</h4>
          <ul className="space-y-1">
            {records.data.orphans.map((o) => (
              <li key={`${o.workerId ?? ''}${o.path}`} className="break-all text-meta text-tertiary" data-testid="cleanup-orphan">
                {o.path}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
