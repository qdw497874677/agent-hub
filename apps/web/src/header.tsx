import { MessagesEntry } from './messages-entry.tsx';
import { useState } from 'react';
import { WorkspacesDialog } from './workspaces-dialog.tsx';
import { AccountMenu } from './auth.tsx';
import { NotificationBell } from './market/notifications.tsx';
import type { ProjectDto } from './api.ts';
import type { StreamState } from './live.ts';
import type { View } from './route.ts';
import { WorkersBadge } from './workers.tsx';

const VIEW_LABEL: Record<View, string> = { canvas: '画布', list: '列表', focus: '对话' };

interface Props {
  readonly project: ProjectDto;
  readonly projects: readonly ProjectDto[];
  readonly view: View;
  readonly canFocus: boolean;
  readonly stream: StreamState;
  onHome(): void;
  onSwitchProject(project: ProjectDto): void;
  onView(view: View): void;
  onSearch(): void;
  onNewTask(): void;
}

/** 项目页顶栏。窄屏下收起路径与文字标签，只留图标，44px 高、点击区不小于 28px。 */
export function ProjectHeader(props: Props) {
  const [settings, setSettings] = useState(false);
  const { project, projects, view } = props;
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-hair px-2 pt-[env(safe-area-inset-top)] md:px-3">
      <div className="flex min-w-0 items-baseline gap-2 md:gap-3">
        <button
          className="rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-strong md:px-1.5 md:py-0.5"
          title="回到首页"
          aria-label="回到首页"
          onClick={props.onHome}
        >
          ⌂
        </button>
        <select
          className="min-w-0 max-w-[40vw] cursor-pointer appearance-none truncate bg-transparent text-head text-primary outline-none md:max-w-none"
          value={project.id}
          onChange={(event) => {
            const picked = projects.find((candidate) => candidate.id === event.target.value);
            if (picked) props.onSwitchProject(picked);
          }}
          title="切换项目"
        >
          {(projects.length > 0 ? projects : [project]).map((candidate) => (
            <option key={candidate.id} value={candidate.id} className="bg-panel text-body">
              {candidate.name}
            </option>
          ))}
        </select>
        {props.stream === 'reconnecting' ? (
          <span className="shrink-0 text-meta text-rust" role="status">
            ● 重连中
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 md:gap-2">
        <div className="flex overflow-hidden rounded-sm border border-hair">
          {(['canvas', 'list', 'focus'] as const).map((mode) => (
            <button
              key={mode}
              className={`px-2 py-1 text-meta md:px-2.5 ${view === mode ? 'bg-card text-primary' : 'text-tertiary hover:text-secondary'}`}
              // 没有选中会话时「对话」不知道要显示谁，所以不给点。
              disabled={mode === 'focus' && !props.canFocus}
              title={mode === 'focus' && !props.canFocus ? '先打开一条会话' : undefined}
              onClick={() => props.onView(mode)}
            >
              {VIEW_LABEL[mode]}
            </button>
          ))}
        </div>
        <span className="hidden md:inline">
          <WorkersBadge />
        </span>
        <button
          className="rounded-sm border border-hair px-2 py-1 text-meta text-tertiary hover:border-accent hover:text-accent md:px-2.5"
          onClick={props.onSearch}
          title="搜索任务与会话（⌘K）"
          aria-label="搜索"
        >
          <span className="md:hidden">⌕</span>
          <span className="hidden md:inline">搜索 ⌘K</span>
        </button>
        <button
          className="rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-accent hover:text-accent md:px-2.5"
          onClick={props.onNewTask}
          aria-label="新建任务"
        >
          <span className="md:hidden">＋</span>
          <span className="hidden md:inline">新建任务</span>
        </button>
        <button
          className="rounded-sm border border-hair px-2 py-1 text-meta text-tertiary hover:border-accent hover:text-accent md:px-2.5"
          onClick={() => setSettings(true)}
          title="项目设置"
          aria-label="项目设置"
        >
          ⚙
        </button>
        {settings ? <WorkspacesDialog project={project} onClose={() => setSettings(false)} /> : null}
        <MessagesEntry />
        <NotificationBell />
        <AccountMenu />
      </div>
    </header>
  );
}
