import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { CanvasDto, ProjectDto, SessionDto } from '../../shell/api.ts';
import { AccountMenu } from '../../shell/auth.tsx';
import { AttentionBadge } from '../../atoms/attention.tsx';
import { GlobalNav } from '../../shell/global-nav.tsx';
import { Icon } from '../../atoms/icons.tsx';
import { MessagesEntry } from '../../atoms/messages-entry.tsx';
import { NotificationBell } from '../../shell/market/notifications.tsx';
import { WorkspacesDialog } from './workspaces-dialog.tsx';
import { WorkersBadge } from '../../shell/workers.tsx';
import { coarsePointer } from '../../shell/device.ts';
import { PHASE_DOT, activeSessions, elapsedLabel, phaseLabel, phaseTone, sessionPhase, settledSessions } from './session-status.ts';

/** 桌面侧栏收起成图标栏：记在本机，刷新后保持。 */
const COLLAPSED_KEY = 'agent-hub.sidebar.collapsed';
const COLLAPSED_TASKS_KEY = 'agent-hub.sidebar.collapsed-tasks';

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
  'flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sub text-secondary hover:bg-hover hover:text-primary lg:min-h-7';
const GHOST_ICON =
  'flex size-10 shrink-0 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary lg:size-7';

interface Props {
  readonly project: ProjectDto;
  readonly projects: readonly ProjectDto[];
  readonly selectedId: string | null;
  readonly canvas: CanvasDto | null;
  readonly onHome: () => void;
  readonly onSwitchProject: (project: ProjectDto) => void;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onSearch: () => void;
  readonly onNewTask: () => void;
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
  projects,
  selectedId,
  canvas,
  onHome,
  onSwitchProject,
  onOpenSession,
  onSearch,
  onNewTask,
  onClose
}: Props) {
  const drawer = onClose !== undefined;
  const [settings, setSettings] = useState(false);
  const [showSettled, setShowSettled] = useState(false);
  const [collapsed, setCollapsed] = useState(() => !drawer && readFlag(COLLAPSED_KEY));
  const [foldedTasks, setFoldedTasks] = useState<Set<string>>(() => readSet(COLLAPSED_TASKS_KEY));
  const tasks = canvas?.tasks ?? [];
  // 活跃列表默认不含收起过的：侧栏是「现在要管什么」，不是全量档案。
  const active = useMemo(() => activeSessions(canvas?.sessions ?? []), [canvas?.sessions]);
  const settled = useMemo(() => settledSessions(canvas?.sessions ?? []), [canvas?.sessions]);
  const sessions = useMemo(() => {
    const grouped = new Map<string, SessionDto[]>();
    for (const session of active) {
      const key = session.taskId ?? 'container';
      const list = grouped.get(key) ?? [];
      list.push(session);
      grouped.set(key, list);
    }
    return grouped;
  }, [active]);
  const taskTitle = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);
  const now = Date.now();

  const titleOf = (session: SessionDto): string =>
    session.title?.trim() || canvas?.openings[session.id]?.trim() || (session.taskId === null ? '' : taskTitle.get(session.taskId)) || session.id.slice(-8);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      save(COLLAPSED_KEY, current ? '0' : '1');
      return !current;
    });
  }, []);

  // ⌘/Ctrl+B 收起 / 展开（只有桌面那份侧栏挂这个快捷键；输入框里不拦截）。
  useEffect(() => {
    if (drawer) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'b') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      toggleCollapsed();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer, toggleCollapsed]);

  const toggleTask = (taskId: string) =>
    setFoldedTasks((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      save(COLLAPSED_TASKS_KEY, JSON.stringify([...next]));
      return next;
    });

  // 列表里 ↑ / ↓ 在会话行之间移动焦点（Home / End 到头尾）。
  const listRef = useRef<HTMLElement>(null);
  const onListKey = (event: ReactKeyboardEvent<HTMLElement>) => {
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
      <aside className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-hair bg-panel py-2" aria-label="项目导航" data-testid="project-sidebar" data-collapsed="true">
        <button className={GHOST_ICON} aria-label="展开侧栏" title="展开侧栏（⌘B）" onClick={toggleCollapsed}>
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
        <button className={GHOST_ICON} aria-label="搜索" title="搜索（⌘K）" onClick={onSearch}>
          <Icon name="search" />
        </button>
        <div className="my-1 h-px w-6 bg-hair" />
        <GlobalNav layout="rail" />
        <div className="mt-auto flex flex-col items-center gap-1">
          <button className={GHOST_ICON} title="项目设置" aria-label="项目设置" onClick={() => setSettings(true)}>
            <Icon name="settings" />
          </button>
          <AccountMenu placement="up" />
        </div>
        {settings ? <WorkspacesDialog project={project} onClose={() => setSettings(false)} /> : null}
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-hair bg-panel" aria-label="项目导航" data-testid="project-sidebar">
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
        <button className={GHOST_ICON} title="项目设置" aria-label="项目设置" onClick={() => setSettings(true)}>
          <Icon name="settings" />
        </button>
        {drawer ? (
          <button className={GHOST_ICON} aria-label="关闭侧栏" onClick={onClose}>
            <Icon name="x" />
          </button>
        ) : (
          <button className={GHOST_ICON} aria-label="收起侧栏" title="收起侧栏（⌘B）" onClick={toggleCollapsed}>
            <Icon name="panel" />
          </button>
        )}
      </div>

      <div className="space-y-0.5 px-2 pb-2">
        <button className={ROW} onClick={onNewTask}>
          <Icon name="plus" className="text-tertiary" />
          新建任务
        </button>
        <button className={ROW} onClick={onSearch} title="搜索任务与会话">
          <Icon name="search" className="text-tertiary" />
          <span className="flex-1">搜索</span>
          {coarsePointer() ? null : <kbd className="font-sans text-meta text-tertiary">⌘K</kbd>}
        </button>
      </div>

      <nav ref={listRef} onKeyDown={onListKey} className="min-h-0 flex-1 overflow-y-auto border-t border-hair px-2 py-2" aria-label="任务与会话">
        <p className="px-2 pb-1 text-meta text-tertiary">任务</p>
        {tasks.length === 0 ? (
          <p className="px-2 py-1 text-meta text-tertiary">还没有任务</p>
        ) : (
          tasks.map((task) => {
            const rows = sessions.get(task.id) ?? [];
            const folded = foldedTasks.has(task.id);
            const busy = rows.some((session) => sessionPhase(session) === 'working');
            return (
              <section key={task.id} className="mb-1">
                <button
                  data-nav-row
                  className="group flex min-h-10 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-sub text-tertiary hover:bg-hover hover:text-secondary lg:min-h-7"
                  aria-expanded={rows.length > 0 ? !folded : undefined}
                  title={task.title}
                  onClick={() => rows.length > 0 && toggleTask(task.id)}
                >
                  <Icon name={folded ? 'chevron-right' : 'chevron-down'} size={13} className={rows.length > 0 ? '' : 'opacity-0'} />
                  <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  {folded && rows.length > 0 ? (
                    <span className="flex shrink-0 items-center gap-1 text-meta">
                      {busy ? <span aria-hidden className={`size-1.5 rounded-full ${PHASE_DOT.busy}`} /> : null}
                      {rows.length}
                    </span>
                  ) : null}
                </button>
                {folded
                  ? null
                  : rows.map((session) => (
                      <SessionRow key={session.id} session={session} title={titleOf(session)} active={selectedId === session.id} now={now} onOpen={onOpenSession} />
                    ))}
              </section>
            );
          })
        )}
        <div className="mt-2" data-testid="sidebar-settled">
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
                <SessionRow key={session.id} session={session} title={titleOf(session)} active={selectedId === session.id} muted now={now} onOpen={onOpenSession} />
              ))}
            </div>
          ) : null}
        </div>
      </nav>

      <div className="border-t border-hair px-2 py-2">
        <GlobalNav />
      </div>

      <div className="flex items-center gap-0.5 border-t border-hair px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <WorkersBadge placement="up" />
        </div>
        <AttentionBadge onClick={onHome} compact />
        <MessagesEntry />
        <NotificationBell placement="up" />
        <AccountMenu placement="up" />
      </div>
      {settings ? <WorkspacesDialog project={project} onClose={() => setSettings(false)} /> : null}
    </aside>
  );
}

