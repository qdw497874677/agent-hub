import { useMemo, useState } from 'react';
import type { CanvasDto, ProjectDto, SessionDto } from '../../shell/api.ts';
import { AccountMenu } from '../../shell/auth.tsx';
import { AttentionBadge } from '../../atoms/attention.tsx';
import { GlobalNav } from '../../shell/global-nav.tsx';
import { MessagesEntry } from '../../atoms/messages-entry.tsx';
import { NotificationBell } from '../../shell/market/notifications.tsx';
import { WorkspacesDialog } from './workspaces-dialog.tsx';
import { WorkersBadge } from '../../shell/workers.tsx';
import type { View } from '../../shell/route.ts';
import { PHASE_DOT, activeSessions, phaseLabel, phaseTone, sessionPhase, settledSessions } from './session-status.ts';

const VIEWS: readonly { view: View; label: string; icon: string }[] = [
  { view: 'canvas', label: '画布', icon: '▦' },
  { view: 'list', label: '列表', icon: '☷' },
  { view: 'focus', label: '会话', icon: '◫' }
];

interface Props {
  readonly project: ProjectDto;
  readonly projects: readonly ProjectDto[];
  readonly view: View;
  readonly canFocus: boolean;
  readonly selectedId: string | null;
  readonly canvas: CanvasDto | null;
  readonly onHome: () => void;
  readonly onSwitchProject: (project: ProjectDto) => void;
  readonly onView: (view: View) => void;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onSearch: () => void;
  readonly onNewTask: () => void;
  readonly onClose?: (() => void) | undefined;
}

/**
 * 项目侧栏：桌面常驻，手机从左侧滑出。
 * 导航和会话选择只在这里出现一次，顶栏因此只留当前页面需要的动作。
 */
