import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';

const KIND_TEXT: Record<string, string> = { skill: '技能', instruction: '指令', mcp: 'MCP' };

/**
 * 检查器 · 资产：这次会话启动时实际用上的技能 / 指令 / MCP。
 * 默认是一行小标签（没有就不占地方）；`detailed` 放在「详情」里，带版本（digest 前 8 位）和作用域。
 */
export function SessionAssets({ sessionId, detailed = false }: { sessionId: string; detailed?: boolean }) {
  const manifest = useQuery({ queryKey: ['session-assets', sessionId], queryFn: () => api.sessionAssets(sessionId), refetchInterval: 15_000 });
  const entries = manifest.data?.entries ?? [];
  if (!detailed) {
    if (entries.length === 0) return null;
    return (
      <section className="mb-2 flex flex-wrap items-center gap-1" data-testid="session-assets" aria-label="资产">
        <span className="mr-0.5 text-meta text-tertiary">资产 {entries.length}</span>
        {entries.map((entry) => (
          <span
            key={entry.assetId}
            data-testid="session-asset"
            title={`${KIND_TEXT[entry.kind] ?? entry.kind} · ${entry.digest.slice(0, 8)} · ${entry.scope === 'project' ? '本项目' : '全局'}`}
            className="max-w-[140px] truncate rounded-sm border border-hair px-1.5 text-meta text-secondary"
          >
            {entry.name}
          </span>
        ))}
      </section>
    );
  }
  return (
    <section>
      <p className="mb-1 text-meta text-tertiary">资产</p>
      {manifest.isLoading ? <p className="text-meta text-tertiary">加载中…</p> : null}
      {manifest.data && manifest.data.at === null ? <p className="text-meta text-tertiary">这次会话启动时没有记录资产清单</p> : null}
      {manifest.data && manifest.data.at !== null && entries.length === 0 ? <p className="text-meta text-tertiary">没有用到资产</p> : null}
      {entries.map((entry) => (
        <p key={entry.assetId} className="flex items-center gap-1.5 text-meta">
          <span className="rounded border border-strong px-1 text-secondary">{KIND_TEXT[entry.kind] ?? entry.kind}</span>
          <span className="min-w-0 flex-1 truncate text-primary">{entry.name}</span>
          <span className="font-mono text-tertiary" title={entry.digest}>
            {entry.digest.slice(0, 8)}
          </span>
          <span className={entry.scope === 'project' ? 'text-accent' : 'text-tertiary'}>{entry.scope === 'project' ? '本项目' : '全局'}</span>
        </p>
      ))}
    </section>
  );
}
