import { useMemo, useState } from 'react';
import type { CanvasDto, ProjectDto, SessionDto } from './api.ts';
import { AccountMenu } from './auth.tsx';
import { AttentionBadge } from './attention.tsx';
import { MessagesEntry } from './messages-entry.tsx';
import { NotificationBell } from './market/notifications.tsx';
import { WorkspacesDialog } from './workspaces-dialog.tsx';
import { WorkersBadge } from './workers.tsx';
import type { View } from './route.ts';

const VIEWS: readonly { view: View; label: string; icon: string }[] = [
  { view: 'canvas', label: '画布', icon: '▦' },
  { view: 'list', label: '列表', icon: '☷' },
  { view: 'focus', label: '对话', icon: '◫' }
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
  const tasks = canvas?.tasks ?? [];
  const sessions = useMemo(() => {
    const grouped = new Map<string, SessionDto[]>();
    for (const session of canvas?.sessions ?? []) {
      const list = grouped.get(session.taskId) ?? [];
      list.push(session);
      grouped.set(session.taskId, list);
    }
    return grouped;
  }, [canvas?.sessions]);
  const taskTitle = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);

  return (
    <aside
      className="flex h-full w-64 shrink-0 flex-col border-r border-hair bg-panel"
      aria-label="项目导航"
      data-testid="project-sidebar"
    >
      <div className="flex items-center gap-1.5 border-b border-hair px-2 py-2">
        <button
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-hair text-meta text-secondary hover:border-accent hover:text-accent"
          title="回到首页"
          aria-label="回到首页"
          onClick={onHome}
        >
          ⌂
        </button>
        <select
          className="min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent text-body text-primary outline-none"
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
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-sub text-tertiary hover:text-primary"
            aria-label="关闭侧栏"
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-3 gap-1 border-b border-hair p-2" role="group" aria-label="视图">
        {VIEWS.map((item) => (
          <button
            key={item.view}
            className={`flex h-8 items-center justify-center gap-1 rounded-sm border text-meta ${
              view === item.view
                ? 'border-accent/50 bg-card-raised text-primary'
                : 'border-transparent text-tertiary hover:border-hair hover:text-secondary'
            }`}
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
          className="rounded-sm border border-hair px-2 py-1.5 text-meta text-secondary hover:border-accent hover:text-accent"
          onClick={onSearch}
          title="搜索任务与会话（⌘K）"
        >
          搜索 ⌘K
        </button>
        <button
          className="rounded-sm border border-hair px-2 py-1.5 text-meta text-secondary hover:border-accent hover:text-accent"
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
                </p>
                {rows.length === 0 ? (
                  <p className="px-2 py-1 text-meta text-tertiary/70">还没有会话</p>
                ) : (
                  rows.map((session) => {
                    const active = selectedId === session.id;
                    const title = session.title?.trim() || canvas?.openings[session.id]?.trim() || taskTitle.get(session.taskId) || session.id.slice(-8);
                    return (
                      <button
                        key={session.id}
                        data-testid="sidebar-session"
                        className={`mb-0.5 flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-meta ${
                          active ? 'bg-card-raised text-primary' : 'text-secondary hover:bg-card hover:text-primary'
                        }`}
                        title={`${title} · ${session.agentId} · ${session.status}`}
                        onClick={() => onOpenSession(session.id)}
                      >
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${
                            session.status === 'running'
                              ? 'bg-accent'
                              : session.status === 'failed'
                                ? 'bg-rust'
                                : 'bg-tertiary/60'
                          }`}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate">{title}</span>
                        <span className="shrink-0 font-mono text-tertiary">#{session.id.slice(-4)}</span>
                      </button>
                    );
                  })
                )}
              </section>
            );
          })
        )}
      </nav>

      <div className="space-y-2 border-t border-hair p-2">
        <div className="flex items-center justify-between gap-1">
          <WorkersBadge placement="up" />
          <button
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-hair text-meta text-tertiary hover:border-accent hover:text-accent"
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
