import { useMemo, useState } from 'react';
import type { TaskDto, WorkspaceDto } from '@agent-hub/contract';
import type { AgentDto, SessionDto } from '../shell/api.ts';
import { DialogShell, INPUT } from '../shell/dialog-shell.tsx';
import { resolveWorker, useWorkers } from '../shell/workers.tsx';

/** 会话 id 的最后 8 位，和画布卡片上的短号一致。 */
function shortId(id: string): string {
  return id.slice(-8);
}

/**
 * 会话连线选择器：和画布上拖出来的边是同一份关系。
 * 只列同项目里还能说话的会话；已连接的置顶，方便一眼看到和断开。
 * 行内给出任务 / 机器 / 工作空间 / 短号，避免同名会话分不清。
 */
export function SessionLinksDialog({
  sessions,
  currentId,
  linked,
  openings,
  agents,
  tasks,
  workspaces,
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
  readonly tasks: readonly TaskDto[];
  readonly workspaces: readonly WorkspaceDto[];
  readonly busyId: string | null;
  readonly error: string | null;
  readonly onToggle: (sessionId: string, linked: boolean) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const workers = useWorkers();
  const agentLabel = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.label])), [agents]);
  const taskTitle = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);
  const workspaceName = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.label?.trim() || workspace.path.split('/').filter(Boolean).at(-1) || workspace.path])),
    [workspaces]
  );
  const current = sessions.find((session) => session.id === currentId);
  const currentOnline = workers.list.length === 0 || resolveWorker(workers.list, current?.workerId)?.state === 'online';
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions
      .filter((session) => session.id !== currentId && session.status !== 'failed')
      .map((session) => {
        const worker = resolveWorker(workers.list, session.workerId);
        const known = workers.list.length > 0;
        const online = !known || worker?.state === 'online';
        return {
          session,
          title: session.title?.trim() || openings[session.id]?.trim() || '未命名会话',
          agent: agentLabel.get(session.agentId) ?? session.agentId,
          task: taskTitle.get(session.taskId) ?? '未命名任务',
          worker: worker?.label ?? '未知机器',
          online,
          workspace: session.workspaceId ? (workspaceName.get(session.workspaceId) ?? '未知工作空间') : '未选工作空间',
          connected: linked.has(session.id)
        };
      })
      .filter(
        (row) =>
          needle === '' ||
          `${row.title} ${row.agent} ${row.task} ${row.worker} ${row.workspace} ${shortId(row.session.id)}`.toLowerCase().includes(needle)
      )
      .sort(
        (a, b) =>
          Number(b.connected) - Number(a.connected) ||
          Number(b.online) - Number(a.online) ||
          a.title.localeCompare(b.title)
      );
  }, [sessions, currentId, openings, agents, linked, query, agentLabel, taskTitle, workspaceName, workers.list]);

  return (
    <DialogShell title="连接会话" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-head text-primary">连接会话</h2>
          <p className="mt-1 text-meta text-tertiary">只有连过的会话能互相发消息，也可以从画布拖线。</p>
          {!currentOnline ? (
            <p className="mt-1 text-meta text-rust">当前会话所在的机器不在线，暂时不能新建连接。</p>
          ) : null}
        </div>
        <button aria-label="关闭" className="rounded-sm px-2 py-1 text-body text-tertiary hover:text-primary" onClick={onClose}>
          ×
        </button>
      </div>
      <input
        className={`${INPUT} mb-2`}
        placeholder="搜索会话、任务、机器"
        aria-label="搜索会话"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error ? <p role="alert" className="mb-2 rounded-sm border-l-2 border-rust bg-rust/10 px-2 py-1 text-meta text-rust">{error}</p> : null}
      {rows.length === 0 ? (
        <p className="py-6 text-center text-meta text-tertiary">同项目里还没有其他会话</p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="session-link-options" aria-busy={busyId !== null}>
          {rows.map((row) => {
            const busy = busyId === row.session.id;
            const pending = busyId !== null;
            // 已连接的离线会话仍允许断开；未连接的离线会话不允许新建连接。
            const blocked = !row.connected && (!currentOnline || !row.online);
            const disabled = pending || blocked;
            return (
              <label
                key={row.session.id}
                className={`flex items-start gap-2 rounded-sm border px-2 py-2 ${
                  row.connected ? 'border-accent/50 bg-card-raised' : 'border-hair hover:border-strong'
                } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={row.connected}
                  disabled={disabled}
                  aria-label={`连接 ${row.title}`}
                  onChange={() => onToggle(row.session.id, !row.connected)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-sub text-primary">{row.title}</span>
                    {busy ? (
                      <span className="shrink-0 text-meta text-tertiary" aria-live="polite">处理中…</span>
                    ) : row.connected ? (
                      <span className="shrink-0 text-meta text-accent">已连接</span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-meta text-secondary">
                    {row.task} · {row.worker} · {row.workspace}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-meta text-tertiary">
                    <span>{row.agent}</span>
                    <span>·</span>
                    <span>{row.session.status}</span>
                    <span>·</span>
                    <span className="font-mono">#{shortId(row.session.id)}</span>
                    {!row.online ? <span className="text-rust">· 机器离线</span> : null}
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
