import { modelLabel } from '../../atoms/model-label.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { localTime } from '../../shell/local-time.ts';
import { useQuery } from '@tanstack/react-query';
import type { CanvasDto, SearchHitDto, SessionDto, TaskDto } from '../../shell/api.ts';
import { api } from '../../shell/api.ts';
import { groupSessions } from '../../atoms/session-groups.ts';
import { useCoordinators } from '../../shell/coordinators.ts';
import type { LiveMap } from '../../atoms/live.ts';
import { StatusPill } from '../../atoms/status.tsx';
import { NoTasksHint } from './empty-tasks.tsx';
import { resolveWorker, useWorkers, WorkerChip } from '../../shell/workers.tsx';
import { workspaceName } from '../../atoms/workspace-format.ts';
import { Icon } from '../../atoms/icons.tsx';
import { modKeyLabel } from '../../shell/device.ts';
import { filterActions, type PaletteAction } from './palette.ts';
import { RowMenu } from '../../atoms/row-menu.tsx';
import { DeleteSessionDialog } from '../../atoms/delete-session-dialog.tsx';
import { sessionActionItems } from '../../atoms/session-actions.ts';
import { useSessionActions } from '../../atoms/use-session-actions.ts';
import { waitingForReply } from '../../atoms/live-core.ts';
import { UndoToast } from '../../atoms/undo-toast.tsx';
import { TaskBadge } from './task-detail.tsx';
export type { PaletteAction } from './palette.ts';


