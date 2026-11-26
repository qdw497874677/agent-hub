import { modelLabel } from '../../atoms/model-label.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { localTime } from '../../shell/local-time.ts';
import { useQuery } from '@tanstack/react-query';
import type { CanvasDto, SearchHitDto, SessionDto, TaskDto } from '../../shell/api.ts';
import { api } from '../../shell/api.ts';
import { useCoordinators } from '../../shell/coordinators.ts';
import type { LiveMap } from '../../atoms/live.ts';
import { StatusPill } from '../../atoms/status.tsx';
import { NoTasksHint } from './empty-tasks.tsx';
import { WorkdirEntries } from './workdir-tabs.tsx';
import { resolveWorker, useWorkers, WorkerChip } from '../../shell/workers.tsx';
import { workspaceName } from '../../atoms/workspace-format.ts';
import { Icon } from '../../atoms/icons.tsx';
import { modKeyLabel, useNarrow } from '../../shell/device.ts';
import { filterActions, type PaletteAction } from './palette.ts';
import { RowMenu } from '../../atoms/row-menu.tsx';
import { DeleteSessionDialog } from '../../atoms/delete-session-dialog.tsx';
import { sessionActionItems } from '../../atoms/session-actions.ts';
import { useSessionActions } from '../../atoms/use-session-actions.ts';
import { waitingForReply } from '../../atoms/live-core.ts';
import { UndoToast } from '../../atoms/undo-toast.tsx';
import { TaskBadge } from './task-detail.tsx';
import { attentionTitle, PHASE_LABEL } from '../../atoms/attention.tsx';
import { paletteSnapshot } from './palette-recent.ts';
import { useAccount } from '../../shell/account-context.ts';
import { workspaceSessionGroups, workspaceWorkerLabel } from './list-workspaces.ts';
export type { PaletteAction } from './palette.ts';


function statusOf(session: SessionDto, live: LiveMap): SessionDto['status'] {
  return live[session.id]?.status ?? session.status;
}

/** 调度器起的会话没有自己的名字，第一句话是固定模板；列表里别把这句模板当会话名念给用户。 */
const DISPATCH_PROMPT_PREFIX = '你是被调度器派来推进这个任务的任务智能体';

/** 这一组里有会话正在跑（或等你说话）：移动端把它排到前面。 */
function groupIsActive(
  group: { readonly sessions: readonly SessionDto[] },
  live: LiveMap
): boolean {
  return group.sessions.some((session) => {
    const status = statusOf(session, live);
    return status === 'running' || waitingForReply(live[session.id], status);
  });
}

/**
 * 列表视图：画布的低成本降级形态（S6.4）。
 *
 * 它不替代画布，只回答画布回答得慢的两个问题：「今天一共几个会话在跑」
 * 和「那条我想不起来的会话叫什么」。这里不做看板——按状态分列会诱导人
 * 用列来管理流程，那是另一套产品的入口。
 */
