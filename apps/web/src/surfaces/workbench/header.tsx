import type { ReactNode } from 'react';
import type { ProjectDto } from '../../shell/api.ts';
import type { StreamState } from '../../atoms/live.ts';
import type { View } from '../../shell/route.ts';
import { Icon } from '../../atoms/icons.tsx';
import { ViewSwitch } from './view-switch.tsx';

interface Props {
  readonly project: ProjectDto;
  readonly stream: StreamState;
  readonly view: View;
  readonly globalNav?: ReactNode;
  onView(view: View): void;
  onMenu(): void;
}

const ICON_BUTTON = 'flex size-[44px] shrink-0 items-center justify-center rounded-control text-tertiary hover:bg-hover hover:text-primary';

/** 手机端页头：项目树、项目视图和全站入口。其他项目操作在抽屉内。 */
export function ProjectHeader(props: Props) {
  const { project } = props;
  return (
    <header className="flex h-[48px] shrink-0 items-center gap-1 border-b border-hair bg-panel px-1.5">
      <button className={ICON_BUTTON} title="项目导航" aria-label="打开侧栏" onClick={props.onMenu}>
        <Icon name="panel" />
      </button>
      <span className="min-w-0 flex-1 truncate text-sub font-medium text-primary" title={project.name}>{project.name}</span>
      {props.stream === 'reconnecting' ? (
        <span className="shrink-0 text-warning" role="status" aria-label="重连中">
          <Icon name="warning" size={14} />
        </span>
      ) : null}
      <ViewSwitch view={props.view} onView={props.onView} iconOnly />
      {props.globalNav}
    </header>
  );
}
