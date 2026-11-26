import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TerminalPanel } from '../../atoms/terminal-panel.tsx';
import { newClientMessageId } from '../../atoms/pending-prompt.ts';
import { workspaceName } from '../../atoms/workspace-format.ts';
import { api, RequestFailed, type CanvasDto, type WorkspaceDto } from '../../shell/api.ts';
import { workdirTerminalPath } from '../../shell/api/hub.ts';
import { resolveWorker, useWorkers } from '../../shell/workers.tsx';
import { useWorkspaceViews } from './workspace-chooser.tsx';
import { eligibleWorkdir } from './workdir-model.ts';

/** Registered directories are a separate source from the session-derived tree. */
export function WorkdirEntries({ projectId, onOpen }: { projectId: string; onOpen: (id: string) => void }) {
  const views = useWorkspaceViews(projectId);
  const eligible = (views.data ?? []).filter(({ workspace, ownerProjectId }) => eligibleWorkdir(workspace, ownerProjectId, projectId));
  if (!eligible.length) return null;
  return <section aria-label="登记的工作目录" className="border-b border-hair px-2 py-2">
    <p className="px-2 text-meta text-tertiary">登记的工作目录</p>
    {eligible.map(({ workspace }) => <button key={workspace.id} type="button" data-testid="workdir-entry" data-workspace-id={workspace.id} onClick={() => onOpen(workspace.id)} className="flex min-h-[44px] w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
      <span className="min-w-0 flex-1"><span className="block truncate text-sub text-primary">{workspaceName(workspace)}</span><span className="block truncate text-meta text-tertiary">{workspace.path}</span></span><span aria-hidden>↗</span>
    </button>)}
  </section>;
}

type Tab = { kind: 'session' | 'terminal'; id: string };
type Layout = { tabs: Tab[]; selected: string | null; closing: string[]; closed: string[]; pendingCreate: string | null };
const keyOf = (tab: Tab) => `${tab.kind}:${tab.id}`;
const empty: Layout = { tabs: [], selected: null, closing: [], closed: [], pendingCreate: null };
function readLayout(key: string): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as Layout | null;
    if (!raw || !Array.isArray(raw.tabs)) return empty;
    return { tabs: raw.tabs.filter((tab) => tab && (tab.kind === 'session' || tab.kind === 'terminal') && typeof tab.id === 'string'), selected: typeof raw.selected === 'string' ? raw.selected : null, closing: Array.isArray(raw.closing) ? raw.closing.filter((id) => typeof id === 'string') : [], closed: Array.isArray(raw.closed) ? raw.closed.filter((id) => typeof id === 'string') : [], pendingCreate: typeof raw.pendingCreate === 'string' ? raw.pendingCreate : null };
  } catch { return empty; }
}