export function ListView({
  canvas,
  archivedTasks = [],
  live,
  onOpen,
  onOpenWorkdir,
  onDerive,
  onTaskDetail,
  onNewTask,
  onChanged,
  focusTaskId,
  onRefresh
}: {
  canvas: CanvasDto;
  /** 已归档任务：日常分组里不出现，只在底部折叠区里等着恢复。 */
  archivedTasks?: readonly TaskDto[];
  live: LiveMap;
  onOpen: (sessionId: string) => void;
  onOpenWorkdir: (id: string) => void;
  onDerive: (taskId: string) => void;
  onTaskDetail: (taskId: string) => void;
  onNewTask: () => void;
  /** 数据变化后让外层更新：带任务回执时就地改投影，否则重拉画布。 */
  onChanged: (task?: TaskDto) => void | Promise<void>;
  /** 刚建好的任务：列表滚到这一行，别让「创建成功」只停在 toast 里。 */
  focusTaskId?: string | null;
  /** 主动刷新：重拉画布 + 项目清单（外层传进来，和自动刷新用同一份查询）。 */
  onRefresh?: () => Promise<void>;
}) {
  const narrow = useNarrow();
  const account = useAccount();
  const collapseScope = account ? `agent-hub.list-workspaces:${JSON.stringify([account.id, canvas.project.id])}` : null;
  const readCollapsed = (scope: string | null): Set<string> => {
    if (!scope) return new Set();
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(scope) ?? '[]');
      return new Set(Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : []);
    } catch {
      return new Set();
    }
  };
  const [collapseState, setCollapseState] = useState(() => ({ scope: collapseScope, keys: readCollapsed(collapseScope) }));
  const collapsed = collapseState.scope === collapseScope ? collapseState.keys : readCollapsed(collapseScope);
  const toggleWorkspace = (key: string) => {
    setCollapseState((current) => {
      const keys = new Set(current.scope === collapseScope ? current.keys : readCollapsed(collapseScope));
      if (keys.has(key)) keys.delete(key);
      else keys.add(key);
      if (collapseScope) {
        try { sessionStorage.setItem(collapseScope, JSON.stringify([...keys])); } catch { /* storage is optional */ }
      }
      return { scope: collapseScope, keys };
    });
  };
  // 主会话的姓名来自登记表：没有它，无任务会话只能说「没有任务的会话」。
  const { ids: coordinatorIds } = useCoordinators(canvas.project.id);
  const groups = useMemo(() => workspaceSessionGroups(canvas, coordinatorIds), [canvas, coordinatorIds]);
  const unstartedTasks = useMemo(() => {
    const started = new Set(canvas.sessions.map((session) => session.taskId).filter((taskId) => taskId !== null));
    return canvas.tasks.filter(
      (task) => !started.has(task.id) && task.status !== 'done' && task.status !== 'abandoned'
    );
  }, [canvas.sessions, canvas.tasks]);
  const [refreshing, setRefreshing] = useState(false);
  // 窄屏先给会话（在跑的、最近的在前），再给还没有会话的任务：手机上一屏只够几行，
  // 「上次聊到哪」比「还没开始的任务」更常被找。宽屏保持原来「任务先、会话后」的顺序。
  const orderedGroups = useMemo(() => {
    if (!narrow) return groups;
    const latest = (group: (typeof groups)[number]) =>
      group.sessions.reduce((max, session) => Math.max(max, session.createdAt), 0);
    return [...groups].sort((a, b) => {
      const activeA = groupIsActive(a, live) ? 0 : 1;
      const activeB = groupIsActive(b, live) ? 0 : 1;
      if (activeA !== activeB) return activeA - activeB;
      return latest(b) - latest(a);
    });
  }, [groups, live, narrow]);
  const workers = useWorkers();
  const workspaces = useMemo(
    () => new Map(canvas.workspaces.map((workspace) => [workspace.id, workspace])),
    [canvas.workspaces]
  );
  const agentLabel = (agentId: string) => canvas.agents.find((agent) => agent.id === agentId)?.label ?? agentId;

  // 行尾「⋯」：手机上常驻 44px，桌面上也一直看得见（不靠 hover，键盘 / 触屏都够得着）。
  // 和行主体是两个兄弟按钮，点菜单不会顺带进会话。
  const actions = useSessionActions(canvas.project.id);
  const [menu, setMenu] = useState<{ sessionId: string; label: string; x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState<SessionDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    message: string;
    actionLabel?: string;
    action?: () => void;
    error?: string | null;
  } | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const listRoot = useRef<HTMLDivElement | null>(null);
  const scrollKey = `agent-hub.list-scroll:${canvas.project.id}`;

  // 返回列表时回到刚才那一屏：SPA 卸载/挂载不会自动保住滚动容器。
  useEffect(() => {
    const root = listRoot.current;
    if (!root) return;
    try {
      const y = Number(sessionStorage.getItem(scrollKey) ?? 0);
      if (Number.isFinite(y) && y > 0) root.scrollTop = y;
    } catch {
      // 存储不可用时只是不恢复位置，不影响列表。
    }
  }, [scrollKey]);

  const rememberScroll = () => {
    try {
      sessionStorage.setItem(scrollKey, String(listRoot.current?.scrollTop ?? 0));
    } catch {
      // 同上。
    }
  };

  useEffect(() => {
    if (!focusTaskId) return;
    const row = Array.from(listRoot.current?.querySelectorAll<HTMLElement>('[data-task-id]') ?? []).find(
      (element) => element.dataset['taskId'] === focusTaskId
    );
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusTaskId, canvas.tasks]);
  const menuSession = menu === null ? undefined : canvas.sessions.find((session) => session.id === menu.sessionId);
  const menuStatus = menuSession === undefined ? null : statusOf(menuSession, live);
  const menuRunning =
    menuSession !== undefined &&
    menuStatus !== null &&
    (menuStatus === 'running' || waitingForReply(live[menuSession.id], menuStatus));
  // 和侧栏、会话页共用同一套动作和禁用原因。列表里先放最常用的三项：
  // 停止、收起/移回、删除；打开会话由列表自己的行菜单补上。
  const menuActions =
    menuSession === undefined || menuStatus === null
      ? []
      : [
          { id: 'open', label: '打开会话', hint: '进入这条会话的对话', disabled: false, danger: false },
          ...sessionActionItems({
            status: menuStatus,
            settled: menuSession.settledAt != null,
            pinned: menuSession.pinned === true,
            lastSeq: live[menuSession.id]?.lastSeq ?? menuSession.lastSeq,
            turnRunning: menuRunning,
            forkDenied: false,
            canExpand: false
          })
            .filter((item) => item.id === 'interrupt' || item.id === 'settle' || item.id === 'delete')
            .map((item) => (busyId === menuSession.id ? { ...item, disabled: true } : item))
        ];

  /** 手动刷新：只重拉当前项目的画布（外层顺带项目清单），不整页重载——列表滚动位置和路由都不动。 */
  async function refreshList(): Promise<void> {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
      setNotice((current) => (current?.message === '没刷新成功' ? null : current));
    } catch (failure) {
      setNotice({
        message: '没刷新成功',
        error: failure instanceof Error ? failure.message : String(failure),
        actionLabel: '重试',
        action: () => void refreshList()
      });
    } finally {
      setRefreshing(false);
    }
  }

  async function stopSession(session: SessionDto, label: string): Promise<void> {
    setBusyId(session.id);
    setNotice(null);
    try {
      await api.interrupt(session.id);
      // 回执只证明请求送到了；状态仍是 running 就继续显示 running，等运行时结束帧。
      onChanged();
      setNotice({ message: `已请求停止「${label}」`, actionLabel: '关闭', action: () => setNotice(null) });
    } catch (failure) {
      setNotice({
        message: `没停下「${label}」`,
        error: failure instanceof Error ? failure.message : String(failure),
        actionLabel: '重试',
        action: () => void stopSession(session, label)
      });
    } finally {
      setBusyId(null);
    }
  }

  async function setArchived(task: TaskDto, next: boolean): Promise<void> {
    setBusyId(task.id);
    setNotice(null);
    try {
      const updated = await api.archiveTask(task.id, next);
      // 回执就是新投影：先落到缓存（含未归档列表 / 归档区），再显示成功。
      await onChanged(updated);
      setNotice(
        next
          ? {
              message: `已归档「${task.title}」`,
              actionLabel: '撤销',
              action: () => void setArchived(task, false)
            }
          : {
              message: `已恢复「${task.title}」`,
              actionLabel: '再归档',
              action: () => void setArchived(task, true)
            }
      );
    } catch (failure) {
      setNotice({
        message: next ? `没归档「${task.title}」` : `没恢复「${task.title}」`,
        error: failure instanceof Error ? failure.message : String(failure),
        actionLabel: '重试',
        action: () => void setArchived(task, next)
      });
    } finally {
      setBusyId(null);
    }
  }

  async function settleSession(session: SessionDto, label: string, next: boolean): Promise<void> {
    setBusyId(session.id);
    setNotice(null);
    try {
      await actions.setSettled(session, next);
      onChanged();
      setNotice(
        next
          ? {
              message: `已收起「${label}」`,
              actionLabel: '撤销',
              action: () => void settleSession(session, label, false)
            }
          : { message: `已移回「${label}」`, actionLabel: '关闭', action: () => setNotice(null) }
      );
    } catch (failure) {
      setNotice({
        message: next ? `没收起「${label}」` : `没移回「${label}」`,
        error: failure instanceof Error ? failure.message : String(failure),
        actionLabel: '重试',
        action: () => void settleSession(session, label, next)
      });
    } finally {
      setBusyId(null);
    }
  }

  const refreshButton =
    onRefresh === undefined ? null : (
      <button
        type="button"
        data-testid="list-refresh"
        aria-label="刷新"
        aria-busy={refreshing}
        title="刷新这一页"
        disabled={refreshing}
        onClick={() => void refreshList()}
        className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control text-tertiary hover:bg-hover hover:text-primary disabled:opacity-60 md:min-h-[28px] md:min-w-[28px]"
      >
        <Icon
          name="refresh"
          size={15}
          className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined}
        />
        {refreshing ? (
          <span role="status" className="sr-only">刷新中</span>
        ) : null}
      </button>
    );

  // 窄屏一行内解决：标题截断，状态不换行也不竖排；整行标题是「看日志」的入口，
  // 「开会话」单独一个 44px 按钮，仍然进显式配置弹窗（不猜默认值）。
  const taskSection =
    unstartedTasks.length > 0 ? (
      <section
        className="mb-4"
        aria-label="未开始的任务"
        data-testid="list-unstarted"
      >
        <h3 className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-hair bg-canvas/95 py-2 text-sub text-primary backdrop-blur">
          <span className="min-w-0 truncate">未开始</span>
          <span className="shrink-0 text-meta text-tertiary">{unstartedTasks.length} 个任务</span>
        </h3>
        <ul>
          {unstartedTasks.map((task) =>
            narrow ? (
              <li
                key={task.id}
                data-testid="list-task-row"
                data-task-id={task.id}
                className="flex items-stretch border-b border-hair/60"
              >
                <button
                  type="button"
                  data-testid="list-task-open"
                  aria-label={`打开任务：${task.title}`}
                  className="flex min-h-[48px] min-w-0 flex-1 items-center gap-2 py-1 pl-3 pr-1 text-left hover:bg-card focus-visible:bg-card"
                  onClick={() => onTaskDetail(task.id)}
                >
                  <span className="min-w-0 flex-1 truncate text-body text-primary" title={task.title}>
                    {task.title}
                  </span>
                  <span className="shrink-0 whitespace-nowrap">
                    <TaskBadge status={task.status} />
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="list-task-start"
                  aria-label={`开始会话：${task.title}`}
                  className="flex min-h-[48px] shrink-0 items-center px-3 text-sub text-secondary hover:bg-card hover:text-primary"
                  onClick={() => onDerive(task.id)}
                >
                  开会话
                </button>
              </li>
            ) : (
              <li
                key={task.id}
                data-testid="list-task-row"
                data-task-id={task.id}
                className="flex flex-wrap items-center gap-2 border-b border-hair/60 py-2 pl-3 pr-1"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-body text-primary" title={task.title}>{task.title}</span>
                    <span className="shrink-0 whitespace-nowrap"><TaskBadge status={task.status} /></span>
                  </span>
                  {task.goal?.trim() ? (
                    <span className="mt-0.5 block truncate text-meta text-tertiary" title={task.goal}>{task.goal}</span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    data-testid="list-task-start"
                    aria-label={`开始会话：${task.title}`}
                    className="flex min-h-[44px] items-center rounded-sm border border-hair px-2.5 text-sub text-secondary hover:border-strong hover:text-primary"
                    onClick={() => onDerive(task.id)}
                  >
                    开始会话
                  </button>
                  <button
                    type="button"
                    data-testid="list-task-detail"
                    aria-label={`查看任务日志：${task.title}`}
                    className="flex min-h-[44px] items-center rounded-sm px-2 text-meta text-tertiary hover:bg-card hover:text-primary"
                    onClick={() => onTaskDetail(task.id)}
                  >
                    日志
                  </button>
                </span>
              </li>
            )
          )}
        </ul>
      </section>
    ) : null;

  const sessionSections = orderedGroups.map((workspaceGroup) => {
    const expanded = !collapsed.has(workspaceGroup.key);
    const groupWorker = resolveWorker(workers.list, workspaceGroup.workerId);
    return (
      <div key={workspaceGroup.key} data-testid="list-workspace-group" data-workspace-key={workspaceGroup.key} className="mb-4 min-w-0">
        <button type="button" data-testid="list-workspace-toggle" aria-expanded={expanded}
          onClick={() => toggleWorkspace(workspaceGroup.key)}
          className="flex min-h-[44px] w-full min-w-0 items-start gap-2 rounded-sm py-2 text-left hover:bg-card focus-visible:bg-card focus-visible:outline-2 focus-visible:outline-ring">
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} className="mt-1 shrink-0 text-tertiary" />
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sub text-primary">{workspaceGroup.title}</span>
            <span className="block break-all text-meta text-tertiary">{workspaceWorkerLabel(workspaceGroup.workerId, groupWorker?.label)}{groupWorker && groupWorker.state !== 'online' ? ' · 离线' : ''}{workspaceGroup.detail ? ` · ${workspaceGroup.detail}` : ''}</span>
          </span>
          <span className="shrink-0 whitespace-nowrap text-meta text-tertiary">{workspaceGroup.sessions.length} 条</span>
        </button>
        {expanded ? <div className="ml-3 border-l border-hair pl-2">{workspaceGroup.groups.map((group) => (
            <section
              key={group.taskId}
              className="mb-4"
              // 无任务组没有任务标题：读屏也只念组名，不假装它是一条任务
              aria-label={group.taskless ? group.title : `任务：${group.title}`}
              data-testid="list-task-group"
              data-kind={group.kind}
            >
              <h3 className="flex items-baseline gap-2 border-b border-hair py-2 text-sub text-primary">
                {!group.taskless ? (
                  // 组头就是这条任务的入口（日志 / 归档 / 再开一条）：窄屏 44px，桌面保持紧凑但可聚焦。
                  <button
                    type="button"
                    data-testid="list-group-open"
                    aria-label={`打开任务：${group.title}`}
                    className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-sm text-left hover:bg-card focus-visible:bg-card focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring md:min-h-7"
                    onClick={() => onTaskDetail(group.taskId)}
                  >
                    <span className="shrink-0 text-meta text-tertiary max-md:hidden">任务</span>
                    <span className="min-w-0 flex-1 truncate">{group.title}</span>
                    <span className="shrink-0 text-meta text-tertiary">{group.sessions.length} 条会话</span>
                    <Icon name="chevron-right" size={13} className="shrink-0 text-tertiary" />
                  </button>
                ) : (
                  <>
                    <span className="min-w-0 truncate">{group.title}</span>
                    <span className="shrink-0 text-meta text-tertiary">{group.sessions.length} 条会话</span>
                  </>
                )}
              </h3>
              <ul>
                {group.sessions.map(({ session, label }) => {
                  const status = statusOf(session, live);
                  const seq = live[session.id]?.lastSeq ?? session.lastSeq;
                  const origin = session.origin.kind === 'fork'
                    ? `分叉自 #${session.origin.atSeq}`
                    : session.taskId === null ? '没有任务' : '派生';
                  const worker = resolveWorker(workers.list, session.workerId);
                  const workspace = session.workspaceId ? workspaces.get(session.workspaceId) : undefined;
                  // 调度器起跑的会话没有名字，第一句是固定模板：窄屏别把模板当会话名（宽屏保持原样）。
                  const rowLabel =
                    narrow && !session.title && label.startsWith(DISPATCH_PROMPT_PREFIX) ? '调度器派发' : label;
                  return (
                    <li
                      key={session.id}
                      data-session-id={session.id}
                      className="flex items-stretch border-b border-hair/60"
                    >
                      <button
                        type="button"
                        data-testid="list-session-row"
                        className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 py-2 pl-3 pr-1 text-left hover:bg-card focus-visible:bg-card"
                        onClick={() => {
                          rememberScroll();
                          onOpen(session.id);
                        }}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body text-primary" data-testid="list-session-label">{rowLabel}</span>
                          <span className="block truncate text-meta text-tertiary" data-testid="list-session-meta">
                            {localTime(session.createdAt)} · {origin} · {agentLabel(session.agentId)}
                          </span>
                          <span className="mt-1 hidden min-w-0 items-center gap-1.5 md:flex" data-testid="list-session-place">
                            <WorkerChip
                              worker={worker}
                              fallback={session.workerId ? session.workerId.slice(0, 8) : '本机'}
                            />
                            {workspace ? (
                              <span className="min-w-0 truncate text-meta text-tertiary" title={workspace.path}>
                                {workspaceName(workspace)}
                              </span>
                            ) : null}
                            <span className="hidden shrink-0 text-meta text-tertiary md:inline">
                              {modelLabel(session.model)} · #{seq}
                            </span>
                          </span>
                        </span>
                        <span className="shrink-0">
                          <StatusPill status={status} reason={live[session.id]?.reason} lastSeq={seq} />
                        </span>
                      </button>
                      <button
                        type="button"
                        data-testid="list-session-more"
                        aria-label={`会话「${rowLabel}」的操作`}
                        aria-haspopup="menu"
                        aria-expanded={menu?.sessionId === session.id}
                        title="会话操作"
                        className="flex size-[44px] shrink-0 items-center justify-center self-center rounded-sm text-body text-tertiary hover:bg-card hover:text-primary focus-visible:bg-card"
                        onClick={(event) => {
                          trigger.current = event.currentTarget;
                          const rect = event.currentTarget.getBoundingClientRect();
                          setMenu({ sessionId: session.id, label: rowLabel, x: rect.right - 168, y: rect.bottom + 2 });
                        }}
                      >
                        <Icon name="more" size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
        ))}</div> : null}
      </div>
    );
  });

  return (
    <div
      ref={listRoot}
      tabIndex={-1}
      className="h-full overflow-y-auto px-3 py-4 outline-none md:px-6"
      data-testid="list-view"
      onScroll={rememberScroll}
    >
      {/* 列表是扫读用的，不是文章：行可以比首页宽，但别宽到 1440 上从 228 一路拉到 1370。 */}
      <div className="mx-auto w-full max-w-[1080px]">
      {/* 窄屏顶栏已经有项目名了，这里不再重复：一行计数 + 刷新就够，省下的高度给内容。 */}
      <div
        className="mb-2 flex items-center justify-between gap-2 border-b border-hair pb-1 md:mb-3 md:pb-2"
        data-testid="list-context"
      >
        <div className="min-w-0">
          <div className="hidden items-baseline gap-2 md:flex">
            <span className="shrink-0 text-meta text-tertiary">项目</span>
            <span className="min-w-0 truncate text-sub text-primary" title={canvas.project.name}>{canvas.project.name}</span>
          </div>
          <div className="truncate text-meta text-tertiary md:mt-0.5">
            {canvas.tasks.length} 个任务 · {canvas.sessions.length} 条会话
          </div>
        </div>
        {refreshButton}
      </div>
      <WorkdirEntries projectId={canvas.project.id} onOpen={onOpenWorkdir} />
      {canvas.sessions.length === 0 ? (
        <p className="py-6 text-meta text-tertiary">
          {narrow
            ? '还没有会话。点任务行的「开会话」，或打开任务从详情里开一条。'
            : '还没有会话。从任务行点「开始会话」，或点下面的任务派生一条。'}
        </p>
      ) : null}
      {narrow ? (
        <>
          {sessionSections}
          {taskSection}
        </>
      ) : (
        <>
          {taskSection}
          {sessionSections}
        </>
      )}

      {archivedTasks.length > 0 ? (
        <section className="mb-2 border-t border-hair pt-2" data-testid="list-archived" aria-label="已归档的任务">
          <button
            type="button"
            className="flex min-h-[44px] w-full items-center gap-2 text-left text-sub text-secondary hover:text-primary"
            aria-expanded={archivedOpen}
            onClick={() => setArchivedOpen((open) => !open)}
          >
            <Icon name={archivedOpen ? 'chevron-down' : 'chevron-right'} size={14} />
            <span>已归档</span>
            <span className="text-meta text-tertiary">{archivedTasks.length} 个任务</span>
          </button>
          {archivedOpen ? (
            <ul className="pb-2">
              {archivedTasks.map((task) => (
                <li
                  key={task.id}
                  data-testid="list-archived-task"
                  data-task-id={task.id}
                  className="flex flex-wrap items-center gap-2 border-b border-hair/60 py-2 pl-6 pr-1"
                >
                  <span className="min-w-0 flex-1">
                    <button
                      type="button"
                      className="block min-h-[44px] min-w-0 truncate text-left text-body text-secondary hover:text-primary"
                      data-testid="list-archived-open"
                      onClick={() => onTaskDetail(task.id)}
                      title={task.title}
                    >
                      {task.title}
                    </button>
                    <span className="flex items-center gap-2 text-meta text-tertiary">
                      <TaskBadge status={task.status} />
                      {task.archivedAt != null ? <span>{localTime(task.archivedAt)} 归档</span> : null}
                    </span>
                  </span>
                  <button
                    type="button"
                    data-testid="list-archived-restore"
                    aria-label={`恢复任务：${task.title}`}
                    disabled={busyId === task.id}
                    className="flex min-h-[44px] shrink-0 items-center rounded-sm border border-hair px-2.5 text-sub text-secondary hover:border-strong hover:text-primary disabled:opacity-50"
                    onClick={() => void setArchived(task, false)}
                  >
                    恢复
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {canvas.tasks.length === 0 ? (
        <div className="mt-6 border-t border-hair pt-3">
          <NoTasksHint onNewTask={onNewTask} />
        </div>
      ) : null}

      {menu !== null && menuSession !== undefined ? (
        <RowMenu
          label={`会话「${menu.label}」的操作`}
          testId="list-session-menu"
          anchor={{ x: menu.x, y: menu.y }}
          items={menuActions}
          onPick={(id) => {
            // 先还焦点再开新东西：取消删除时焦点应该回到这一行的「⋯」。
            trigger.current?.focus({ preventScroll: true });
            setMenu(null);
            if (id === 'open') onOpen(menuSession.id);
            else if (id === 'interrupt') void stopSession(menuSession, menu.label);
            else if (id === 'settle')
              void settleSession(menuSession, menu.label, menuSession.settledAt == null);
            else if (id === 'delete') setDeleting(menuSession);
          }}
          onClose={(refocus) => {
            setMenu(null);
            if (refocus) trigger.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      {deleting !== null ? (
        <DeleteSessionDialog
          session={deleting}
          opening={canvas.openings[deleting.id]}
          onClose={() => {
            setDeleting(null);
            // 取消：那一行还在，焦点回到它的「⋯」。
            requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
          }}
          onDeleted={() => {
            const id = deleting.id;
            setDeleting(null);
            actions.forget(id);
            onChanged();
            // 确认：触发按钮跟着行一起没了，把焦点交给列表本身，别落回 body。
            requestAnimationFrame(() => {
              if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
              else listRoot.current?.focus({ preventScroll: true });
            });
          }}
        />
      ) : null}
      {notice !== null ? (
        <UndoToast
          testId="list-action-toast"
          actionTestId="list-action-undo"
          message={notice.message}
          actionLabel={notice.actionLabel ?? '关闭'}
          error={notice.error ?? null}
          onAction={() => (notice.action ? notice.action() : setNotice(null))}
          onDismiss={() => setNotice(null)}
        />
      ) : null}
      </div>
    </div>
  );
}

/**
 * ⌘K 命令面板：上面一个输入框，下面是「搜到的任务 / 会话」+「操作」两组。
 * 空查询先给当前项目待办与真实最近访问，打字后保留原有项目搜索。
 * ↑↓ 在两组之间连续移动，回车执行，Esc 关。
 */
export function SearchPalette({
  projectId,
  accountId,
  canvas,
  onJump,
  onQuickOpen,
  onClose,
  actions = []
}: {
  projectId: string;
  accountId: string | null;
  canvas: CanvasDto | undefined;
  onJump: (hit: SearchHitDto) => void;
  onQuickOpen: (sessionId: string) => void;
  onClose: () => void;
  actions?: readonly PaletteAction[];
}) {
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [searchCursor, setSearchCursor] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const trimmed = query.trim();
  const attention = useQuery({ queryKey: ['attention'], queryFn: api.attention, refetchInterval: 10_000 });
  // 每次打开只取一次成员及顺序；实时数据仅用于更新或移除已有行。
  const [snapshot, setSnapshot] = useState<{ attention: string[]; recent: string[] } | null>(null);
  useEffect(() => {
    if (snapshot || !canvas || (!attention.data && !attention.isError)) return;
    setSnapshot(paletteSnapshot(accountId, projectId, canvas.sessions.map((session) => session.id), attention.data?.items ?? []));
  }, [snapshot, canvas, attention.data, attention.isError, projectId, accountId]);

  const sessions = new Map((canvas?.sessions ?? []).map((session) => [session.id, session]));
  const currentAttention = new Map((attention.data?.items ?? []).filter((item) => item.projectId === projectId).map((item) => [item.sessionId, item]));
  const waiting = (snapshot?.attention ?? []).flatMap((id) => {
    const item = currentAttention.get(id);
    return item && sessions.has(id) ? [item] : [];
  });
  const recent = (snapshot?.recent ?? []).flatMap((id) => {
    const session = sessions.get(id);
    return session ? [session] : [];
  });
  const quickHits: SearchHitDto[] = trimmed ? [] : [
    ...waiting.map((item) => ({ kind: 'session' as const, taskId: item.taskId, sessionId: item.sessionId, title: attentionTitle(item), snippet: item.possible ? '可能在等你' : PHASE_LABEL[item.phase] })),
    ...recent.map((session) => ({ kind: 'session' as const, taskId: session.taskId ?? '', sessionId: session.id, title: session.title?.trim() || `会话 ${session.id.slice(0, 6)}`, snippet: canvas?.tasks.find((task) => task.id === session.taskId)?.title ?? '没有任务' }))
  ];

  useEffect(() => {
    input.current?.focus();
  }, []);

  const results = useQuery({
    queryKey: ['search', projectId, trimmed],
    queryFn: () => api.search(projectId, trimmed),
    enabled: trimmed.length > 0
  });

  const hits = trimmed === '' ? quickHits : (results.data?.hits ?? []);
  const matched = filterActions(actions, trimmed);
  const total = hits.length + matched.length;
  const keys = [
    ...hits.map((hit, index) => trimmed ? `search:${hit.kind}:${hit.sessionId ?? hit.taskId}:${index}` : `quick:${hit.sessionId}`),
    ...matched.map((action) => `action:${action.id}`)
  ];
  // 已选行消失时不自动选择位置相同的另一行；用户可用方向键重新选择。
  useEffect(() => {
    if (!trimmed && selectedKey === null && snapshot && keys[0]) setSelectedKey(keys[0]);
  }, [selectedKey, trimmed, snapshot, keys[0]]);
  const cursor = trimmed ? searchCursor : selectedKey === null ? -1 : keys.indexOf(selectedKey);
  const select = (index: number) => trimmed ? setSearchCursor(index) : setSelectedKey(keys[index] ?? null);
  const pick = (index: number) => {
    if (index < 0) return;
    if (index < hits.length) {
      const hit = hits[index];
      if (hit && !trimmed && hit.sessionId) onQuickOpen(hit.sessionId);
      else if (hit) onJump(hit);
      return;
    }
    const action = matched[index - hits.length];
    if (action) {
      onClose();
      action.run();
    }
  };
  // 操作按组排，组头只在换组时出现
  let lastGroup = '';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-3 pt-16 md:pt-24" onClick={onClose}>
      <div
        role="dialog"
        aria-label="命令面板"
        className="flex max-h-[70vh] w-full max-w-[600px] flex-col overflow-hidden rounded-overlay border border-strong bg-overlay shadow-overlay"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-hair px-3">
          <Icon name="search" size={15} className="text-tertiary" />
          <input
            ref={input}
            className="min-h-12 min-w-0 flex-1 bg-transparent py-2.5 text-body text-primary outline-none placeholder:text-tertiary"
            placeholder="搜索任务或会话"
            aria-label="搜索任务或会话"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedKey(null);
              setSearchCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                select(Math.max(0, Math.min(cursor + 1, total - 1)));
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                select(cursor < 0 ? 0 : Math.max(cursor - 1, 0));
              }
              if (event.key === 'Enter') pick(Math.min(cursor, total - 1));
            }}
          />
          <kbd className="hidden shrink-0 rounded-[4px] border border-hair px-1.5 font-sans text-[11px] text-tertiary sm:inline">Esc</kbd>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {trimmed !== '' ? (
            hits.length === 0 ? (
              <p className="px-3 py-3 text-meta text-tertiary">{results.isFetching ? '搜索中…' : '没有命中的任务或会话。'}</p>
            ) : (
              <>
                <p className="px-3 pb-1 pt-1.5 text-[11px] text-tertiary">任务与会话</p>
                {hits.map((hit, index) => (
                  <button
                    key={`${hit.kind}-${hit.sessionId ?? hit.taskId}-${index}`}
                    className={`mx-1 block w-[calc(100%-0.5rem)] rounded-control px-2.5 py-2 text-left ${index === cursor ? 'bg-selected' : ''}`}
                    onMouseEnter={() => select(index)}
                    onClick={() => onJump(hit)}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="shrink-0 text-meta text-tertiary">{hit.kind === 'task' ? '任务' : '会话'}</span>
                      <span className="min-w-0 truncate text-body text-primary">{hit.title}</span>
                    </span>
                    {hit.snippet === '' ? null : (
                      <span className="mt-0.5 block truncate text-meta text-tertiary">{hit.snippet}</span>
                    )}
                  </button>
                ))}
              </>
            )
          ) : (
            <>
              {(['等我处理', '最近会话'] as const).map((group, groupIndex) => {
                const start = groupIndex === 0 ? 0 : waiting.length;
                const groupHits = groupIndex === 0 ? quickHits.slice(0, waiting.length) : quickHits.slice(waiting.length);
                return (
                  <section key={group} aria-label={group} data-testid={groupIndex === 0 ? 'palette-attention' : 'palette-recent'}>
                    <p className="px-3 pb-1 pt-2 text-[11px] text-tertiary">{group}</p>
                    {groupHits.length === 0 ? <p className="px-3 py-1.5 text-meta text-tertiary">{!snapshot ? '载入中…' : groupIndex === 0 && attention.isError ? '待办暂时无法加载' : groupIndex === 0 ? '当前项目没有待办' : '还没有最近打开的会话'}</p> : groupHits.map((hit, offset) => {
                      const index = start + offset;
                      return <button key={hit.sessionId} type="button" data-testid="palette-quick-session" data-session-id={hit.sessionId} className={`mx-1 flex min-h-[44px] w-[calc(100%-0.5rem)] items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left ${index === cursor ? 'bg-selected' : ''}`} onMouseEnter={() => select(index)} onClick={() => pick(index)}>
                        <Icon name="message" size={14} className="shrink-0 text-tertiary" />
                        <span className="min-w-0 flex-1 truncate text-body text-primary">{hit.title}</span>
                        <span className={`max-w-[40%] truncate text-meta ${groupIndex === 0 ? 'text-rust' : 'text-tertiary'}`}>{hit.snippet}</span>
                      </button>;
                    })}
                  </section>
                );
              })}
            </>
          )}
          {matched.map((action, offset) => {
            const index = hits.length + offset;
            const header = action.group !== lastGroup ? action.group : null;
            lastGroup = action.group;
            return (
              <div key={action.id}>
                {header ? <p className="px-3 pb-1 pt-2 text-[11px] text-tertiary">{header}</p> : null}
                <button
                  data-testid="palette-action"
                  className={`mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-body ${
                    index === cursor ? 'bg-selected text-primary' : 'text-secondary'
                  }`}
                  onMouseEnter={() => select(index)}
                  onClick={() => pick(index)}
                >
                  <Icon name={action.icon ?? 'command'} size={14} className="text-tertiary" />
                  <span className="min-w-0 flex-1 truncate">{action.label}</span>
                  {action.keys ? (
                    <kbd className="shrink-0 rounded-[4px] border border-hair px-1.5 font-sans text-[11px] text-tertiary">{action.keys}</kbd>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
        <p className="hidden items-center gap-3 border-t border-hair px-3 py-1.5 text-[11px] text-tertiary sm:flex">
          <span>↑↓ 选择</span>
          <span>↵ 打开</span>
          <span>{modKeyLabel()}K 开关</span>
        </p>
      </div>
    </div>
  );
}

/** 组内按开始时间排。行标题用第一句话；预览只有最近几条，第一句另存在 openings 里。分组本身见 atoms/session-groups.ts。 */