/**
 * 侧栏里的一行会话：状态点在最左（同款小圆点，颜色只说「忙 / 出事 / 歇着」），右边是多久没动。
 * 短号不再常驻（放进悬停提示），收起过的那份用更淡的字。
 */
function SessionRow({
  session,
  title,
  active,
  muted = false,
  now,
  onOpen
}: {
  readonly session: SessionDto;
  readonly title: string;
  readonly active: boolean;
  readonly muted?: boolean;
  readonly now: number;
  readonly onOpen: (sessionId: string) => void;
}) {
  const phase = sessionPhase(session);
  const tone = phaseTone(phase);
  return (
    <button
      data-testid="sidebar-session"
      data-nav-row
      data-phase={phase}
      data-settled={muted ? 'true' : undefined}
      className={`group flex min-h-11 w-full items-center gap-2 rounded-md py-1 pl-6 pr-2 text-left text-sub lg:min-h-7 ${
        active
          ? 'bg-selected text-primary'
          : muted
            ? 'text-tertiary hover:bg-hover hover:text-secondary'
            : 'text-secondary hover:bg-hover hover:text-primary'
      }`}
      aria-current={active ? 'page' : undefined}
      title={`${title} · #${session.id.slice(-4)} · ${session.agentId} · ${phaseLabel(phase)}`}
      onClick={() => onOpen(session.id)}
    >
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${PHASE_DOT[tone]} ${tone === 'busy' ? 'animate-pulse' : ''}`} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="shrink-0 text-meta text-tertiary">{elapsedLabel(session.updatedAt, now)}</span>
    </button>
  );
}
