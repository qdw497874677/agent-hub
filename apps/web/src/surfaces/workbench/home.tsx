import { AttentionInbox } from '../../atoms/attention.tsx';
import { GlobalMenuButton, useShellInboxOpen } from '../../shell/workbench-shell.tsx';
import { TaskQueue } from './task-queue.tsx';
import { RefreshButton, useRefresh } from '../../atoms/refresh-button.tsx';
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MetadataSearchResponseDto,
  MetadataSearchSessionDto,
  MetadataSearchTaskDto,
  ProjectDto,
  RecentSessionDto
} from '../../shell/api.ts';
import { api } from '../../shell/api.ts';
import { MachinesBadge } from '../../shell/workers.tsx';
import { DeleteProjectDialog, TrashList } from './delete-project.tsx';
import { ProjectListSheet, ProjectRow } from './project-list.tsx';
import { UndoToast } from '../../atoms/undo-toast.tsx';
import { Icon } from '../../atoms/icons.tsx';
import { DialogShell, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import { homeSessionRows, homeSessionTitle, type HomeSessionRow } from '../../atoms/recent-session.ts';
import { NewProjectRepos } from './new-project-repos.tsx';
import { newProjectPrimaryProblem, newProjectReposProblem } from './new-project-repos.ts';
import { repoRowsValue, type ProjectRepoRow } from './project-repos.ts';

/** 「返回首页」时把搜索词带回来：返回的是刚才那一屏，不重置。 */
const HOME_FILTER_KEY = 'agent-hub.home.filter';

/**
 * 首页。
 *
 * 结构照 OpenCode 的 web 端：左窄栏放「在哪儿干」（项目 + 节点），右宽栏放
 * 「接着干哪条」（最近的会话 + 搜索）。之前的版本把项目当主角，用户回来还得
 * 先进项目、再看画布、才找得到昨天那条——多跳了两层。
 *
 * 仍然不做看板：这里是清单，不是按状态分列的卡片墙。
 */
type SearchHit =
  | { readonly kind: 'project'; readonly key: string; readonly project: ProjectDto }
  | { readonly kind: 'task'; readonly key: string; readonly project: ProjectDto; readonly task: MetadataSearchTaskDto }
  | { readonly kind: 'session'; readonly key: string; readonly project: ProjectDto; readonly session: MetadataSearchSessionDto };

export function HomePage({
  onOpen,
  onOpenTask
}: {
  onOpen: (project: ProjectDto, sessionId?: string) => void;
  onOpenTask: (project: ProjectDto, taskId: string) => void;
}) {
  const inboxOpen = useShellInboxOpen();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState(() => {
    try {
      return sessionStorage.getItem(HOME_FILTER_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [deleting, setDeleting] = useState<ProjectDto | null>(null);
  const [sheet, setSheet] = useState(false);
  /** 标题被截断时用这个看全文：native title 在触屏和键盘上都摸不到。 */
  const [titleView, setTitleView] = useState<HomeSessionRow | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const queryClient = useQueryClient();
  const searchRef = useRef<HTMLInputElement>(null);
  const home = useQuery({ queryKey: ['home'], queryFn: api.home, refetchInterval: 10_000 });
  // 一个动作把首页这一屏的定时查询都提前拉一遍：收件箱、派发队列、连接器提示。
  const refresh = useRefresh([['home'], ['attention'], ['dispatch'], ['connector-notices']]);

  const projects = home.data?.projects ?? [];
  const recent = useMemo(() => homeSessionRows(home.data?.recentSessions ?? []), [home.data]);
  const needle = filter.trim();
  const deferredNeedle = useDeferredValue(needle);
  const shown = recent;
  const groups = useMemo(() => groupByDay(shown), [shown]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const [activeHit, setActiveHit] = useState(0);

  const metadata = useQuery({
    queryKey: ['metadata-search', deferredNeedle],
    queryFn: () => api.metadataSearch(deferredNeedle, 8),
    // 空串是「看最近」，不是一次全站搜索；这里不发请求。
    enabled: deferredNeedle !== '',
    staleTime: 10_000,
    retry: false
  });

  const hits = useMemo<SearchHit[]>(() => {
    const data = metadata.data;
    if (!data) return [];
    const found: SearchHit[] = [];
    for (const hit of data.projects) {
      const project = projectById.get(hit.projectId);
      if (project) found.push({ kind: 'project', key: `project:${hit.projectId}`, project });
    }
    for (const task of data.tasks) {
      const project = projectById.get(task.projectId);
      if (project) found.push({ kind: 'task', key: `task:${task.taskId}`, project, task });
    }
    for (const session of data.sessions) {
      const project = projectById.get(session.projectId);
      if (project) found.push({ kind: 'session', key: `session:${session.sessionId}`, project, session });
    }
    return found;
  }, [metadata.data, projectById]);

  const searching = needle !== '';
  const resultCount = hits.length;
  const active = resultCount === 0 ? null : Math.min(activeHit, resultCount - 1);

  useEffect(() => {
    setActiveHit(0);
  }, [deferredNeedle, metadata.data]);

  // 搜索结果给读屏播报一句就够，而且等手停下来再说：每个键都念会把输入打断。
  useEffect(() => {
    if (needle === '') {
      setAnnouncement('');
      return;
    }
    const timer = window.setTimeout(() => {
      if (metadata.isPending) {
        setAnnouncement('正在搜索项目、任务和会话');
      } else if (metadata.error) {
        setAnnouncement('搜索失败，可以重试');
      } else {
        const counts = metadata.data;
        setAnnouncement(
          counts === undefined
            ? '正在搜索项目、任务和会话'
            : resultCount === 0
              ? `没有匹配「${needle}」的项目、任务或会话`
              : `找到 ${counts.projects.length} 个项目、${counts.tasks.length} 个任务、${counts.sessions.length} 条会话`
        );
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [needle, metadata.isPending, metadata.error, metadata.data, resultCount]);

  function rememberFilter(): void {
    try {
      sessionStorage.setItem(HOME_FILTER_KEY, filter);
    } catch {
      // 隐私模式 / 禁用存储时忽略：搜索词带不回去，但不影响打开结果。
    }
  }

  function open(session: HomeSessionRow): void {
    const project = projectById.get(session.projectId);
    if (project) {
      rememberFilter();
      onOpen(project, session.sessionId);
    }
  }

  function openHit(hit: SearchHit): void {
    rememberFilter();
    if (hit.kind === 'project') onOpen(hit.project);
    else if (hit.kind === 'task') onOpenTask(hit.project, hit.task.taskId);
    else onOpen(hit.project, hit.session.sessionId);
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (!searching) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setFilter('');
      return;
    }
    if (resultCount === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveHit((current) => (current + step + resultCount) % resultCount);
      return;
    }
    if (event.key === 'Enter' && active !== null) {
      event.preventDefault();
      const hit = hits[active];
      if (hit) openHit(hit);
    }
  }

  useEffect(() => {
    if (!searching || active === null) return;
    document.getElementById(`home-search-hit-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, searching]);

  useEffect(() => {
    try {
      sessionStorage.setItem(HOME_FILTER_KEY, filter);
    } catch {
      // 同上，忽略存储失败。
    }
  }, [filter]);

  // 项目行现在走「⋯」菜单（见 project-list.tsx），删除后给一条真能还原的撤销条。
  const [undo, setUndo] = useState<{ project: ProjectDto } | null>(null);
  const restore = useMutation({
    mutationFn: (project: ProjectDto) => api.restoreProject(project.id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['home'] }),
        queryClient.invalidateQueries({ queryKey: ['trash'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] })
      ]);
      setUndo(null);
    }
  });

  const projectList = (
    <ul className="space-y-0.5" data-testid="home-project-list">
      {projects.map((project, index) => (
        <li
          key={project.id}
          data-testid="project-row"
          // 360 以下连预览行也收起：再挤，首屏就一条会话都不剩了。
          className={
            index < MOBILE_PROJECTS ? 'max-md:max-[360px]:hidden md:contents' : 'max-md:hidden md:contents'
          }
        >
          <ProjectRow project={project} onOpen={() => onOpen(project)} onDelete={() => setDeleting(project)} />
        </li>
      ))}
      {projects.length > MOBILE_PROJECTS ? (
        <li className="md:hidden">
          <button
            className="flex min-h-[44px] w-full items-center rounded-sm px-2 text-meta text-link hover:bg-card"
            onClick={() => setSheet(true)}
            data-testid="all-projects"
          >
            全部 {projects.length} 个项目
          </button>
        </li>
      ) : null}
      {home.data !== undefined && projects.length === 0 ? (
        <li className="px-2 text-meta text-tertiary">还没有项目</li>
      ) : null}
    </ul>
  );

  return (
    // 手机一个滚动源（这层）；md 起变成「220px 侧栏 + 内容」两栏网格，每栏自己滚。
    // DOM 顺序就是手机上的阅读顺序：招牌 → 导航 → 待办/搜索/会话 → 项目 → 回收站/机器。
    // 项目在会话后面（键盘 Tab 与眼睛看到的一致），桌面靠 grid 把项目放回左栏。
    <div
      data-testid="home-root"
      className="flex h-full flex-col overflow-y-auto md:grid md:h-full md:grid-cols-[220px_minmax(0,1fr)] md:grid-rows-[auto_auto_minmax(0,1fr)_auto_auto] md:overflow-hidden"
    >
      <header className="order-1 flex items-center justify-between gap-2 px-3 pb-3 pt-4 max-md:border-b max-md:border-hair md:col-start-1 md:row-start-1 md:px-3 md:py-3">
        <h1 className="min-w-0 truncate text-head text-primary">
          agent-hub<span className="sr-only"> · 首页</span>
        </h1>
        <div className="flex shrink-0 items-center gap-1">
          {/* 手机上项目排在会话后面，这个入口让「全部项目」不用滚到底。桌面侧栏一直在，所以隐藏。 */}
          <button
            type="button"
            data-testid="projects-entry"
            aria-haspopup="dialog"
            aria-label={`所有项目（${projects.length}）`}
            title="所有项目"
            className="flex size-[44px] items-center justify-center rounded-sm text-tertiary hover:text-primary md:hidden"
            onClick={() => setSheet(true)}
          >
            <Icon name="folder" />
          </button>
          <GlobalMenuButton />
        </div>
      </header>

      <main
        id="home-main"
        aria-labelledby="home-title"
        className="order-3 min-w-0 md:col-start-2 md:row-start-1 md:row-span-5 md:min-h-0 md:overflow-y-auto md:border-l md:border-hair"
      >
        <h2 id="home-title" className="sr-only">
          首页
        </h2>
        <div className="mx-auto w-full max-w-[760px] px-4 py-6 md:px-8">
          {creating ? null : (
            <div className="mb-1">
              {!inboxOpen ? <AttentionInbox
                headerAction={
                  <RefreshButton
                    testId="home-refresh"
                    label="刷新首页待办"
                    busy={refresh.busy}
                    error={refresh.error}
                    onRefresh={refresh.refresh}
                  />
                }
                onOpen={(item) => {
                  const project = projectById.get(item.projectId);
                  if (project) onOpen(project, item.sessionId);
                }}
              /> : null}
              {refresh.error ? (
                <p role="alert" data-testid="home-refresh-error" className="mb-3 text-meta text-rust">
                  刷新没成功：{refresh.error}
                </p>
              ) : null}
              <TaskQueue />
            </div>
          )}
          {creating ? (
            <CreateProjectPanel
              onCancel={() => setCreating(false)}
              onCreated={(created) => {
                setCreating(false);
                onOpen(created);
              }}
            />
          ) : (
            <div className="mb-1 flex items-center gap-2 rounded-md border border-hair bg-card px-3 py-1 max-md:min-h-[44px] md:py-2">
              <span className="text-tertiary">⌕</span>
              <input
                ref={searchRef}
                className="min-w-0 flex-1 bg-transparent text-body text-primary outline-none placeholder:text-tertiary"
                aria-label="搜项目、任务或会话"
                placeholder="搜项目、任务或会话"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={searching && !metadata.isPending}
                aria-controls={searching ? 'home-search-results' : undefined}
                aria-activedescendant={searching && active !== null ? `home-search-hit-${active}` : undefined}
                maxLength={160}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={onSearchKeyDown}
              />
              {filter === '' ? null : (
                // 44 是手指能稳稳点到的最小边；whitespace-nowrap + shrink-0 防它在窄屏被压成竖排两字。
                <button
                  aria-label="清除搜索"
                  className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-sm text-meta text-tertiary hover:text-secondary md:min-h-0 md:min-w-0 md:px-1"
                  onClick={() => {
                    setFilter('');
                    searchRef.current?.focus();
                  }}
                >
                  清除
                </button>
              )}
            </div>
          )}
          {searching ? (
            <p className="mb-4 px-1 text-meta text-tertiary">
              全站搜索只找项目名、任务标题、会话标题或会话 ID，不搜聊天内容。
            </p>
          ) : null}

          {searching ? (
            <SearchResults
              query={needle}
              queryResult={metadata}
              hits={hits}
              active={active}
              onActive={setActiveHit}
              onOpen={openHit}
            />
          ) : (
          <section aria-labelledby="recent-title">
            <h2 id="recent-title" className="sr-only">
              最近的会话
            </h2>
            {home.isPending ? (
              <div aria-label="读取中" className="mb-5 space-y-2">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="h-7 animate-pulse rounded-sm bg-card" />
                ))}
              </div>
            ) : null}
            {home.error ? (
              <p className="mb-4 border-l border-rust pl-2 text-meta text-secondary">
                读不到会话：{(home.error as Error).message}
                <button className="ml-2 text-link hover:underline" onClick={() => void home.refetch()}>
                  重试
                </button>
              </p>
            ) : null}

            {groups.map(([label, sessions]) => (
              <div key={label} className="mb-5" role="group" aria-labelledby={`day-${label}`}>
                <h3 id={`day-${label}`} className="mb-1 px-1 text-meta text-tertiary">
                  {label}
                </h3>
                <ul>
                  {sessions.map((session) => (
                    <li key={session.sessionId} data-settled={settled(session) ? 'true' : undefined}>
                      <RecentSessionRow
                        session={session}
                        isSettled={settled(session)}
                        onOpen={() => open(session)}
                        onShowTitle={() => setTitleView(session)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {!home.isPending && !home.error && recent.length === 0 ? (
              <p className="rounded-md border border-hair bg-panel px-4 py-6 text-body text-secondary">
                还没有会话。选一个项目，建一条任务，点任务卡上的「＋ 会话」派生第一条会话。
              </p>
            ) : null}
          </section>
          )}
          <p role="status" aria-live="polite" data-testid="search-status" className="sr-only">
            {announcement}
          </p>
        </div>
      </main>

      <aside
        className="order-6 mt-2 px-4 pb-2 md:col-start-1 md:row-start-3 md:mt-0 md:min-h-0 md:overflow-y-auto md:px-3"
        aria-label="首页侧栏"
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-meta text-tertiary">项目</h2>
          <button
            className="-mr-2 flex size-[44px] items-center justify-center rounded-sm text-body text-secondary hover:text-primary md:mr-0 md:h-8 md:w-8 md:text-meta"
            onClick={() => setCreating((open) => !open)}
            title="新建项目"
            aria-label="新建项目"
            data-testid="new-project"
          >
            ＋
          </button>
        </div>
        {projectList}
      </aside>

      <div className="order-7 px-4 md:col-start-1 md:row-start-4 md:px-3">
        <TrashList />
      </div>
      <div className="order-8 mt-auto border-t border-hair px-4 pb-4 pt-3 md:col-start-1 md:row-start-5 md:mt-0 md:border-t-0 md:px-3 md:py-3">
        <MachinesBadge />
      </div>

      {deleting ? (
        <DeleteProjectDialog
          project={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => setUndo({ project: deleting })}
        />
      ) : null}
      {sheet ? (
        <ProjectListSheet
          projects={projects}
          onOpen={(project) => onOpen(project)}
          onDelete={(project) => setDeleting(project)}
          onCreate={() => setCreating(true)}
          onClose={() => setSheet(false)}
        />
      ) : null}
      {undo ? (
        <UndoToast
          message={`「${undo.project.name}」已移到回收站`}
          pending={restore.isPending}
          error={restore.error ? (restore.error as Error).message : null}
          onAction={() => restore.mutate(undo.project)}
          onDismiss={() => setUndo(null)}
        />
      ) : null}
      {titleView ? (
        <SessionTitleDialog
          session={titleView}
          onClose={() => setTitleView(null)}
          onOpen={() => {
            const session = titleView;
            setTitleView(null);
            open(session);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 全站搜索的结果：项目 / 任务 / 会话三组。
 *
 * 和「最近会话」不是一回事：这里只回答「跳到哪」，不读正文，也不冒充对话搜索。
 * 结果按组显示，但键盘把三组当成一条纵向列表走，避免在一个输入框里再分上下左右。
 */
function SearchResults({
  query,
  queryResult,
  hits,
  active,
  onActive,
  onOpen
}: {
  query: string;
  queryResult: {
    readonly isPending: boolean;
    readonly error: unknown;
    readonly data: MetadataSearchResponseDto | undefined;
    readonly refetch: () => unknown;
  };
  hits: readonly SearchHit[];
  active: number | null;
  onActive: (index: number) => void;
  onOpen: (hit: SearchHit) => void;
}) {
  if (queryResult.isPending) {
    return (
      <div role="status" data-testid="metadata-search-loading" className="mb-5 space-y-1.5" aria-label="正在搜索">
        {[0, 1, 2].map((row) => (
          <div key={row} className="h-9 animate-pulse rounded-sm bg-card" />
        ))}
        <p className="px-1 text-meta text-tertiary">正在搜索项目、任务和会话…</p>
      </div>
    );
  }

  if (queryResult.error) {
    return (
      <div
        role="alert"
        data-testid="metadata-search-error"
        className="mb-5 rounded-md border border-rust/40 bg-panel px-4 py-3 text-body text-secondary"
      >
        <p>搜索失败：{(queryResult.error as Error).message}</p>
        <button className="mt-1 min-h-[44px] text-meta text-link hover:underline" onClick={() => void queryResult.refetch()}>
          重新搜索
        </button>
      </div>
    );
  }

  if (hits.length === 0) {
    return (
      <p
        data-testid="metadata-search-empty"
        className="mb-5 rounded-md border border-hair bg-panel px-4 py-6 text-body text-secondary"
      >
        没有匹配「{query}」的项目、任务或会话。换个名字或会话 ID 试试；这里不搜聊天内容。
      </p>
    );
  }

  const numbered = hits.map((hit, index) => ({ hit, index }));
  const projectRows = numbered.filter(({ hit }) => hit.kind === 'project');
  const taskRows = numbered.filter(({ hit }) => hit.kind === 'task');
  const sessionRows = numbered.filter(({ hit }) => hit.kind === 'session');
  return (
    <section aria-labelledby="metadata-search-title" data-testid="metadata-search-results" className="mb-5">
      <h2 id="metadata-search-title" className="sr-only">
        全站搜索结果
      </h2>
      <div id="home-search-results" role="listbox" aria-label="项目、任务和会话搜索结果" className="space-y-3">
        <HitGroup title="项目" testId="metadata-projects" empty={projectRows.length === 0}>
          {projectRows.map(({ hit, index }) => (
            <HitOption
              key={hit.key}
              index={index}
              active={active === index}
              testId="metadata-project"
              label={hit.kind === 'project' ? `${hit.project.name}，项目` : ''}
              onActive={onActive}
              onOpen={() => onOpen(hit)}
              icon="folder"
              primary={hit.kind === 'project' ? hit.project.name : ''}
              secondary="项目"
            />
          ))}
        </HitGroup>

        <HitGroup title="任务" testId="metadata-tasks" empty={taskRows.length === 0}>
          {taskRows.map(({ hit, index }) => (
            <HitOption
              key={hit.key}
              index={index}
              active={active === index}
              testId="metadata-task"
              label={hit.kind === 'task' ? `${hit.task.title}，任务，${hit.task.projectName}` : ''}
              onActive={onActive}
              onOpen={() => onOpen(hit)}
              icon="check"
              primary={hit.kind === 'task' ? hit.task.title : ''}
              secondary={hit.kind === 'task' ? `${hit.task.projectName} · 任务` : ''}
            />
          ))}
        </HitGroup>

        <HitGroup title="会话" testId="metadata-sessions" empty={sessionRows.length === 0}>
          {sessionRows.map(({ hit, index }) => {
            const session = hit.kind === 'session' ? hit.session : null;
            const title = session === null ? '' : session.title?.trim() || `会话 ${session.sessionId.slice(0, 6)}`;
            const meta =
              session === null
                ? ''
                : [session.taskTitle?.trim(), session.projectName, '会话'].filter((part) => Boolean(part)).join(' · ');
            return (
              <HitOption
                key={hit.key}
                index={index}
                active={active === index}
                testId="metadata-session"
                label={`${title}，会话，${meta}`}
                onActive={onActive}
                onOpen={() => onOpen(hit)}
                icon="message"
                primary={title}
                secondary={meta}
              />
            );
          })}
        </HitGroup>
      </div>
    </section>
  );
}

function HitGroup({
  title,
  testId,
  empty,
  children
}: {
  title: string;
  testId: string;
  empty: boolean | undefined;
  children: ReactNode;
}) {
  if (empty !== false) return null;
  return (
    <div role="group" aria-label={title} data-testid={testId}>
      <h3 className="mb-1 px-1 text-meta text-tertiary">{title}</h3>
      <div>{children}</div>
    </div>
  );
}

function HitOption({
  index,
  active,
  testId,
  label,
  primary,
  secondary,
  icon,
  onActive,
  onOpen
}: {
  index: number;
  active: boolean;
  testId: string;
  label: string;
  primary: string;
  secondary: string;
  icon: 'folder' | 'check' | 'message';
  onActive: (index: number) => void;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      id={`home-search-hit-${index}`}
      role="option"
      aria-selected={active}
      aria-label={label}
      data-testid={testId}
      data-active={active ? 'true' : undefined}
      className="flex min-h-[44px] w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left hover:bg-card data-[active=true]:bg-card"
      onMouseEnter={() => onActive(index)}
      onClick={onOpen}
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-sm border border-hair text-tertiary">
        <Icon name={icon} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-primary">{primary}</span>
        <span className="block truncate text-meta text-tertiary">{secondary}</span>
      </span>
    </button>
  );
}

function CreateProjectPanel({
  onCancel,
  onCreated
}: {
  onCancel: () => void;
  onCreated: (project: ProjectDto) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repos, setRepos] = useState<readonly ProjectRepoRow[]>([]);
  const [primaryRepoId, setPrimaryRepoId] = useState<string | null>(null);
  const [reposOpen, setReposOpen] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => {
      // 0 个仓库 = 不传 repos（不是传空数组）；老的单仓库字段也不再带。
      const values = repos.length === 0 ? null : repoRowsValue(repos);
      return api.createProject({
        name: name.trim(),
        ...(description.trim() === '' ? {} : { description }),
        ...(values === null ? {} : { repos: values }),
        ...(values !== null && primaryRepoId !== null ? { primaryRepoId } : {})
      });
    },
    onSuccess: async (created) => {
      // 路由靠 ['projects'] 认项目；只刷 ['home'] 会让新项目在跳过去时「查无此项」。
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['home'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] })
      ]);
      onCreated(created);
    },
    onError: (failure) => setError((failure as Error).message)
  });

  return (
    <section aria-label="新建项目" className="mb-6 rounded-md border border-hair bg-panel p-4">
      <p className="mb-3 text-head text-primary">新建项目</p>

      <form
        className="mb-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === '' || create.isPending) return;
          const problem = repos.length === 0 ? null : newProjectReposProblem(repos);
          const primaryProblem = repos.length === 0 ? null : newProjectPrimaryProblem(repos, primaryRepoId);
          if (problem !== null || primaryProblem !== null) {
            // 行内问题已经在行下面写着；这里只负责展开并把主仓库这类整体问题说出来。
            setReposOpen(true);
            setRepoError(primaryProblem);
            return;
          }
          setError(null);
          setRepoError(null);
          create.mutate();
        }}
      >
        <input
          aria-label="项目名"
          autoFocus
          className="min-w-0 flex-1 rounded-sm border border-hair bg-card px-3 py-2 text-head text-primary outline-none focus:border-ring"
          value={name}
          placeholder="项目名"
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="submit"
          className="min-h-[40px] shrink-0 rounded-sm bg-action px-4 py-2 text-body text-action-fg disabled:opacity-40"
          disabled={name.trim() === '' || create.isPending}
        >
          创建
        </button>
      </form>

      <textarea
        aria-label="项目说明"
        title="agent 开工时会读到"
        className="mb-3 block min-h-[72px] w-full resize-y rounded-sm border border-hair bg-card px-2 py-1.5 text-sub text-primary outline-none focus:border-ring"
        value={description}
        placeholder="说明（可选）"
        onChange={(event) => setDescription(event.target.value)}
      />

      {/* 项目只是 hub 里的一条记录，不绑机器；工作目录在开始任务时（选机器 → 选工作目录）再定。 */}
      <NewProjectRepos
        open={reposOpen}
        onToggle={() => setReposOpen((open) => !open)}
        rows={repos}
        primaryRepoId={primaryRepoId}
        error={repoError}
        onChange={(nextRows, nextPrimaryRepoId) => {
          setRepos(nextRows);
          setPrimaryRepoId(nextPrimaryRepoId);
          setRepoError(null);
        }}
      />

      {error ? <p className="mb-2 text-meta text-rust">{error}</p> : null}

      <button className="text-meta text-tertiary hover:text-secondary" onClick={onCancel}>
        取消
      </button>
    </section>
  );
}

const DAY = 24 * 60 * 60 * 1000;

/** 窄屏项目预览的条数：项目是「换个地方干活」的次要入口，不该把会话挤到第二屏。 */
const MOBILE_PROJECTS = 3;

/** 「今天 / 昨天 / 更早」比一串日期好看，也正好对上「昨天那条跑完没有」这个问法。 */
function groupByDay(sessions: readonly HomeSessionRow[]): Array<[string, HomeSessionRow[]]> {
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const buckets: Array<[string, HomeSessionRow[]]> = [
    ['今天', []],
    ['昨天', []],
    ['更早', []]
  ];
  for (const session of sessions) {
    if (session.updatedAt >= startOfToday) buckets[0]?.[1].push(session);
    else if (session.updatedAt >= startOfToday - DAY) buckets[1]?.[1].push(session);
    else buckets[2]?.[1].push(session);
  }
  return buckets.filter(([, items]) => items.length > 0);
}

/** 与画布卡片同一套颜色：运行中琥珀、完成 sage、已停止灰、中断/失败 rust。 */
function settled(session: HomeSessionRow): boolean {
  return session.settledAt !== null && session.settledAt !== undefined;
}

function dotClass(status: RecentSessionDto['status']): string {
  if (status === 'running') return 'bg-accent';
  if (status === 'done') return 'bg-sage';
  if (status === 'stopped') return 'bg-tertiary';
  return 'bg-rust';
}

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

/** 标题这一格到底有没有被截掉：单行看宽、两行（line-clamp）看高。 */
function useTruncated<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const measure = () => {
      const over = node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
      setTruncated(over);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // 字体晚到时宽度会变；resize 和字体就绪都再量一次
    window.addEventListener('resize', measure);
    void document.fonts?.ready.then(measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return [ref, truncated] as const;
}

/**
 * 一条最近会话。
 *
 * 窄屏两行：第一行 状态点 + 标题（最多两行）+ 时间，第二行 agent · 项目；桌面回到一行四列。
 * 时间列 whitespace-nowrap：以前 w-16 被压到 52px，「18 分钟前」折成两行，行高从 30 涨到 44。
 *
 * 标题真的被截掉时，行尾多一个「全文」按钮（行按钮的兄弟节点，不嵌在里面）：
 * native title 只在悬停时出来，触屏和键盘用户都摸不到完整标题。
 */
function RecentSessionRow({
  session,
  isSettled,
  onOpen,
  onShowTitle
}: {
  session: HomeSessionRow;
  isSettled: boolean;
  onOpen: () => void;
  onShowTitle: () => void;
}) {
  const [titleRef, truncated] = useTruncated<HTMLSpanElement>();
  return (
    <div className="flex items-stretch gap-1">
      <button
        data-testid="home-session-row"
        className={`grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-sm px-1 py-1.5 text-left hover:bg-card md:grid-cols-[auto_minmax(0,1fr)_auto_auto] ${isSettled ? 'opacity-60' : ''}`}
        onClick={onOpen}
        title={homeSessionTitle(session)}
      >
        <span
          className={`col-start-1 row-start-1 mt-1.5 size-1.5 shrink-0 self-start rounded-full md:mt-0 md:self-center ${
            isSettled ? 'border border-tertiary' : dotClass(session.status)
          }`}
        />
        <span
          ref={titleRef}
          className="col-start-2 row-start-1 min-w-0 truncate text-body text-primary max-md:line-clamp-2 max-md:whitespace-normal"
        >
          {homeSessionTitle(session)}
        </span>
        <span
          data-testid="home-session-time"
          className="col-start-3 row-start-1 whitespace-nowrap text-right text-meta tabular-nums text-tertiary md:col-start-4"
        >
          {ago(session.updatedAt)}
        </span>
        <span className="col-span-2 col-start-2 row-start-2 flex min-w-0 items-center gap-1.5 text-meta text-tertiary md:col-span-1 md:col-start-3 md:row-start-1">
          <span
            className="truncate"
            title={session.taskTitle?.trim() ? `${session.taskTitle.trim()} · ${session.agentId} · ${session.projectName}` : undefined}
          >
            {session.taskTitle?.trim() ? `${session.taskTitle.trim()} · ` : ''}
            {session.agentId} · {session.projectName}
          </span>
          {isSettled ? <span className="shrink-0">已收起</span> : null}
        </span>
      </button>
      {truncated ? (
        <button
          type="button"
          data-testid="home-session-full-title"
          aria-label={`查看「${homeSessionTitle(session)}」的完整标题`}
          className="flex w-[44px] shrink-0 items-center justify-center rounded-sm text-meta text-tertiary underline decoration-tertiary/60 decoration-dotted underline-offset-[3px] hover:bg-card hover:text-primary md:w-8"
          onClick={onShowTitle}
        >
          全文
        </button>
      ) : null}
    </div>
  );
}

/** 标题被截断时的全文：不占行内的位置，触屏和键盘都能打开。 */
function SessionTitleDialog({
  session,
  onClose,
  onOpen
}: {
  session: HomeSessionRow;
  onClose: () => void;
  onOpen: () => void;
}) {
  return (
    <DialogShell
      title="完整标题"
      testId="session-title-dialog"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
            关闭
          </button>
          <button type="button" className={SECONDARY_BUTTON} onClick={onOpen}>
            打开会话
          </button>
        </div>
      }
    >
      <p data-testid="session-title-dialog-text" className="mb-2 break-words text-body text-primary">
        {homeSessionTitle(session)}
      </p>
      <p className="text-meta text-tertiary">
        {session.taskTitle?.trim() ? `${session.taskTitle.trim()} · ` : ''}
        {session.agentId} · {session.projectName} · {ago(session.updatedAt)}
        {settled(session) ? ' · 已收起' : ''}
      </p>
    </DialogShell>
  );
}
