import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { CanvasDto, ProjectDto, SessionDto } from '../../shell/api.ts';
import { AccountMenu } from '../../shell/auth.tsx';
import { AttentionBadge } from '../../atoms/attention.tsx';
import { GlobalNav } from '../../shell/global-nav.tsx';
import { Icon } from '../../atoms/icons.tsx';
import { MessagesEntry } from '../../atoms/messages-entry.tsx';
import { NotificationBell } from '../../shell/market/notifications.tsx';
import { openSettings, SettingsEntry } from '../../shell/settings-navigation.tsx';
import { useRoute } from '../../shell/use-route.ts';
import { MachinesBadge, resolveWorker, useWorkers } from '../../shell/workers.tsx';
import { coarsePointer, modKeyLabel } from '../../shell/device.ts';
import { PHASE_DOT, activeSessions, elapsedLabel, phaseLabel, phaseTone, sessionPhase, settledSessions } from './session-status.ts';
import { waitingForReply, type LiveMap } from '../../atoms/live.ts';
import { sessionActionItems, type SessionActionId, type SessionActionItem } from '../../atoms/session-actions.ts';
import { useSessionActions } from '../../atoms/use-session-actions.ts';
import { DeleteSessionDialog } from '../../atoms/delete-session-dialog.tsx';
import { SessionRowMenu } from './session-row-menu.tsx';
import { COORDINATOR_TITLE } from '../../atoms/session-groups.ts';
import { useCoordinators } from '../../shell/coordinators.ts';
import { workspaceSessionGroups, workspaceWorkerLabel } from './list-workspaces.ts';
import { WorkdirEntries } from './workdir-tabs.tsx';

/** 平台修饰键（⌘ / Ctrl）：提示写对，快捷键本身两个都收。 */
const MOD = modKeyLabel();

/** 桌面侧栏的收起开关事件：⌘K 面板派发，侧栏监听。 */
export const TOGGLE_SIDEBAR_EVENT = 'agent-hub:toggle-sidebar';

/** 桌面侧栏收起成图标栏：记在本机，刷新后保持。 */
const COLLAPSED_KEY = 'agent-hub.sidebar.collapsed';
const COLLAPSED_WORKSPACES_KEY = 'agent-hub.sidebar.collapsed-workspaces';

function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function readSet(key: string): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function save(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* 隐私模式写不进去就算了 */
  }
}

/** 行级按钮的统一外观：28px（触屏 44px）高、圆角、悬停抬一档底色。 */
const ROW =
  'flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 text-left text-sub text-secondary hover:bg-hover hover:text-primary lg:min-h-7';
const GHOST_ICON =
  'flex size-[44px] shrink-0 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary lg:size-7';

interface Props {
  readonly project: ProjectDto;
  readonly shortcutsDisabled?: boolean;
  readonly projects: readonly ProjectDto[];
  readonly selectedId: string | null;
  readonly canvas: CanvasDto | null;
  /** 会话流：行菜单要知道这一轮是不是还在跑（能不能停、能不能分叉）。 */
  readonly live?: LiveMap;
  /** 和画布卡片同一个停止处理。 */
  readonly onInterrupt?: (sessionId: string) => Promise<void>;
  /** 切到画布并把这条会话展开成窗口。 */
  readonly onExpandSession?: (sessionId: string) => void;
  readonly onHome: () => void;
  readonly onSwitchProject: (project: ProjectDto) => void;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onOpenWorkdir: (id: string) => void;
  readonly onSearch: () => void;
  readonly onNewTask: () => void;
  readonly onDerive: (taskId: string) => void;
  /** 新开主会话：和新建任务并排，因为它也是「从这条项目开始干活」。 */
  readonly onNewCoordinator: () => void;
  readonly onClose?: (() => void) | undefined;
}

/**
 * 项目侧栏：桌面常驻（可收起成 56px 图标栏，⌘/Ctrl+B），手机从左侧滑出。
 *
 * 自上而下只有四块：项目切换 → 动作（新建 / 搜索）→ 任务与会话 → 全站导航和账号。视图切换在页头。
 * 分块只靠留白和一条底线，不再每块都画边框；琥珀色只留给「在跑」的状态点。
 */
