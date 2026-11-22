import type { ProjectDto } from '../../shell/api.ts';
import type { StreamState } from '../../atoms/live.ts';
import type { View } from '../../shell/route.ts';
import { Icon } from '../../atoms/icons.tsx';
import { ViewSwitch } from './view-switch.tsx';

interface Props {
  readonly project: ProjectDto;
  readonly projects: readonly ProjectDto[];
  readonly stream: StreamState;
  readonly view: View;
  onView(view: View): void;
  onMenu(): void;
  onSwitchProject(project: ProjectDto): void;
  onSearch(): void;
  onNewTask(): void;
}

const ICON_BUTTON = 'flex size-10 shrink-0 items-center justify-center rounded-control text-tertiary hover:bg-hover hover:text-primary';

/** 手机端页头：侧栏 · 项目 · 视图切换 · 搜索 · 新建。桌面导航在侧栏，视图切换在 ProjectBar。 */
export function ProjectHeader(props: Props) {
  const { project, projects } = props;
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-hair bg-panel px-1.5">
      <button className={ICON_BUTTON} title="项目导航" aria-label="打开侧栏" onClick={props.onMenu}>
        <Icon name="panel" />
      </button>
      <label className="relative flex min-w-0 flex-1 items-center">
        <select
          className="min-h-10 min-w-0 flex-1 cursor-pointer appearance-none truncate rounded-control bg-transparent pl-1.5 pr-6 text-body font-medium text-primary"
          value={project.id}
          aria-label="切换项目"
          onChange={(event) => {
            const picked = projects.find((candidate) => candidate.id === event.target.value);
            if (picked) props.onSwitchProject(picked);
          }}
        >
          {(projects.length > 0 ? projects : [project]).map((candidate) => (
            <option key={candidate.id} value={candidate.id} className="bg-panel text-body">
              {candidate.name}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" size={14} className="pointer-events-none absolute right-1 text-tertiary" />
      </label>
      {props.stream === 'reconnecting' ? (
        <span className="shrink-0 text-warning" role="status" aria-label="重连中">
          <Icon name="warning" size={14} />
        </span>
      ) : null}
      <ViewSwitch view={props.view} onView={props.onView} iconOnly />
      <button className={ICON_BUTTON} onClick={props.onSearch} title="搜索任务与会话" aria-label="搜索">
        <Icon name="search" />
      </button>
      <button className={ICON_BUTTON} onClick={props.onNewTask} aria-label="新建任务">
        <Icon name="plus" />
      </button>
    </header>
  );
}