export function ProjectSidebar({
  project,
  projects,
  view,
  canFocus,
  selectedId,
  canvas,
  onHome,
  onSwitchProject,
  onView,
  onOpenSession,
  onSearch,
  onNewTask,
  onClose
}: Props) {
  const [settings, setSettings] = useState(false);
  const [showSettled, setShowSettled] = useState(false);
  const tasks = canvas?.tasks ?? [];
  // 活跃列表默认不含收起过的：侧栏是「现在要管什么」，不是全量档案。
  const active = useMemo(() => activeSessions(canvas?.sessions ?? []), [canvas?.sessions]);
  const settled = useMemo(() => settledSessions(canvas?.sessions ?? []), [canvas?.sessions]);
  const sessions = useMemo(() => {
    const grouped = new Map<string, SessionDto[]>();
    for (const session of active) {
      const list = grouped.get(session.taskId) ?? [];
      list.push(session);
      grouped.set(session.taskId, list);
    }
    return grouped;
  }, [active]);
  // 任务下一条都没有 / 只是都收起来了，说法不一样。
  const tasksWithSessions = useMemo(() => new Set((canvas?.sessions ?? []).map((session) => session.taskId)), [canvas?.sessions]);
  const taskTitle = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);

  const titleOf = (session: SessionDto): string =>
    session.title?.trim() || canvas?.openings[session.id]?.trim() || taskTitle.get(session.taskId) || session.id.slice(-8);

  return (
    <aside
      className="flex h-full w-64 shrink-0 flex-col border-r border-hair bg-panel"
      aria-label="项目导航"
      data-testid="project-sidebar"
    >
      <div className="flex items-center gap-1.5 border-b border-hair px-2 py-2">
        <button
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-hair text-meta text-secondary hover:border-accent hover:text-accent lg:h-8 lg:w-8"
          title="回到首页"
          aria-label="回到首页"
          onClick={onHome}
        >
          ⌂
        </button>
        <select
          className="min-h-11 min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent text-body text-primary outline-none lg:min-h-0"
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
        {onClose ? (
          <button
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-sub text-tertiary hover:text-primary lg:h-8 lg:w-8"
            aria-label="关闭侧栏"
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
      </div>

      <div className="border-b border-hair">
        <GlobalNav />
      </div>

      <div className="grid grid-cols-3 gap-1 border-b border-hair p-2" role="group" aria-label="视图">
        {VIEWS.map((item) => (
          <button
            key={item.view}
            className={`flex h-11 items-center justify-center gap-1 rounded-sm border text-meta lg:h-8 ${
              view === item.view
                ? 'border-accent/50 bg-card-raised text-primary'
                : 'border-transparent text-tertiary hover:border-hair hover:text-secondary'
            }`}
            aria-pressed={view === item.view}
            disabled={item.view === 'focus' && !canFocus}
            onClick={() => onView(item.view)}
          >
            <span aria-hidden>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-1 border-b border-hair p-2">
        <button
          className="min-h-11 rounded-sm border border-hair px-2 py-1.5 text-meta text-secondary hover:border-accent hover:text-accent lg:min-h-0"
          onClick={onSearch}
          title="搜索任务与会话（⌘K）"
        >
          搜索 ⌘K
        </button>
        <button
          className="min-h-11 rounded-sm border border-hair px-2 py-1.5 text-meta text-secondary hover:border-accent hover:text-accent lg:min-h-0"
          onClick={onNewTask}
        >
          新建任务
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2" aria-label="任务与会话">
        {tasks.length === 0 ? (
          <p className="px-2 py-3 text-meta text-tertiary">还没有任务</p>
        ) : (
          tasks.map((task) => {
            const rows = sessions.get(task.id) ?? [];
            return (
              <section key={task.id} className="mb-2">
                <p className="truncate px-2 py-1 text-meta text-tertiary" title={task.title}>
                  {task.title}
                  {/* 任务下一条活跃会话都没有，但确实有过：让它别看起来像「丢了」。 */}
                  {rows.length === 0 && tasksWithSessions.has(task.id) ? (
                    <span className="text-tertiary/70"> · 都收起来了</span>
                  ) : null}
                </p>
                {rows.length === 0 ? (
                  tasksWithSessions.has(task.id) ? null : (
                    <p className="px-2 py-1 text-meta text-tertiary">还没有会话</p>
                  )
                ) : (
                  rows.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      title={titleOf(session)}
                      active={selectedId === session.id}
                      onOpen={onOpenSession}
                    />
                  ))
                )}
              </section>
            );
          })
        )}
        <div className="mt-1 border-t border-hair pt-1" data-testid="sidebar-settled">
          <button
            data-testid="sidebar-settled-toggle"
            aria-expanded={settled.length > 0 ? showSettled : undefined}
            disabled={settled.length === 0}
            className="flex min-h-11 w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-meta text-tertiary hover:bg-card hover:text-secondary disabled:hover:bg-transparent lg:min-h-0"
            title={settled.length === 0 ? '做完的会话可以收起掉，安安静静留在这里' : undefined}
            onClick={() => setShowSettled((open) => !open)}
          >
            <span aria-hidden className="w-3 shrink-0 text-center">{settled.length > 0 ? (showSettled ? '▾' : '▸') : ''}</span>
            <span>已收起 {settled.length}</span>
          </button>
          {showSettled && settled.length > 0 ? (
            <div className="mt-0.5" data-testid="sidebar-settled-list">
              {settled.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  title={titleOf(session)}
                  active={selectedId === session.id}
                  muted
                  onOpen={onOpenSession}
                />
              ))}
            </div>
          ) : null}
        </div>
      </nav>

      <div className="space-y-2 border-t border-hair p-2">
        <div className="flex items-center justify-between gap-1">
          <WorkersBadge placement="up" />
          <button
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-hair text-meta text-tertiary hover:border-accent hover:text-accent lg:h-8 lg:w-8"
            title="项目设置"
            aria-label="项目设置"
            onClick={() => setSettings(true)}
          >
            ⚙
          </button>
        </div>
        <div className="flex items-center gap-1">
          <AttentionBadge onClick={onHome} compact />
          <MessagesEntry />
          <NotificationBell />
          <AccountMenu />
        </div>
      </div>
      {settings ? <WorkspacesDialog project={project} onClose={() => setSettings(false)} /> : null}
    </aside>
  );
}

/**
 * 侧栏里的一行会话：名字在左，状态点在最右（同款小圆点，颜色只说「忙 / 出事 / 歇着」）。
 * 收起过的那份用更淡的字，展开后也能一眼看出它们已经退场。
 */
function SessionRow({
  session,
  title,
  active,
  muted = false,
  onOpen
}: {
  readonly session: SessionDto;
  readonly title: string;
  readonly active: boolean;
  readonly muted?: boolean;
  readonly onOpen: (sessionId: string) => void;
}) {
  const phase = sessionPhase(session);
  const tone = phaseTone(phase);
  return (
    <button
      data-testid="sidebar-session"
      data-phase={phase}
      data-settled={muted ? 'true' : undefined}
      className={`mb-0.5 flex min-h-11 w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-meta lg:min-h-0 ${
        active
          ? 'bg-card-raised text-primary'
          : muted
            ? 'text-tertiary hover:bg-card hover:text-secondary'
            : 'text-secondary hover:bg-card hover:text-primary'
      }`}
      aria-current={active ? 'page' : undefined}
      title={`${title} · ${session.agentId} · ${phaseLabel(phase)}`}
      onClick={() => onOpen(session.id)}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="shrink-0 font-mono text-tertiary">#{session.id.slice(-4)}</span>
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${PHASE_DOT[tone]}`} />
    </button>
  );
}