export function WorkdirTabs({ accountId, projectId, workspace, canvas, onBack, onSession, renderSession, onNewSession, openSessionId }: {
  accountId: string; projectId: string; workspace: WorkspaceDto; canvas: CanvasDto;
  onBack: () => void; onSession: (id: string | null) => void; renderSession: (id: string) => ReactNode;
  onNewSession: (workspace: WorkspaceDto, workerId: string) => void;
  openSessionId: string | null;
}) {
  const scope = `agent-hub.workdir-tabs:${JSON.stringify([accountId, projectId, workspace.id])}`;
  const [layout, setLayout] = useState<Layout>(() => readLayout(scope));
  const [menu, setMenu] = useState<'add' | 'tabs' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const workers = useWorkers();
  const worker = resolveWorker(workers.list, workspace.workerId);
  const query = useQuery({ queryKey: ['workdir-terminals', accountId, projectId, workspace.id], queryFn: () => api.workdirTerminals(projectId, workspace.id), retry: false, refetchInterval: 3000 });
  const terminals = query.isError ? [] : query.data?.terminals ?? [];
  useEffect(() => {
    if (!openSessionId) return;
    const tab: Tab = { kind: 'session', id: openSessionId };
    setLayout((current) => ({ ...current, tabs: current.tabs.some((t) => keyOf(t) === keyOf(tab)) ? current.tabs : [...current.tabs, tab], selected: keyOf(tab) }));
  }, [openSessionId]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenu(null); (menu === 'add' ? addRef : chooseRef).current?.focus(); } };
    const onPointer = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onPointer);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); };
  }, [menu]);
  useEffect(() => { try { localStorage.setItem(scope, JSON.stringify(layout)); } catch { /* storage is optional */ } }, [scope, layout]);
  useEffect(() => {
    if (!query.data || query.isError) return;
    setLayout((current) => {
      const closing = [...new Set([...current.closing, ...query.data.terminals.filter((t) => t.state === 'closing').map((t) => t.id)])];
      const endedClosing = new Set(query.data.terminals.filter((t) => t.state === 'ended' && closing.includes(t.id)).map((t) => t.id));
      const closed = [...new Set([...current.closed, ...endedClosing])];
      const tabs = current.tabs.filter((t) => t.kind === 'session' || !endedClosing.has(t.id));
      for (const terminal of query.data.terminals) if (terminal.state !== 'ended' && !closed.includes(terminal.id) && !tabs.some((t) => t.kind === 'terminal' && t.id === terminal.id)) tabs.push({ kind: 'terminal', id: terminal.id });
      const remainingClosing = closing.filter((id) => !endedClosing.has(id));
      const selected = tabs.some((t) => keyOf(t) === current.selected) ? current.selected : tabs[0] ? keyOf(tabs[0]) : null;
      const next = { ...current, tabs, selected, closing: remainingClosing, closed };
      if (JSON.stringify(next) === JSON.stringify(current)) return current;
      return next;
    });
  }, [query.data, query.isError, canvas.sessions, workspace.id]);
  useEffect(() => {
    if (!query.data || query.isError) return;
    for (const id of layout.closing) {
      const terminal = query.data.terminals.find((item) => item.id === id);
      if (terminal && terminal.state !== 'ended' && terminal.state !== 'closing') {
        void api.closeWorkdirTerminal(projectId, workspace.id, id).then(() => query.refetch(), () => undefined);
      }
    }
  }, [query.dataUpdatedAt, query.isError, layout.closing, projectId, workspace.id]);
  const selected = layout.tabs.find((tab) => keyOf(tab) === layout.selected);
  useEffect(() => { onSession(selected?.kind === 'session' ? selected.id : null); }, [selected?.kind, selected?.id, onSession]);
  const restoreMenuFocus = () => requestAnimationFrame(() => {
    const target = chooseRef.current && chooseRef.current.getClientRects().length ? chooseRef.current : addRef.current;
    target?.focus();
  });
  const select = (tab: Tab) => { const fromMenu = menu !== null; setLayout((current) => ({ ...current, selected: keyOf(tab) })); setMenu(null); if (fromMenu) restoreMenuFocus(); };
  const close = async (tab: Tab) => {
    setMenu(null);
    restoreMenuFocus();
    if (tab.kind === 'session') {
      setLayout((current) => { const tabs = current.tabs.filter((item) => keyOf(item) !== keyOf(tab)); return { ...current, tabs, selected: current.selected === keyOf(tab) ? (tabs[0] ? keyOf(tabs[0]) : null) : current.selected }; });
      return;
    }
    setLayout((current) => ({ ...current, closing: [...new Set([...current.closing, tab.id])] }));
    try { await api.closeWorkdirTerminal(projectId, workspace.id, tab.id); setError(null); } catch { setError('关闭待确认，正在重新核对'); }
    void query.refetch();
  };
  const create = async () => {
    if (creating) return;
    setCreating(true); setMenu(null); setError(null);
    const requestId = layout.pendingCreate ?? newClientMessageId();
    // Persist before issuing the POST: a reload after an ambiguous response must reuse this id.
    try { localStorage.setItem(scope, JSON.stringify({ ...layout, pendingCreate: requestId })); } catch { /* storage optional */ }
    setLayout((current) => ({ ...current, pendingCreate: requestId }));
    try {
      const terminal = await api.createWorkdirTerminal(projectId, workspace.id, requestId);
      setLayout((current) => ({ ...current, pendingCreate: null, tabs: [...current.tabs.filter((t) => keyOf(t) !== `terminal:${terminal.id}`), { kind: 'terminal', id: terminal.id }], selected: `terminal:${terminal.id}` }));
      await query.refetch();
    } catch (e) { setError(`创建结果未确认：${e instanceof Error ? e.message : '请重试'}；重试不会重复创建`); }
    finally { setCreating(false); }
  };
  const label = (tab: Tab) => tab.kind === 'session' ? canvas.sessions.find((s) => s.id === tab.id)?.title || `会话 ${tab.id.slice(-4)}` : terminals.find((t) => t.id === tab.id)?.title || '终端';
  const terminal = selected?.kind === 'terminal' ? terminals.find((t) => t.id === selected.id) : undefined;
  const unsupported = query.data?.available === false && query.data.reason === '机器不支持独立终端';
  // Disabling admission still permits an authorized running terminal to be drained.
  const canAttach = !query.isError && (query.data?.available === true || (query.data?.available === false && query.data.reason === '工作目录终端未启用'));
  const unavailable = query.isError ? (query.error instanceof RequestFailed && query.error.status === 404 ? '工作目录或独立终端接口不可用' : query.error instanceof Error ? query.error.message : '读取终端失败') : query.data?.available === false ? query.data.reason || '独立终端不可用' : null;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="workdir-tabs">
    <div ref={menuRef} className="flex min-h-[44px] shrink-0 items-center gap-1 border-b border-hair bg-panel px-2">
      <button type="button" onClick={onBack} className="min-h-[44px] px-2 text-sub text-tertiary" aria-label="返回列表">←</button>
      <span className="max-w-36 truncate px-1 text-sub text-primary" title={workspace.path}>{workspaceName(workspace)}</span>
      <div className="hidden min-w-0 flex-1 items-center overflow-x-auto md:flex">{layout.tabs.map((tab) => <div key={keyOf(tab)} className={`flex shrink-0 items-center border-b-2 ${layout.selected === keyOf(tab) ? 'border-sage text-primary' : 'border-transparent text-tertiary'}`}><button type="button" data-testid={`workdir-tab-${tab.kind}`} aria-current={layout.selected === keyOf(tab) ? 'page' : undefined} onClick={() => select(tab)} className="min-h-[44px] max-w-40 truncate px-3 text-sub">{label(tab)}{tab.kind === 'terminal' && layout.closing.includes(tab.id) ? ' · 关闭待确认' : ''}</button><button type="button" data-testid="workdir-close-tab" aria-label={`关闭${label(tab)}`} className="min-h-[44px] min-w-[44px]" onClick={() => void close(tab)}>×</button></div>)}</div>
      <div className="relative ml-auto md:hidden"><button ref={chooseRef} type="button" data-testid="workdir-choose-tab" className="min-h-[44px] px-3 text-sub text-primary" aria-expanded={menu === 'tabs'} onClick={() => setMenu(menu === 'tabs' ? null : 'tabs')}>{selected ? label(selected) : '选择标签'} · {layout.tabs.length}</button>{menu === 'tabs' ? <div className="absolute right-0 top-full z-30 w-64 rounded-md border border-hair bg-panel p-1 shadow-lg">{layout.tabs.map((tab) => <div key={keyOf(tab)} className="flex"><button type="button" data-testid={`workdir-tab-${tab.kind}`} onClick={() => select(tab)} className="min-h-[44px] min-w-0 flex-1 truncate px-3 text-left text-sub">{label(tab)}{tab.kind === 'terminal' && layout.closing.includes(tab.id) ? ' · 关闭待确认' : ''}</button><button type="button" data-testid="workdir-close-tab" aria-label={`关闭${label(tab)}`} className="min-h-[44px] min-w-[44px]" onClick={() => void close(tab)}>×</button></div>)}</div> : null}</div>
      <div className="relative"><button ref={addRef} type="button" data-testid="workdir-add" aria-label="新建标签" aria-expanded={menu === 'add'} onClick={() => setMenu(menu === 'add' ? null : 'add')} className="min-h-[44px] min-w-[44px] text-lg">＋</button>{menu === 'add' ? <div className="absolute right-0 top-full z-30 max-h-80 w-56 overflow-y-auto rounded-md border border-hair bg-panel p-1 shadow-lg"><button type="button" data-testid="workdir-new-session" onClick={() => { setMenu(null); if (worker) onNewSession(workspace, worker.workerId); }} disabled={!worker} className="min-h-[44px] w-full px-3 text-left text-sub disabled:opacity-50">新建会话</button>{!unsupported ? <button type="button" data-testid="workdir-new-terminal" disabled={!query.data?.available || query.isError || creating} onClick={() => void create()} className="min-h-[44px] w-full px-3 text-left text-sub disabled:opacity-50">{layout.pendingCreate ? '确认上次创建' : '新建终端'}</button> : null}{canvas.sessions.filter((s) => s.workspaceId === workspace.id && !s.groupId && !layout.tabs.some((t) => t.kind === 'session' && t.id === s.id)).map((s) => <button key={s.id} type="button" data-testid="workdir-open-session" onClick={() => { const tab: Tab = { kind: 'session', id: s.id }; setLayout((current) => ({ ...current, tabs: [...current.tabs, tab], selected: keyOf(tab) })); setMenu(null); restoreMenuFocus(); }} className="block min-h-[44px] w-full truncate border-t border-hair px-3 text-left text-sub">打开 {s.title || `会话 ${s.id.slice(-4)}`}</button>)}</div> : null}</div>
    </div>
    {error || unavailable ? <p role="status" data-testid="workdir-state" className="border-b border-hair px-4 py-2 text-sub text-tertiary">{error || unavailable}</p> : null}
    {selected?.kind === 'session' ? renderSession(selected.id) : terminal && !query.isError ? terminal.state === 'ended' ? <div className="p-6 text-sub text-tertiary">终端已结束</div> : terminal.state === 'closing' || layout.closing.includes(terminal.id) ? <div className="p-6 text-sub text-tertiary">关闭待确认</div> : terminal.state === 'pending' ? <div className="p-6 text-sub text-tertiary">终端启动待确认</div> : canAttach && terminal.state === 'running' ? <TerminalPanel key={`${accountId}:${terminal.id}`} sessionId={terminal.id} workerId={workspace.workerId} active socketPath={`${workdirTerminalPath(projectId, workspace.id)}/${encodeURIComponent(terminal.id)}/socket`} /> : <div className="p-6 text-sub text-tertiary">终端状态暂不可用</div> : selected?.kind === 'terminal' ? <div className="p-6 text-sub text-tertiary">{layout.closing.includes(selected.id) ? '关闭待确认' : '终端状态暂不可用'}</div> : <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sub text-tertiary"><p>这里还没有打开的标签</p><p>用右上角的 ＋ 新建会话或终端。</p></div>}
  </div>;
}