function statusOf(session: SessionDto, live: LiveMap): SessionDto['status'] {
  return live[session.id]?.status ?? session.status;
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
  onDerive,
  onTaskDetail,
  onNewTask,
  onChanged,
  focusTaskId
}: {
  canvas: CanvasDto;
  /** 已归档任务：日常分组里不出现，只在底部折叠区里等着恢复。 */
  archivedTasks?: readonly TaskDto[];
  live: LiveMap;
  onOpen: (sessionId: string) => void;
  onDerive: (taskId: string) => void;
  onTaskDetail: (taskId: string) => void;
  onNewTask: () => void;
  /** 删掉会话之后让外层重拉画布；外层还会顺手把这条会话从缓存里摘掉。 */
  onChanged: () => void;
  /** 刚建好的任务：列表滚到这一行，别让「创建成功」只停在 toast 里。 */
  focusTaskId?: string | null;
}) {
  // 主会话的姓名来自登记表：没有它，无任务会话只能说「没有任务的会话」。
  const { ids: coordinatorIds } = useCoordinators(canvas.project.id);
  const groups = useMemo(() => groupSessions(canvas, coordinatorIds), [canvas, coordinatorIds]);
  const unstartedTasks = useMemo(() => {
    const started = new Set(canvas.sessions.map((session) => session.taskId).filter((taskId) => taskId !== null));
    return canvas.tasks.filter(
      (task) => !started.has(task.id) && task.status !== 'done' && task.status !== 'abandoned'
    );
  }, [canvas.sessions, canvas.tasks]);
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

  async function stopSession(session: SessionDto, label: string): Promise<void> {
    setBusyId(session.id);
    setNotice(null);
    try {
      await api.interrupt(session.id);
      onChanged();
      setNotice({ message: `已停止「${label}」`, actionLabel: '关闭', action: () => setNotice(null) });
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
      await api.archiveTask(task.id, next);
      onChanged();
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
      <div className="mb-3 border-b border-hair pb-2" data-testid="list-context">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-meta text-tertiary">项目</span>
          <span className="min-w-0 truncate text-sub text-primary" title={canvas.project.name}>{canvas.project.name}</span>
        </div>
        <div className="mt-0.5 text-meta text-tertiary">
          {canvas.tasks.length} 个任务 · {canvas.sessions.length} 条会话
        </div>
      </div>
      {canvas.sessions.length === 0 ? (
        <p className="py-6 text-meta text-tertiary">还没有会话。从任务行点「开始会话」，或点下面的任务派生一条。</p>
      ) : null}
      {unstartedTasks.length > 0 ? (
        <section className="mb-4" aria-label="未开始的任务" data-testid="list-unstarted">
          <h3 className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-hair bg-canvas/95 py-2 text-sub text-primary backdrop-blur">
            <span className="min-w-0 truncate">未开始</span>
            <span className="shrink-0 text-meta text-tertiary">{unstartedTasks.length} 个任务</span>
          </h3>
          <ul>
            {unstartedTasks.map((task) => (
              <li
                key={task.id}
                data-testid="list-task-row"
                data-task-id={task.id}
                className="flex flex-wrap items-center gap-2 border-b border-hair/60 py-2 pl-3 pr-1"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-body text-primary" title={task.title}>{task.title}</span>
                    <TaskBadge status={task.status} />
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
            ))}
          </ul>
        </section>
      ) : null}
      {groups.map((group) => (
        <section
          key={group.taskId}
          className="mb-4"
          // 无任务组没有任务标题：读屏也只念组名，不假装它是一条任务
          aria-label={group.taskless ? group.title : `任务：${group.title}`}
          data-testid="list-task-group"
          data-kind={group.kind}
        >
          <h3 className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-hair bg-canvas/95 py-2 text-sub text-primary backdrop-blur">
            {group.taskless ? null : <span className="shrink-0 text-meta text-tertiary">任务</span>}
            <span className="min-w-0 truncate">{group.title}</span>
            <span className="shrink-0 text-meta text-tertiary">{group.sessions.length} 条会话</span>
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
                      <span className="block truncate text-body text-primary" data-testid="list-session-label">{label}</span>
                      <span className="block truncate text-meta text-tertiary" data-testid="list-session-meta">
                        {localTime(session.createdAt)} · {origin} · {agentLabel(session.agentId)}
                      </span>
                      <span className="mt-1 flex min-w-0 items-center gap-1.5" data-testid="list-session-place">
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
                    aria-label={`会话「${label}」的操作`}
                    aria-haspopup="menu"
                    aria-expanded={menu?.sessionId === session.id}
                    title="会话操作"
                    className="flex size-[44px] shrink-0 items-center justify-center self-center rounded-sm text-body text-tertiary hover:bg-card hover:text-primary focus-visible:bg-card md:size-8"
                    onClick={(event) => {
                      trigger.current = event.currentTarget;
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenu({ sessionId: session.id, label, x: rect.right - 168, y: rect.bottom + 2 });
                    }}
                  >
                    <Icon name="more" size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

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

      <div className="mt-6 border-t border-hair pt-3">
        <p className="mb-2 text-meta text-secondary">任务 · 点一下从它再开一条会话</p>
        {canvas.tasks.length === 0 ? (
          <NoTasksHint onNewTask={onNewTask} />
        ) : null}
        <div className="flex flex-wrap gap-2">
          {canvas.tasks.map((task) => (
            <span key={task.id} className="inline-flex items-stretch">
              <button
                className="rounded-l-sm border border-hair px-2.5 py-1.5 text-sub text-secondary hover:border-strong hover:text-primary"
                onClick={() => onDerive(task.id)}
                title="从这个任务派生一条会话"
              >
                {task.title}
                {task.status === 'abandoned' ? '（已放弃）' : ''}
              </button>
              <button
                className="rounded-r-sm border border-l-0 border-hair px-2 text-meta text-tertiary hover:border-strong hover:text-primary"
                onClick={() => onTaskDetail(task.id)}
                aria-label={`${task.title} 的日志`}
              >
                日志
              </button>
            </span>
          ))}
        </div>
      </div>

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
 * 空着时只列操作（跳转、切视图、新建、主题）；打字后先给搜索命中，再给名字对得上的操作。
 * ↑↓ 在两组之间连续移动，回车执行，Esc 关。
 */
export function SearchPalette({
  projectId,
  onJump,
  onClose,
  actions = []
}: {
  projectId: string;
  onJump: (hit: SearchHitDto) => void;
  onClose: () => void;
  actions?: readonly PaletteAction[];
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const trimmed = query.trim();

  useEffect(() => {
    input.current?.focus();
  }, []);

  const results = useQuery({
    queryKey: ['search', projectId, trimmed],
    queryFn: () => api.search(projectId, trimmed),
    enabled: trimmed.length > 0
  });

  const hits = trimmed === '' ? [] : (results.data?.hits ?? []);
  const matched = filterActions(actions, trimmed);
  const total = hits.length + matched.length;
  const pick = (index: number) => {
    if (index < hits.length) {
      const hit = hits[index];
      if (hit) onJump(hit);
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
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setCursor((current) => Math.min(current + 1, total - 1));
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setCursor((current) => Math.max(current - 1, 0));
              }
              if (event.key === 'Enter') pick(cursor);
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
                    onMouseEnter={() => setCursor(index)}
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
          ) : null}
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
                  onMouseEnter={() => setCursor(index)}
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
