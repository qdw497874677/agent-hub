import type { ProjectDto } from '../../shell/api.ts';
import type { StreamState } from '../../atoms/live.ts';

interface Props {
  readonly project: ProjectDto;
  readonly projects: readonly ProjectDto[];
  readonly stream: StreamState;
  onMenu(): void;
  onSwitchProject(project: ProjectDto): void;
  onSearch(): void;
  onNewTask(): void;
}

/** 手机端顶栏。桌面导航在侧栏里，这里只保留进入项目的四个入口。 */
export function ProjectHeader(props: Props) {
  const { project, projects } = props;
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-hair bg-panel px-2">
      <button
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-hair text-meta text-secondary hover:border-accent hover:text-accent"
        title="项目导航"
        aria-label="打开侧栏"
        onClick={props.onMenu}
      >
        ☰
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <select
          className="min-h-11 min-w-0 flex-1 truncate rounded-sm border border-hair bg-panel px-2 py-1 text-meta text-primary"
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
        {props.stream === 'reconnecting' ? (
          <span className="shrink-0 text-meta text-rust" role="status">
            ●
          </span>
        ) : null}
      </div>
      <button
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-hair text-meta text-tertiary hover:border-accent hover:text-accent"
        onClick={props.onSearch}
        title="搜索任务与会话"
        aria-label="搜索"
      >
        ⌕
      </button>
      <button
        className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-sm border border-hair px-2 text-meta text-secondary hover:border-accent hover:text-accent"
        onClick={props.onNewTask}
        aria-label="新建任务"
      >
        ＋
      </button>
    </header>
  );
}
