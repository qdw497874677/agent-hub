import { useMemo, useState } from 'react';
import type { AgentDto, SessionDto } from './api.ts';
import { DialogShell, INPUT } from './dialog-shell.tsx';

/**
 * 会话连线选择器：和画布上拖出来的边是同一份关系。
 * 只列同项目里还能说话的会话；已连接的置顶，方便一眼看到和断开。
 */
export function SessionLinksDialog({
  sessions,
  currentId,
  linked,
  openings,
  agents,
  busyId,
  error,
  onToggle,
  onClose
}: {
  readonly sessions: readonly SessionDto[];
  readonly currentId: string;
  readonly linked: ReadonlySet<string>;
  readonly openings: Readonly<Record<string, string>>;
  readonly agents: readonly AgentDto[];
  readonly busyId: string | null;
  readonly error: string | null;
  readonly onToggle: (sessionId: string, linked: boolean) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const agentLabel = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.label])), [agents]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions
      .filter((session) => session.id !== currentId && session.status !== 'failed')
      .map((session) => ({
        session,
        title: session.title?.trim() || openings[session.id]?.trim() || '未命名会话',
        agent: agentLabel.get(session.agentId) ?? session.agentId,
        connected: linked.has(session.id)
      }))
      .filter((row) => needle === '' || `${row.title} ${row.agent}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.connected) - Number(a.connected) || a.title.localeCompare(b.title));
  }, [sessions, currentId, openings, agents, linked, query, agentLabel]);

  return (
    <DialogShell title="连接会话" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-head text-primary">连接会话</h2>
          <p className="mt-1 text-meta text-tertiary">只有连过的会话能互相发消息，也可以从画布拖线。</p>
        </div>
        <button aria-label="关闭" className="rounded-sm px-2 py-1 text-body text-tertiary hover:text-primary" onClick={onClose}>
          ×
        </button>
      </div>
      <input
        className={`${INPUT} mb-2`}
        placeholder="搜索会话"
        aria-label="搜索会话"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error ? <p role="alert" className="mb-2 rounded-sm border-l-2 border-rust bg-rust/10 px-2 py-1 text-meta text-rust">{error}</p> : null}
      {rows.length === 0 ? (
        <p className="py-6 text-center text-meta text-tertiary">同项目里还没有其他会话</p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="session-link-options">
          {rows.map((row) => {
            const busy = busyId === row.session.id;
            return (
              <label
                key={row.session.id}
                className={`flex cursor-pointer items-start gap-2 rounded-sm border px-2 py-2 ${
                  row.connected ? 'border-accent/50 bg-card-raised' : 'border-hair hover:border-strong'
                } ${busy ? 'opacity-60' : ''}`}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={row.connected}
                  disabled={busy}
                  aria-label={`连接 ${row.title}`}
                  onChange={() => onToggle(row.session.id, !row.connected)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-sub text-primary">{row.title}</span>
                    {row.connected ? <span className="shrink-0 text-meta text-accent">已连接</span> : null}
                  </span>
                  <span className="mt-0.5 flex gap-2 text-meta text-tertiary">
                    <span>{row.agent}</span>
                    <span>·</span>
                    <span>{row.session.status}</span>
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </DialogShell>
  );
}
