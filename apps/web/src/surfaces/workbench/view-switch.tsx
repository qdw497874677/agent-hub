import type { ProjectDto } from '../../shell/api.ts';
import type { StreamState } from '../../atoms/live.ts';
import type { View } from '../../shell/route.ts';
import { Icon, type IconName } from '../../atoms/icons.tsx';

export const VIEWS: readonly { view: View; label: string; icon: IconName }[] = [
  { view: 'canvas', label: '画布', icon: 'grid' },
  { view: 'list', label: '列表', icon: 'list' }
];

/**
 * 项目内的视图切换（画布 / 列表）：页头里的分段控件。
 * 会话是列表 / 画布打开后的详情，不是并列的第三块；打开方式始终是选一条会话。
 * 窄屏只留图标（名字在 aria-label / title 里），宽屏图标 + 名字。
 */
export function ViewSwitch({
  view,
  onView,
  iconOnly = false
}: {
  view: View;
  onView: (view: View) => void;
  iconOnly?: boolean;
}) {
  return (
    <div role="group" aria-label="视图" data-testid="view-switch" className="flex shrink-0 gap-0.5 rounded-control border border-hair bg-canvas p-0.5">
      {VIEWS.map((item) => {
        const on = view === item.view;
        return (
          <button
            key={item.view}
            type="button"
            aria-label={iconOnly ? item.label : undefined}
            title={item.label}
            aria-pressed={on}
            onClick={() => onView(item.view)}
            className={`flex items-center justify-center gap-1.5 rounded-[4px] text-sub transition-colors duration-[var(--dur-fast)] ${
              iconOnly ? 'size-9' : 'h-7 px-2.5'
            } ${on ? 'bg-selected text-primary' : 'text-tertiary hover:text-primary'}`}
          >
            <Icon name={item.icon} size={14} />
            {iconOnly ? null : item.label}
          </button>
        );
      })}
    </div>
  );
}

/** 桌面项目页头：项目名在左，视图切换在右；只此一处，侧栏不再放视图。 */
export function ProjectBar({
  project,
  view,
  stream,
  onView
}: {
  project: ProjectDto;
  view: View;
  stream: StreamState;
  onView: (view: View) => void;
}) {
  return (
    <div data-testid="project-bar" className="hidden h-11 shrink-0 items-center gap-3 border-b border-hair px-4 lg:flex">
      <p className="min-w-0 truncate text-sub text-tertiary">
        <span className="text-secondary">{project.name}</span>
      </p>
      {stream === 'reconnecting' ? (
        <span role="status" className="flex items-center gap-1 text-meta text-warning">
          <Icon name="warning" size={12} />
          重连中
        </span>
      ) : null}
      <div className="ml-auto">
        <ViewSwitch view={view} onView={onView} />
      </div>
    </div>
  );
}
