import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TerminalPanel } from '../../atoms/terminal-panel.tsx';
import { newClientMessageId } from '../../atoms/pending-prompt.ts';
import { api, RequestFailed, sessionGroupId, type CanvasDto, type SessionDto, type WorkspaceDto } from '../../shell/api.ts';
import { workdirTerminalPath } from '../../shell/api/hub.ts';
import { Sheet } from '../../shell/dialog-shell.tsx';
import { useWorkspaceViews } from './workspace-chooser.tsx';
import { eligibleWorkdir, terminalErrorText, terminalPollInterval, workdirLabels, workdirSessionLabel } from './workdir-model.ts';
import { SessionTabCreate } from './session-tab-create.tsx';

type Tab = { kind: 'session' | 'terminal'; id: string; workspaceId?: string; taskId?: string | null };
type Layout = { tabs: Tab[]; selected: string | null; closing: string[]; closed: string[]; pendingCreate: string | null; pendingWorkspaceId?: string | null };
const keyOf = (tab: Tab) => `${tab.kind}:${tab.id}`;
function initial(key: string, sessionId: string | null, legacyKey?: string): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? (legacyKey ? localStorage.getItem(legacyKey) : null) ?? 'null') as Layout | null;
    if (raw && Array.isArray(raw.tabs)) return { tabs: raw.tabs.filter((t) => t && (t.kind === 'session' || t.kind === 'terminal') && typeof t.id === 'string'), selected: typeof raw.selected === 'string' ? raw.selected : null, closing: Array.isArray(raw.closing) ? raw.closing.filter((x) => typeof x === 'string') : [], closed: Array.isArray(raw.closed) ? raw.closed.filter((x) => typeof x === 'string') : [], pendingCreate: typeof raw.pendingCreate === 'string' ? raw.pendingCreate : null, pendingWorkspaceId: typeof raw.pendingWorkspaceId === 'string' ? raw.pendingWorkspaceId : legacyKey ? JSON.parse(legacyKey.slice(legacyKey.indexOf('[')))[2] : null };
  } catch { /* optional storage */ }
  return { tabs: sessionId ? [{ kind: 'session', id: sessionId }] : [], selected: sessionId ? `session:${sessionId}` : null, closing: [], closed: [], pendingCreate: null };
}

