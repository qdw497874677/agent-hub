import { useRef, useState } from 'react';
import { DialogShell, PRIMARY_BUTTON } from '../../shell/dialog-shell.tsx';
import type { ProjectSummaryDto } from '../../shell/api.ts';
import { RowMenu } from '../../atoms/row-menu.tsx';

/**
 * 项目行：主体按钮管「进去干活」，右边「⋯」管「删掉 / 打开」。
 *
 * 以前删除是 hover 才露出来的小字——手机上一直亮着像个噪音，桌面上又摸不到。
 * 现在两种设备都走同一个可见菜单，菜单项 ≥44px，Esc 能退、焦点能回。
 */
export function ProjectRow({
  project,
  onOpen,
  onDelete
}: {
  project: ProjectSummaryDto;
  onOpen(): void;
  onDelete(): void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 关菜单要把焦点还回「⋯」：RowMenu 只负责喊话，还原是打开它的那个组件的事。
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="flex items-stretch">
      <button
        className="min-w-0 flex-1 rounded-sm px-2 py-1 text-left hover:bg-card focus-visible:bg-card"
        onClick={onOpen}
        data-testid="project-open"
      >
        <span className="block truncate text-body text-secondary">{project.name}</span>
        <span className="block text-meta text-tertiary">
          {project.taskCount} 任务 · {ago(project.lastActivityAt)}
        </span>
      </button>
      <button
        type="button"
        data-testid="project-menu"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-label={`项目「${project.name}」的操作`}
        title="项目操作"
        className="flex size-[44px] shrink-0 items-center justify-center rounded-sm text-body text-tertiary hover:text-primary md:size-8"
        onClick={(event) => {
          trigger.current = event.currentTarget;
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.right - 168, y: rect.bottom + 2 });
        }}
      >
        ⋯
      </button>
      {menu ? (
        <RowMenu
          label={`项目「${project.name}」的操作`}
          testId="project-menu-list"
          anchor={menu}
          items={[
            { id: 'open', label: '打开项目' },
            { id: 'delete', label: '删除项目…', hint: '进回收站，可还原；磁盘上的文件不删', danger: true }
          ]}
          onPick={(id) => {
            // 先还焦点再开新东西：删除对话框记的「从哪来」就是这里。
            trigger.current?.focus({ preventScroll: true });
            setMenu(null);
            if (id === 'open') onOpen();
            else onDelete();
          }}
          onClose={(refocus) => {
            setMenu(null);
            if (refocus) trigger.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 「所有项目」抽屉：手机首页把项目排到会话后面之后，这里给一个不用滚到底的入口。
 * 桌面侧栏本来就一直在，所以只在窄屏露头。
 */
export function ProjectListSheet({
  projects,
  onOpen,
  onDelete,
  onCreate,
  onClose
}: {
  projects: readonly ProjectSummaryDto[];
  onOpen(project: ProjectSummaryDto): void;
  onDelete(project: ProjectSummaryDto): void;
  onCreate(): void;
  onClose(): void;
}) {
  return (
    <DialogShell
      title="项目"
      testId="project-sheet"
      onClose={onClose}
      footer={
        <button
          type="button"
          className={PRIMARY_BUTTON}
          onClick={() => {
            onClose();
            onCreate();
          }}
        >
          新建项目
        </button>
      }
    >
      {projects.length === 0 ? (
        <p className="px-1 py-6 text-body text-secondary">还没有项目。点下面的「新建项目」开一个。</p>
      ) : (
        <ul className="space-y-0.5" data-testid="project-sheet-list">
          {projects.map((project) => (
            <li key={project.id} data-testid="project-sheet-row">
              <ProjectRow
                project={project}
                onOpen={() => {
                  onClose();
                  onOpen(project);
                }}
                onDelete={() => {
                  onClose();
                  onDelete(project);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </DialogShell>
  );
}

const DAY = 24 * 60 * 60 * 1000;

function ago(at: number | null): string {
  if (at === null) return '还没有活动';
  const delta = Date.now() - at;
  const minute = 60_000;
  const hour = 60 * minute;
  if (delta < minute) return '刚刚';
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
  if (delta < DAY) return `${Math.floor(delta / hour)} 小时前`;
  if (delta < 2 * DAY) return '昨天';
  if (delta < 30 * DAY) return `${Math.floor(delta / DAY)} 天前`;
  return new Date(at).toLocaleDateString('zh-CN');
}