export function ProjectSidebar({
  project,
  shortcutsDisabled = false,
  projects,
  selectedId,
  canvas,
  live = {},
  onInterrupt,
  onExpandSession,
  onHome,
  onSwitchProject,
  onOpenSession,
  onOpenWorkdir,
  onSearch,
  onNewTask,
  onDerive,
  onNewCoordinator,
  onClose
}: Props) {
  const drawer = onClose !== undefined;
  const [, navigate] = useRoute();
  const [showSettled, setShowSettled] = useState(false);
  const [collapsed, setCollapsed] = useState(() => !drawer && readFlag(COLLAPSED_KEY));
  const workspaceScope = `${COLLAPSED_WORKSPACES_KEY}:${project.id}`;
  const [workspaceState, setWorkspaceState] = useState(() => ({ scope: workspaceScope, keys: readSet(workspaceScope) }));
  const foldedWorkspaces = workspaceState.scope === workspaceScope ? workspaceState.keys : readSet(workspaceScope);
  const tasks = useMemo(() => (canvas?.tasks ?? []).filter((task) => task.archivedAt == null), [canvas?.tasks]);
  // 活跃列表默认不含收起过的：侧栏是「现在要管什么」，不是全量档案。
  const active = useMemo(() => activeSessions(canvas?.sessions ?? []), [canvas?.sessions]);
  const settled = useMemo(() => settledSessions(canvas?.sessions ?? []), [canvas?.sessions]);
  const taskTitle = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);
  /**
   * 没有任务的会话（人开的主会话、bot、群角色）：以前这个桶不渲染，主会话就永远不在侧栏出现。
   * 登记表里有的才是「主会话」，其余照中性的说法——不能把 bot 会话也叫成主会话。
   */
  const { ids: coordinatorIds } = useCoordinators(project.id);
  const workers = useWorkers();
  const workspaceGroups = useMemo(() => canvas ? workspaceSessionGroups({ ...canvas, sessions: active.filter((session) => session.taskId === null || tasks.some((task) => task.id === session.taskId)) }, coordinatorIds) : [], [canvas, active, coordinatorIds, tasks]);
  const emptyTasks = tasks.filter((task) => !(canvas?.sessions ?? []).some((session) => session.taskId === task.id) && task.status !== 'done' && task.status !== 'abandoned');
  const now = Date.now();

  const titleOf = (session: SessionDto): string => {
    const named = session.title?.trim() || canvas?.openings[session.id]?.trim();
    if (named) return named;
    const task = session.taskId === null ? undefined : taskTitle.get(session.taskId);
    // 无任务会话没有任务名可借：主会话就叫主会话，其余宁可给一个短编号，也不要空行
    return task || (coordinatorIds.has(session.id) ? COORDINATOR_TITLE : `会话 ${session.id.slice(-4)}`);
  };

  // 会话行的「⋯」/ 右键菜单：动作、缓存改写和会话页「⋯」同一份（atoms/use-session-actions.ts）。
  const actions = useSessionActions(project.id);
  const [menu, setMenu] = useState<{ readonly sessionId: string; readonly x: number; readonly y: number; readonly trigger: HTMLElement | null } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SessionDto | null>(null);
  const [rowError, setRowError] = useState<{ readonly sessionId: string; readonly text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const allSessions = canvas?.sessions ?? [];

  const itemsFor = (session: SessionDto): readonly SessionActionItem[] => {
    const frame = live[session.id];
    const status = frame?.status ?? session.status;
    const agent = canvas?.agents.find((candidate) => candidate.id === session.agentId);
    return sessionActionItems({
      status,
      settled: session.settledAt != null,
      pinned: session.pinned === true,
      lastSeq: frame?.lastSeq ?? session.lastSeq,
      turnRunning: waitingForReply(frame, status),
      forkDenied: agent?.capabilities.fork.state === 'denied',
      canExpand: onExpandSession !== undefined
    }).map((item) => (busyId === session.id && item.id !== 'expand' ? { ...item, disabled: true } : item));
  };

  const openMenu = (sessionId: string, x: number, y: number, trigger: HTMLElement | null) => {
    returnFocus.current = trigger;
    setRowError(null);
    setMenu({ sessionId, x, y, trigger });
  };

  const closeMenu = (refocus: boolean) => {
    setMenu(null);
    if (refocus) returnFocus.current?.focus();
  };

  const runAction = async (session: SessionDto, action: () => Promise<unknown>) => {
    setBusyId(session.id);
    setRowError(null);
    try {
      await action();
    } catch (failure) {
      setRowError({ sessionId: session.id, text: (failure as Error).message || '操作失败，请再试一次' });
    } finally {
      setBusyId(null);
    }
  };

  const pick = (session: SessionDto, id: SessionActionId) => {
    setMenu(null);
    switch (id) {
      case 'expand':
        onExpandSession?.(session.id);
        return;
      case 'interrupt':
        if (onInterrupt) void runAction(session, () => onInterrupt(session.id));
        return;
      case 'rename':
        setRenamingId(session.id);
        return;
      case 'fork':
        void runAction(session, async () => {
          const created = await actions.fork(session);
          onOpenSession(created.id);
        });
        return;
      case 'settle':
        void runAction(session, () => actions.setSettled(session, session.settledAt == null));
        return;
      case 'pin':
        void runAction(session, () => actions.setPinned(session, session.pinned !== true));
        return;
      case 'delete':
        setDeleting(session);
        return;
    }
  };

  const finishRename = (session: SessionDto, value: string | null) => {
    setRenamingId(null);
    // 焦点回到这一行，键盘用户接着往下走
    requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>(`[data-testid="sidebar-session-row"][data-session-id="${CSS.escape(session.id)}"] [data-nav-row]`)?.focus()
    );
    if (value === null) return;
    void runAction(session, () => actions.rename(session, value));
  };

  const rowProps = (session: SessionDto) => ({
    session,
    title: titleOf(session),
    active: selectedId === session.id,
    now,
    onOpen: onOpenSession,
    menuOpen: menu?.sessionId === session.id,
    renaming: renamingId === session.id,
    busy: busyId === session.id,
    error: rowError?.sessionId === session.id ? rowError.text : null,
    onMenu: (x: number, y: number, trigger: HTMLElement | null) => openMenu(session.id, x, y, trigger),
    onRenamed: (value: string | null) => finishRename(session, value)
  });
  /** 没有任务的两组共用一套行：组名不同，行的动作和别的行完全一样。 */
  const tasklessSection = (key: string, testId: string, title: string, rows: readonly SessionDto[]) =>
    rows.length === 0 ? null : (
      <section key={key} className="mb-1" data-testid={testId} aria-label={title}>
        <p className="flex min-h-10 items-center gap-1.5 rounded-md px-1.5 text-left text-sub text-tertiary lg:min-h-7">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <span className="shrink-0 text-meta">{rows.length}</span>
        </p>
        {rows.map((session) => (
          <SessionRow key={session.id} {...rowProps(session)} />
        ))}
      </section>
    );
  const menuSession = menu ? allSessions.find((session) => session.id === menu.sessionId) : undefined;

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      save(COLLAPSED_KEY, current ? '0' : '1');
      return !current;
    });
  }, []);

  // ⌘/Ctrl+B 收起 / 展开（只有桌面那份侧栏挂这个快捷键；输入框里不拦截）。
  useEffect(() => {
    if (drawer || shortcutsDisabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'b') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      toggleCollapsed();
    };
    // ⌘K 面板里的「收起 / 展开侧栏」走同一个开关
    const onToggle = () => toggleCollapsed();
    window.addEventListener('keydown', onKey);
    window.addEventListener(TOGGLE_SIDEBAR_EVENT, onToggle);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(TOGGLE_SIDEBAR_EVENT, onToggle);
    };
  }, [drawer, shortcutsDisabled, toggleCollapsed]);

  const toggleWorkspace = (key: string) => setWorkspaceState((current) => {
    const next = new Set(current.scope === workspaceScope ? current.keys : readSet(workspaceScope));
    if (next.has(key)) next.delete(key); else next.add(key);
    save(workspaceScope, JSON.stringify([...next]));
    return { scope: workspaceScope, keys: next };
  });

  // 列表里 ↑ / ↓ 在会话行之间移动焦点（Home / End 到头尾）。
  const listRef = useRef<HTMLElement>(null);
  const location = useRef<'waiting' | 'expanded' | 'done'>('waiting');
  useEffect(() => {
    if (!drawer || location.current !== 'waiting' || !canvas || !selectedId) return;
    const session = canvas.sessions.find((item) => item.id === selectedId);
    if (!session) return;
    location.current = 'expanded';
    if (session.settledAt != null) setShowSettled(true);
    const workspace = workspaceGroups.find((group) => group.sessions.some((item) => item.id === session.id));
    if (workspace) setWorkspaceState((current) => {
      const keys = current.scope === workspaceScope ? current.keys : readSet(workspaceScope);
      if (!keys.has(workspace.key)) return current;
      const next = new Set(keys);
      next.delete(workspace.key);
      save(workspaceScope, JSON.stringify([...next]));
      return { scope: workspaceScope, keys: next };
    });
  }, [drawer, canvas, selectedId, workspaceGroups, workspaceScope]);
  useEffect(() => {
    if (!drawer || location.current !== 'expanded' || !selectedId) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-testid="sidebar-session-row"][data-session-id="${CSS.escape(selectedId)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    location.current = 'done';
  }, [drawer, canvas, selectedId, foldedWorkspaces, showSettled]);
  const onListKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('[data-sidebar-derive]')) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-nav-row]') ?? [])];
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : event.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
    event.preventDefault();
    rows[next]?.focus();
  };

  if (collapsed) {
    return (
      <aside className="flex h-full min-h-0 w-14 shrink-0 flex-col items-center gap-1 border-r border-hair bg-panel py-2" aria-label="项目导航" data-testid="project-sidebar" data-collapsed="true">
        <button className={GHOST_ICON} aria-label="展开侧栏" title={`展开侧栏（${MOD}B）`} onClick={toggleCollapsed}>
          <Icon name="panel" />
        </button>
        <button
          className="mt-1 flex size-8 items-center justify-center rounded-md bg-selected text-sub text-primary"
          title={project.name}
          aria-label={`当前项目：${project.name}`}
          onClick={toggleCollapsed}
        >
          {project.name.slice(0, 1).toUpperCase()}
        </button>
        <div className="my-1 h-px w-6 bg-hair" />
        <button className={GHOST_ICON} aria-label="新建任务" title="新建任务" onClick={onNewTask}>
          <Icon name="plus" />
        </button>
        <button className={GHOST_ICON} aria-label="新开主会话" title="新开主会话" onClick={onNewCoordinator}>
          <Icon name="message" />
        </button>
        <button className={GHOST_ICON} aria-label="搜索" title={`搜索（${MOD}K）`} onClick={onSearch}>
          <Icon name="search" />
        </button>
        <div className="my-1 h-px w-6 bg-hair" />
        <GlobalNav layout="rail" />
        <div className="mt-auto flex flex-col items-center gap-1">
          <a
            href="#/machines"
            className={GHOST_ICON}
            aria-label="机器"
            title="机器：跑 agent 的机器"
            data-testid="machines-rail"
          >
            <Icon name="server" />
          </a>
          <button className={GHOST_ICON} title="项目设置" aria-label="项目设置" onClick={(event) => openSettings(navigate, { scope: 'project', id: project.id, section: 'general' }, event.currentTarget)}>
            <Icon name="settings" />
          </button>
          <SettingsEntry className={GHOST_ICON} />
          <AccountMenu placement="up" />
        </div>
      </aside>
    );
  }

  const projectActions = (
    <div className={`space-y-0.5 px-2 pb-2 ${drawer ? 'border-t border-hair pt-2' : ''}`}>
      <button className={ROW} onClick={onNewTask}><Icon name="plus" className="text-tertiary" />新建任务</button>
      <button className={ROW} data-testid="sidebar-new-coordinator" onClick={onNewCoordinator}><Icon name="message" className="text-tertiary" />新开主会话</button>
      <button className={ROW} onClick={onSearch} title="搜索任务与会话">
        <Icon name="search" className="text-tertiary" /><span className="flex-1">搜索</span>
        {coarsePointer() ? null : <kbd className="font-sans text-meta text-tertiary">{MOD}K</kbd>}
      </button>
    </div>
  );

  return (
    <aside className={`flex min-h-0 shrink-0 flex-col border-r border-hair bg-panel ${drawer ? 'h-[calc(75dvh_-_28px)] w-full' : 'h-full w-64'}`} aria-label="项目导航" data-testid="project-sidebar">
      {/* 项目切换：原生下拉保留（键盘 / 读屏 / 手机滚轮都现成），只是画成一行带首字母和箭头的按钮。 */}
      <div className="flex items-center gap-1 px-2 pb-1 pt-2">
        <label className="relative flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover">
          <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-md bg-selected text-meta text-primary">
            {project.name.slice(0, 1).toUpperCase()}
          </span>
          <select
            className="min-h-9 min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent pr-5 text-body font-medium text-primary outline-none lg:min-h-0"
            value={project.id}
            aria-label="切换项目"
            onChange={(event) => {
              const picked = projects.find((candidate) => candidate.id === event.target.value);
              if (picked) onSwitchProject(picked);
            }}
          >
            {(projects.length > 0 ? projects : [project]).map((candidate) => (
              <option key={candidate.id} value={candidate.id} className="bg-panel text-body">
                {candidate.name}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" size={14} className="pointer-events-none absolute right-1.5 text-tertiary" />
        </label>
        <button className={GHOST_ICON} title="项目设置" aria-label="项目设置" onClick={(event) => openSettings(navigate, { scope: 'project', id: project.id, section: 'general' }, event.currentTarget)}>
          <Icon name="settings" />
        </button>
        {drawer ? (
          <button className={GHOST_ICON} aria-label="关闭侧栏" onClick={onClose}>
            <Icon name="x" />
          </button>
        ) : (
          <button className={GHOST_ICON} aria-label="收起侧栏" title={`收起侧栏（${MOD}）`} onClick={toggleCollapsed}>
            <Icon name="panel" />
          </button>
        )}
      </div>

      <div className={drawer ? 'flex min-h-0 flex-1 flex-col overflow-y-auto' : 'contents'}>
      {!drawer ? projectActions : null}

      <nav ref={listRef} onKeyDown={onListKey} className={drawer ? 'shrink-0 border-t border-hair px-2 py-0.5' : 'min-h-0 flex-1 overflow-y-auto border-t border-hair px-2 py-2'} aria-label="任务与会话">
        <WorkdirEntries projectId={project.id} onOpen={onOpenWorkdir} compact />
        <p className="sr-only px-2 pb-1 text-meta text-tertiary lg:not-sr-only">工作空间</p>
        {workspaceGroups.map((workspace) => {
          const expanded = !foldedWorkspaces.has(workspace.key);
          const worker = resolveWorker(workers.list, workspace.workerId);
          return (
            <section key={workspace.key} data-testid="sidebar-workspace-group" data-workspace-key={workspace.key} className="mb-1 lg:mb-2">
              <button type="button" data-nav-row data-testid="sidebar-workspace-toggle" aria-expanded={expanded} onClick={() => toggleWorkspace(workspace.key)} className="flex min-h-[44px] w-full items-start gap-1.5 rounded-md px-1.5 py-1.5 text-left hover:bg-hover lg:min-h-7">
                <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} className="mt-1 shrink-0 text-tertiary" />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sub text-primary">{workspace.title}</span>
                  <span className="flex min-w-0 gap-1 text-meta text-tertiary" title={[workspaceWorkerLabel(workspace.workerId, worker?.label), workspace.detail].filter(Boolean).join(' · ')}>
                    <span className={workspace.detail ? 'shrink-0 lg:max-w-[40%] lg:truncate' : 'shrink-0'}>{workspaceWorkerLabel(workspace.workerId, worker?.label)}{worker && worker.state !== 'online' ? ' · 离线' : ''}</span>
                    {workspace.detail ? <span dir="rtl" className="min-w-0 truncate text-left">{workspace.detail}</span> : null}
                  </span>
                </span>
                <span className="shrink-0 text-meta text-tertiary">{workspace.sessions.length}</span>
              </button>
              {expanded ? <div className="ml-2 border-l border-hair pl-1">
                {workspace.groups.map((group) => {
                  const rows = group.sessions.map(({ session }) => session);
                  if (group.taskless) return tasklessSection(group.taskId, group.kind === 'coordinator' ? 'sidebar-coordinators' : 'sidebar-unassigned', group.title, rows);
                  const task = tasks.find((candidate) => candidate.id === group.taskId);
                  if (!task) return null;
                  return (
                    <section key={task.id} className="mb-1">
                      <div className="flex min-w-0 items-center">
                        <h3 className="min-w-0 flex-1 truncate px-1.5 text-sub text-tertiary" title={task.title}>{task.title}</h3>
                        <button
                          type="button"
                          className={`${GHOST_ICON} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]`}
                          data-sidebar-derive
                          data-testid="sidebar-task-derive"
                          aria-label={`为${task.title}开始会话`}
                          title="开始会话"
                          onClick={() => onDerive(task.id)}
                        >
                          <Icon name="plus" size={14} />
                        </button>
                      </div>
                      {rows.map((session) => <SessionRow key={session.id} {...rowProps(session)} />)}
                    </section>
                  );
                })}
                </div>
              : null}
            </section>
          );
        })}
        {emptyTasks.length > 0 ? <section className="mt-1 lg:mt-2" aria-label="未开始的任务" data-testid="sidebar-empty-tasks">
          <p className="px-2 py-1 text-meta text-tertiary">未开始</p>
          {emptyTasks.map((task) => <div key={task.id} className="flex min-w-0 items-center">
            <span className="min-w-0 flex-1 truncate px-2 text-sub text-tertiary" title={task.title}>{task.title}</span>
            <button type="button" className={GHOST_ICON} data-sidebar-derive data-testid="sidebar-task-derive" aria-label={`为${task.title}开始会话`} title="开始会话" onClick={() => onDerive(task.id)}><Icon name="plus" size={14} /></button>
          </div>)}
        </section> : null}
        <div className="mt-1 lg:mt-2" data-testid="sidebar-settled">
          <button
            data-testid="sidebar-settled-toggle"
            data-nav-row
            aria-expanded={settled.length > 0 ? showSettled : undefined}
            disabled={settled.length === 0}
            className="flex min-h-10 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-meta text-tertiary hover:bg-hover hover:text-secondary disabled:opacity-60 disabled:hover:bg-transparent lg:min-h-7"
            onClick={() => setShowSettled((open) => !open)}
          >
            <Icon name={showSettled ? 'chevron-down' : 'chevron-right'} size={13} className={settled.length > 0 ? '' : 'opacity-0'} />
            <span>已收起 {settled.length}</span>
          </button>
          {showSettled && settled.length > 0 ? (
            <div data-testid="sidebar-settled-list">
              {settled.map((session) => (
                <SessionRow key={session.id} {...rowProps(session)} muted />
              ))}
            </div>
          ) : null}
        </div>
      </nav>
      {drawer ? projectActions : null}

      {drawer ? (
        // 移动抽屉：全局工具跟在任务列表和项目动作之后，共用滚动区。
        <div className="shrink-0 border-t border-hair px-2 py-2" data-testid="drawer-global-nav">
          <GlobalNav columns={5} onNavigate={onClose} />
        </div>
      ) : (
        <div className="border-t border-hair px-2 py-2">
          <GlobalNav />
        </div>
      )}

      <div className={`flex items-center gap-0.5 border-t border-hair px-2 py-1.5 ${drawer ? 'shrink-0' : ''}`}>
        <div className="min-w-0 flex-1">
          <MachinesBadge />
        </div>
        <AttentionBadge onClick={onHome} compact />
        <MessagesEntry />
        <NotificationBell placement="up" />
        <SettingsEntry className={GHOST_ICON} />
        <AccountMenu placement="up" />
      </div>
      </div>
      {menu && menuSession ? (
        <SessionRowMenu
          items={itemsFor(menuSession)}
          anchor={{ x: menu.x, y: menu.y }}
          onPick={(id) => pick(menuSession, id)}
          onClose={closeMenu}
        />
      ) : null}
      {deleting ? (
        <DeleteSessionDialog
          session={deleting}
          opening={canvas?.openings[deleting.id]}
          onClose={() => {
            setDeleting(null);
            returnFocus.current?.focus();
          }}
          onDeleted={() => {
            const id = deleting.id;
            setDeleting(null);
            actions.forget(id);
            // 正看着的那条被删了：回到项目首页视图，别停在一条不存在的会话上
            if (selectedId === id) onHome();
          }}
        />
      ) : null}
    </aside>
  );
}

/**
 * 侧栏里的一行会话：状态点在最左（同款小圆点，颜色只说「忙 / 出事 / 歇着」），右边是多久没动。
 * 短号不再常驻（放进悬停提示），收起过的那份用更淡的字。
 *
 * 行尾的「⋯」：桌面上悬停 / 键盘聚焦时才出现（顶替时间），触屏常驻；右键（含菜单键）也打开同一份菜单。
 */
function SessionRow({
  session,
  title,
  active,
  muted = false,
  now,
  onOpen,
  menuOpen,
  renaming,
  busy,
  error,
  onMenu,
  onRenamed
}: {
  readonly session: SessionDto;
  readonly title: string;
  readonly active: boolean;
  readonly muted?: boolean;
  readonly now: number;
  readonly onOpen: (sessionId: string) => void;
  readonly menuOpen: boolean;
  readonly renaming: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onMenu: (x: number, y: number, trigger: HTMLElement | null) => void;
  /** null = 取消改名。 */
  readonly onRenamed: (value: string | null) => void;
}) {
  const phase = sessionPhase(session);
  const tone = phaseTone(phase);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState(session.title ?? '');
  const done = useRef(false);
  useEffect(() => {
    if (!renaming) return;
    setDraft(session.title ?? '');
    done.current = false;
  }, [renaming, session.title]);
  const dot = <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${PHASE_DOT[tone]} ${tone === 'busy' ? 'animate-pulse' : ''}`} />;

  if (renaming) {
    const finish = (value: string | null) => {
      if (done.current) return;
      done.current = true;
      onRenamed(value);
    };
    return (
      <div data-testid="sidebar-session-row" data-session-id={session.id} className="flex min-h-[44px] items-center gap-2 rounded-md bg-selected py-1 pl-6 pr-1 lg:min-h-7">
        {dot}
        <input
          autoFocus
          value={draft}
          maxLength={80}
          placeholder={title}
          aria-label="会话名"
          data-testid="sidebar-rename-input"
          className="h-8 min-w-0 flex-1 rounded-sm border border-hair bg-card px-1.5 text-sub text-primary outline-none focus:border-ring lg:h-6"
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => finish(draft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              finish(draft);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              finish(null);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div data-testid="sidebar-session-row" data-session-id={session.id} className="group">
      <div className="relative">
        <button
          data-testid="sidebar-session"
          data-nav-row
          data-phase={phase}
          data-settled={muted ? 'true' : undefined}
          aria-busy={busy || undefined}
          className={`flex min-h-[44px] w-full items-center gap-2 rounded-md py-1 pl-6 pr-[52px] text-left text-sub pointer-fine:pr-2 lg:min-h-7 ${
            active
              ? 'bg-selected text-primary'
              : muted
                ? 'text-tertiary hover:bg-hover hover:text-secondary'
                : 'text-secondary hover:bg-hover hover:text-primary'
          } ${menuOpen ? 'bg-hover' : ''}`}
          aria-current={active ? 'page' : undefined}
          title={`${title} · #${session.id.slice(-4)} · ${session.agentId} · ${phaseLabel(phase)}`}
          onClick={() => onOpen(session.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            // 菜单键 / Shift+F10 没有坐标：贴着这一行的左下角出
            const box = event.currentTarget.getBoundingClientRect();
            const keyboard = !(event.clientX > 0 || event.clientY > 0);
            onMenu(keyboard ? box.left + 24 : event.clientX, keyboard ? box.bottom : event.clientY, event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.key === 'F10' && event.shiftKey) {
              event.preventDefault();
              const box = event.currentTarget.getBoundingClientRect();
              onMenu(box.left + 24, box.bottom, event.currentTarget);
            }
          }}
        >
          {dot}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <span
            className={`shrink-0 text-meta text-tertiary ${
              menuOpen ? 'pointer-fine:invisible' : 'pointer-fine:group-focus-within:invisible pointer-fine:group-hover:invisible'
            }`}
          >
            {elapsedLabel(session.updatedAt, now)}
          </span>
        </button>
        <button
          ref={moreRef}
          data-testid="sidebar-session-more"
          aria-label="会话操作"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="会话操作"
          className={`absolute right-0 top-1/2 flex size-[44px] -translate-y-1/2 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary focus-visible:opacity-100 pointer-fine:size-6 ${
            menuOpen ? 'opacity-100' : 'pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100'
          }`}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            onMenu(box.left, box.bottom + 2, event.currentTarget);
          }}
        >
          <Icon name="more" size={14} />
        </button>
      </div>
      {error ? (
        <p role="alert" data-testid="sidebar-session-error" className="pb-1 pl-6 pr-2 text-meta text-rust">
          {error}
        </p>
      ) : null}
    </div>
  );
}