/** One local open-view set per host. Host keys must be stable for the lifetime of a canvas window. */
export function SessionDocumentTabs({ accountId, canvas, scopeKey, initialSessionId, anchorSessionId, workspace, onSession, onBack, onNewSessionCreated, onRefresh, renderSession, sessionUnavailable, standaloneActions, worktreeAction }: {
  accountId: string; canvas: CanvasDto; scopeKey: string; initialSessionId: string | null; workspace?: WorkspaceDto;
  anchorSessionId?: string;
  onSession: (id: string | null) => void; onBack?: () => void; onNewSessionCreated: (session: SessionDto) => void;
  renderSession: (id: string, navigation: ReactNode) => ReactNode;
  sessionUnavailable?: ReactNode | ((id: string) => ReactNode);
  standaloneActions?: ReactNode;
  onRefresh: () => void;
  worktreeAction?: ReactNode;
}) {
  const storage = `agent-hub.session-document-tabs:${JSON.stringify([accountId, canvas.project.id, scopeKey])}`;
  const [layout, setLayout] = useState(() => {
    const saved = initial(storage, initialSessionId, workspace ? `agent-hub.workdir-tabs:${JSON.stringify([accountId, canvas.project.id, workspace.id])}` : undefined);
    if (!initialSessionId) return saved;
    const tab: Tab = { kind: 'session', id: initialSessionId };
    return { ...saved, tabs: saved.tabs.some((item) => keyOf(item) === keyOf(tab)) ? saved.tabs : [...saved.tabs, tab], selected: keyOf(tab) };
  });
  const [menu, setMenu] = useState<'add' | 'tabs' | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [uncertainSession, setUncertainSession] = useState(false);
  const [creatingTerminal, setCreatingTerminal] = useState(false);
  const [error, setError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const lastInput = useRef(initialSessionId);
  const terminalLock = useRef(false);
  const views = useWorkspaceViews(canvas.project.id);
  const source = canvas.sessions.find((s) => s.id === (anchorSessionId ?? initialSessionId));
  const activeSession = layout.tabs.find((t) => keyOf(t) === layout.selected && t.kind === 'session');
  const currentSource = canvas.sessions.find((s) => s.id === activeSession?.id) ?? source;
  const selectedTab = layout.tabs.find((t) => keyOf(t) === layout.selected);
  const targetWorkspaceId = selectedTab?.kind === 'terminal' ? selectedTab.workspaceId ?? workspace?.id : !sessionGroupId(currentSource) ? currentSource?.workspaceId ?? workspace?.id : undefined;
  const targetTaskId = selectedTab?.kind === 'terminal' ? selectedTab.taskId : currentSource?.taskId;
  const workdir = (views.data ?? []).find(({ workspace: item, ownerProjectId }) => item.id === targetWorkspaceId && !item.groupId && (eligibleWorkdir(item, ownerProjectId, canvas.project.id) || (item.kind === 'temporary' && item.projectId === canvas.project.id && item.ownerTaskId === targetTaskId && (item.state === 'ready' || item.state === 'kept'))))?.workspace ?? (workspace?.id === targetWorkspaceId ? workspace : undefined);
  const projectId = canvas.project.id;
  const query = useQuery({ queryKey: ['workdir-terminals', accountId, projectId, workdir?.id], queryFn: () => api.workdirTerminals(projectId, workdir!.id), enabled: !!workdir, retry: false, refetchInterval: (q) => terminalPollInterval(q.state.error instanceof RequestFailed ? q.state.error.status : undefined, q.state.data, !!layout.pendingCreate || layout.closing.length > 0 || creatingTerminal, q.state.status === 'error') });
  const terminals = query.isError ? [] : query.data?.terminals ?? [];
  useEffect(() => { try { localStorage.setItem(storage, JSON.stringify(layout)); } catch { /* storage optional */ } }, [storage, layout]);
  useEffect(() => {
    if (anchorSessionId !== undefined || initialSessionId === lastInput.current) return;
    lastInput.current = initialSessionId;
    if (!initialSessionId) return;
    const tab: Tab = { kind: 'session', id: initialSessionId };
    setLayout((old) => ({ ...old, tabs: old.tabs.some((t) => keyOf(t) === keyOf(tab)) ? old.tabs : [...old.tabs, tab], selected: keyOf(tab) }));
  }, [initialSessionId, anchorSessionId]);
  useEffect(() => {
    if (!query.data || query.isError) return;
    setLayout((old) => {
      const closing = [...new Set([...old.closing, ...query.data!.terminals.filter((t) => t.state === 'closing').map((t) => t.id)])];
      const ended = new Set(query.data!.terminals.filter((t) => t.state === 'ended' && closing.includes(t.id)).map((t) => t.id));
      const tabs = old.tabs.filter((t) => t.kind !== 'terminal' || !ended.has(t.id));
      for (const terminal of query.data!.terminals) if (terminal.state !== 'ended' && !old.closed.includes(terminal.id) && !tabs.some((t) => t.kind === 'terminal' && t.id === terminal.id)) tabs.push({ kind: 'terminal', id: terminal.id, workspaceId: workdir?.id, taskId: targetTaskId });
      const next = { ...old, tabs, closing: closing.filter((id) => !ended.has(id)), closed: [...new Set([...old.closed, ...ended])], selected: old.selected && !tabs.some((t) => keyOf(t) === old.selected) ? (tabs[0] ? keyOf(tabs[0]) : null) : old.selected };
      return JSON.stringify(next) === JSON.stringify(old) ? old : next;
    });
  }, [query.data, query.isError]);
  useEffect(() => {
    if (!workdir || !query.data || query.isError) return;
    for (const id of layout.closing) { const item = query.data.terminals.find((t) => t.id === id); if (item && item.state !== 'ended' && item.state !== 'closing') void api.closeWorkdirTerminal(projectId, workdir.id, id).then(() => query.refetch(), () => undefined); }
  }, [query.dataUpdatedAt, query.isError, layout.closing, projectId, workdir?.id]);
  useEffect(() => {
    if (!menu) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && menu === 'add') setMenu(null); };
    const pointer = (event: PointerEvent) => { if (menu === 'add' && !menuRef.current?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener('keydown', key); document.addEventListener('pointerdown', pointer);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', pointer); };
  }, [menu]);
  const selected = layout.tabs.find((t) => keyOf(t) === layout.selected);
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  useEffect(() => { onSessionRef.current(selected?.kind === 'session' ? selected.id : null); }, [selected?.kind, selected?.id]);
  const select = (tab: Tab) => { setLayout((old) => ({ ...old, selected: keyOf(tab) })); setMenu(null); onSession(tab.kind === 'session' ? tab.id : null); };
  const addSession = (id: string) => { const tab: Tab = { kind: 'session', id }; setLayout((old) => ({ ...old, tabs: old.tabs.some((t) => keyOf(t) === keyOf(tab)) ? old.tabs : [...old.tabs, tab], selected: keyOf(tab) })); setMenu(null); onSession(id); };
  const close = async (tab: Tab) => {
    setMenu(null);
    if (tab.kind === 'session') {
      const tabs = layout.tabs.filter((t) => keyOf(t) !== keyOf(tab));
      const next = layout.selected === keyOf(tab) ? tabs[0] : selected;
      setLayout((old) => ({ ...old, tabs: old.tabs.filter((t) => keyOf(t) !== keyOf(tab)), selected: old.selected === keyOf(tab) ? (next ? keyOf(next) : null) : old.selected }));
      if (layout.selected === keyOf(tab)) onSession(next?.kind === 'session' ? next.id : null);
      return;
    }
    const target = tab.workspaceId ?? workspace?.id;
    if (!target) { setError('终端所属工作目录不可确认，无法关闭'); return; }
    setLayout((old) => ({ ...old, closing: [...new Set([...old.closing, tab.id])] }));
    try { await api.closeWorkdirTerminal(projectId, target, tab.id); setError(''); } catch { setError('关闭待确认，请稍后核对终端状态'); }
    void query.refetch();
  };
  const createTerminal = async () => {
    if (!workdir || terminalLock.current) return;
    if (layout.pendingCreate && layout.pendingWorkspaceId !== workdir.id) { setError('请先回到原工作目录确认上次创建'); return; }
    terminalLock.current = true; setCreatingTerminal(true); setMenu(null); setError('');
    const requestId = layout.pendingCreate ?? newClientMessageId();
    try { localStorage.setItem(storage, JSON.stringify({ ...layout, pendingCreate: requestId, pendingWorkspaceId: workdir.id })); } catch { /* storage optional */ }
    setLayout((old) => ({ ...old, pendingCreate: requestId, pendingWorkspaceId: workdir.id }));
    try {
      const terminal = await api.createWorkdirTerminal(projectId, workdir.id, requestId);
      setLayout((old) => ({ ...old, pendingCreate: null, pendingWorkspaceId: null, tabs: [...old.tabs.filter((t) => keyOf(t) !== `terminal:${terminal.id}`), { kind: 'terminal', id: terminal.id, workspaceId: workdir.id, taskId: targetTaskId }], selected: `terminal:${terminal.id}` }));
      onSession(null); void query.refetch();
    } catch { setError('创建结果未确认，请重试；重试不会重复创建'); }
    finally { terminalLock.current = false; setCreatingTerminal(false); }
  };
  const groupId = sessionGroupId(currentSource);
  const peers = groupId ? canvas.sessions.filter((s) => sessionGroupId(s) === groupId && s.workerId === currentSource?.workerId) : currentSource?.workspaceId ? canvas.sessions.filter((s) => !sessionGroupId(s) && s.workspaceId === currentSource.workspaceId && s.workerId === currentSource.workerId) : workspace ? canvas.sessions.filter((s) => !sessionGroupId(s) && s.workspaceId === workspace.id && s.workerId === workspace.workerId) : [];
  const unopened = peers.filter((s) => !layout.tabs.some((t) => t.kind === 'session' && t.id === s.id));
  const labelItem = (tab: Tab) => tab.kind === 'terminal' ? { id: tab.id, title: terminals.find((t) => t.id === tab.id)?.title || '终端' } : workdirSessionLabel(tab.id, canvas.sessions.find((s) => s.id === tab.id), canvas.tasks.find((t) => t.id === canvas.sessions.find((s) => s.id === tab.id)?.taskId), false);
  const labels = workdirLabels(layout.tabs.map(labelItem));
  const label = (tab: Tab) => labels[layout.tabs.findIndex((t) => keyOf(t) === keyOf(tab))] ?? labelItem(tab).title;
  const itemAttrs = (tab: Tab) => tab.kind === 'session' ? { 'data-session-id': tab.id } : { 'data-terminal-id': tab.id };
  const unavailable = !workdir ? '当前会话没有可用于独立终端的单个工作目录' : query.isError ? terminalErrorText(query.error instanceof RequestFailed ? query.error.status : undefined) : query.data?.available === false ? query.data.reason || '独立终端不可用' : null;
  const terminal = selected?.kind === 'terminal' ? terminals.find((t) => t.id === selected.id) : undefined;
  const list = <>{layout.tabs.map((tab) => <div key={keyOf(tab)} className={`flex min-w-0 shrink-0 items-center border-b-2 ${layout.selected === keyOf(tab) ? 'border-sage text-primary' : 'border-transparent text-secondary'}`}><button type="button" data-testid="session-tab-item" {...itemAttrs(tab)} aria-current={layout.selected === keyOf(tab) ? 'page' : undefined} className="min-h-[44px] max-w-40 truncate px-2 text-left text-sub" onClick={() => select(tab)}>{label(tab)}{tab.kind === 'terminal' && layout.closing.includes(tab.id) ? ' · 关闭待确认' : ''}</button><button type="button" data-testid="session-tab-close" {...itemAttrs(tab)} aria-label={`关闭${label(tab)}`} className="min-h-[44px] min-w-[44px] text-tertiary hover:text-primary" onClick={() => void close(tab)}>×</button></div>)}</>;
  const navigation = <div ref={menuRef} data-testid="session-document-tabs" className="relative flex min-w-0 shrink items-center gap-1">
    <div className="hidden min-w-0 overflow-x-auto md:flex">{list}</div>
    <button type="button" data-testid="session-tab-trigger" aria-label={`切换标签，共 ${layout.tabs.length} 个`} aria-expanded={menu === 'tabs'} className="min-h-[44px] min-w-[44px] shrink-0 text-meta text-secondary" onClick={() => setMenu(menu === 'tabs' ? null : 'tabs')}>{layout.tabs.length} ▾</button>
    <button type="button" data-testid="session-tab-add" aria-label="新建标签" aria-expanded={menu === 'add'} className="min-h-[44px] min-w-[44px] shrink-0 text-lg text-secondary hover:text-primary" onClick={() => setMenu(menu === 'add' ? null : 'add')}>＋</button>{worktreeAction}
    {menu === 'add' ? <div className="absolute right-0 top-full z-40 w-64 rounded-md border border-hair bg-panel p-1 shadow-lg"><button type="button" data-testid="session-tab-new-session" className="min-h-[44px] w-full px-3 text-left text-sub hover:bg-hover" disabled={uncertainSession} onClick={() => { setMenu(null); setCreatingSession(true); }}>新建会话</button><button type="button" data-testid="session-tab-new-terminal" disabled={!workdir || !query.data?.available || query.isError || creatingTerminal} className="min-h-[44px] w-full px-3 text-left text-sub hover:bg-hover disabled:opacity-50" onClick={() => void createTerminal()}>{layout.pendingCreate ? '确认上次创建' : '新建终端'}</button>{uncertainSession ? <p role="status" className="px-3 py-2 text-meta text-tertiary">创建结果待确认，请查看项目会话列表。</p> : null}{error || unavailable ? <p role="status" className="px-3 py-2 text-meta text-tertiary">{error || unavailable}</p> : null}</div> : null}
    {menu === 'tabs' ? <Sheet title="打开的标签" testId="session-tab-picker" onClose={() => setMenu(null)}><div className="flex flex-col">{list}</div><p className="border-t border-hair px-3 pt-3 text-meta text-tertiary">打开已有会话</p>{unopened.length ? unopened.map((s) => <button type="button" key={s.id} data-testid="session-tab-open-existing" data-session-id={s.id} onClick={() => addSession(s.id)} className="block min-h-[44px] w-full truncate px-3 text-left text-sub hover:bg-hover">{labelItem({ kind: 'session', id: s.id }).title}</button>) : <p className="px-3 py-2 text-meta text-tertiary">当前范围没有其他会话</p>}</Sheet> : null}
  </div>;
  const standaloneHeader = <header className="flex min-h-[48px] items-center gap-2 border-b border-hair px-2 window-drag-handle">{onBack ? <button type="button" onClick={onBack} className="min-h-[44px] min-w-[44px]" aria-label="返回">←</button> : null}<span className="min-w-0 flex-1 truncate text-sub text-primary">{selected ? label(selected) : '打开的标签'}</span>{navigation}{standaloneActions}</header>;
  const sessionContent = selected?.kind === 'session' ? renderSession(selected.id, navigation) : null;
  const unavailableContent = selected?.kind === 'session' ? (typeof sessionUnavailable === 'function' ? sessionUnavailable(selected.id) : sessionUnavailable) : null;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">{selected?.kind === 'session' ? sessionContent ?? <>{standaloneHeader}{unavailableContent ?? <div role="status" className="p-6 text-sub text-tertiary">正在读取会话…</div>}</> : <>{standaloneHeader}{terminal && !query.isError ? terminal.state === 'ended' ? <div className="p-6 text-sub text-tertiary">终端已结束</div> : terminal.state === 'closing' || layout.closing.includes(terminal.id) ? <div className="p-6 text-sub text-tertiary">关闭待确认</div> : terminal.state === 'pending' ? <div className="p-6 text-sub text-tertiary">终端启动待确认</div> : workdir && (query.data?.available || query.data?.reason === '工作目录终端未启用') ? <TerminalPanel key={`${accountId}:${terminal.id}`} sessionId={terminal.id} workerId={workdir.workerId} active socketPath={`${workdirTerminalPath(projectId, workdir.id)}/${encodeURIComponent(terminal.id)}/socket`} /> : <div role="status" className="p-6 text-tertiary">{unavailable}</div> : selected?.kind === 'terminal' ? <div role="status" className="p-6 text-tertiary">{error || unavailable || '终端状态暂不可用'}</div> : <div className="flex flex-1 items-center justify-center p-6 text-sub text-tertiary">用右上角的 ＋ 新建会话或终端。</div>}</>}{creatingSession ? <SessionTabCreate canvas={canvas} source={currentSource} workspace={workdir} onUncertain={() => { setUncertainSession(true); onRefresh(); }} onClose={() => setCreatingSession(false)} onCreated={(session) => { setCreatingSession(false); onNewSessionCreated(session); addSession(session.id); }} /> : null}</div>;
}
