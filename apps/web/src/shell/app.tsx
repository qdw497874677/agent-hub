import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AttachmentInputDto, CanvasDto, ProjectDto, PromptAckDto, SessionDto, TaskDto } from './api.ts';
import { api, RequestFailed } from './api.ts';
import { projectKeys } from './query-keys.ts';
import { HomePage } from '../surfaces/workbench/home.tsx';
import { AdminPage } from './admin/page.tsx';
import { MachinesPage } from './machines.tsx';
import { resolveLive, useLiveStream } from '../atoms/live.ts';
import { CanvasView, type LayoutPatch } from '../surfaces/workbench/canvas.tsx';
import { NoTasksHint } from '../surfaces/workbench/empty-tasks.tsx';
import { ListView, SearchPalette, type PaletteAction } from '../surfaces/workbench/views.tsx';
import { setThemePref } from './theme.ts';
import { FocusView } from '../surfaces/workbench/focus.tsx';
import { DeriveDialog, NewTaskDialog } from './dialogs.tsx';
import { CoordinatorDialog } from '../surfaces/workbench/coordinator-dialog.tsx';
import { ProjectHeader } from '../surfaces/workbench/header.tsx';
import { ProjectSidebar, TOGGLE_SIDEBAR_EVENT } from '../surfaces/workbench/sidebar.tsx';
import { ProjectBar } from '../surfaces/workbench/view-switch.tsx';
import { useRoute } from './use-route.ts';
import { MemoryPage } from './memory.tsx';
import { AccessPage } from './access-page.tsx';
import { TeamWorkspacesPage } from '../surfaces/workbench/team-workspaces.tsx';
import { MessagesPage } from '../surfaces/im/messages.tsx';
import { BotsPage } from '../surfaces/im/bots.tsx';
import { ObservePage } from './observe.tsx';
import { MarketPage } from './market/page.tsx';
import { modKeyLabel, useNarrow } from './device.ts';
import { Sheet } from './dialog-shell.tsx';
import { TaskDetail } from '../surfaces/workbench/task-detail.tsx';
import { UndoToast } from '../atoms/undo-toast.tsx';
import { splitArchivedTasks } from '../atoms/task-display.ts';
import { patchCanvasTask } from './confirmed-patch.ts';
import { clearOptionFeedback, optionFeedbackIsCurrent, setOptionFeedback } from '../atoms/option-feedback.tsx';
import type { View } from './route.ts';
import { useAccount } from './account-context.ts';
import { rememberPaletteRecent } from '../surfaces/workbench/palette-recent.ts';
import { NewSessionWithModelContext } from './new-session-with-model.ts';
import { NewModelSessionDialog } from './new-model-session-dialog.tsx';

const LAST_PROJECT = 'agent-hub:last-project';

/** 运营后台与工作台互不相干：分开渲染，各自的数据各自拉。 */
export function App() {
  const [route] = useRoute();
  if (route?.page === 'machines') return <MachinesPage workerId={route.workerId} tab={route.tab} />;
  if (route?.page === 'workspaces') return <TeamWorkspacesPage />;
  if (route?.page === 'memory') return <MemoryPage scope={route.scope} />;
  if (route?.page === 'access') return <AccessPage />;
  if (route?.page === 'bots') return <BotsPage projectId={route.projectId} />;
  if (route?.page === 'observe') return <ObservePage source={route.source} id={route.id} />;
  if (route?.page === 'messages') return <MessagesPage projectId={route.projectId} groupId={route.groupId} />;
  if (route?.page === 'assets') return <MarketPage tab={route.tab} reviewId={route.reviewId} />;
  // 「机器」以前在运营后台里（#/admin/workers）。老书签直接换到新家，且要赶在管理员门禁前面，
  // 否则非管理员会先撞上「只有 hub 管理员能进运营后台」。
  if (route?.page === 'admin' && route.tab === 'workers') return <RedirectToMachines />;
  return route?.page === 'admin' ? <AdminPage tab={route.tab} /> : <Workspace />;
}

function RedirectToMachines() {
  const [, navigate] = useRoute();
  useEffect(() => {
    navigate({ page: 'machines', workerId: null, tab: null }, 'replace');
  }, [navigate]);
  return null;
}

function Workspace() {
  const [route, navigate] = useRoute();
  const account = useAccount();
  // 项目默认落在列表：画布是刻意进去看的全局关系，不是每次打开项目的必经页。
  const narrow = useNarrow();
  const homeView: View = 'list';
  const [newTask, setNewTask] = useState(false);
  const [createdTask, setCreatedTask] = useState<TaskDto | null>(null);
  // 新开主会话（不是任务）：入口在侧栏动作区，和新建任务并排。
  const [newCoordinator, setNewCoordinator] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [windowFocus, setWindowFocus] = useState<string | null>(null);
  const [deriveFor, setDeriveFor] = useState<string | null>(null);
  const [newModelSession, setNewModelSession] = useState<{ projectId: string; source: SessionDto; model: string } | null>(null);
  const [taskDetail, setTaskDetail] = useState<string | null>(null);
  const [search, setSearch] = useState(false);
  // 草稿存在 App 层而不是 Inspector 里：S6.4 要求切视图不丢草稿，
  // 组件一卸载 useState 就没了，所以它必须活在两者之上。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 跳到某个节点：nonce 让「同一条命中点第二次」也能重新居中。
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  // 侧栏菜单「在画布中展开」：切到画布后由画布自己开窗口（窗口状态在画布里）。
  const [expandRequest, setExpandRequest] = useState<{ id: string; nonce: number } | null>(null);
  const clearExpandRequest = useCallback(() => setExpandRequest(null), []);
  const queryClient = useQueryClient();

  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const projectRoute = route?.page === 'project' ? route : null;
  // Workspace 在首页和项目之间复用；离开项目或切换项目时不要把旧抽屉带回来。
  useEffect(() => { setSidebarOpen(false); }, [projectRoute?.projectId]);
  const project = useMemo(
    () => (projectRoute ? (projects.data ?? []).find((candidate) => candidate.id === projectRoute.projectId) ?? null : null),
    [projectRoute, projects.data]
  );
  // 三种视图是同一份数据的三层分辨率（S6.4）：画布看关系，列表看清单，专注对话看内容。
  // 视图和选中的会话都住在地址栏里（route.ts），刷新、返回手势都不丢。
  const view: View = projectRoute?.view ?? homeView;
  const selected = projectRoute?.sessionId ?? null;

  useEffect(() => {
    if (!projects.data) return;
    if (route === null) {
      // 只认「上次打开的那个」。没有就停在首页——不替用户挑一个看起来像的项目。
      const remembered = projects.data.find((candidate) => candidate.id === localStorage.getItem(LAST_PROJECT));
      navigate(
        remembered ? { page: 'project', projectId: remembered.id, view: homeView, sessionId: null } : { page: 'home' },
        'replace'
      );
    } else if (projectRoute && !project && !projects.isFetching) {
      // 刚建好的项目可能还没进缓存：等这轮拉取结束再判「不存在」，否则会被踢回首页。
      navigate({ page: 'home' }, 'replace');
    }
  }, [route, projectRoute, project, projects.data, projects.isFetching, navigate, homeView]);

  const goProject = useCallback(
    (picked: ProjectDto, next: View, sessionId: string | null, state?: unknown) => {
      localStorage.setItem(LAST_PROJECT, picked.id);
      navigate({ page: 'project', projectId: picked.id, view: next, sessionId }, 'push', state);
    },
    [navigate]
  );

  const setView = useCallback(
    (next: View) => {
      if (projectRoute) navigate({ ...projectRoute, view: next });
    },
    [projectRoute, navigate]
  );

  const canvas = useQuery({
    queryKey: projectKeys.canvas(project?.id),
    queryFn: ({ signal }) => api.canvas(project?.id ?? '', signal),
    enabled: project !== null,
    // Worker 还没上线时自己轮询：别让「等 worker」变成用户要记住的手动刷新
    refetchInterval: (query) => ((query.state.data?.agents.length ?? 0) === 0 ? 2000 : false)
  });

  // 列表 / 画布 / 侧栏只看未归档任务；直接会话链接、任务详情和搜索仍用上面的原始 canvas。
  const display = useMemo(() => (canvas.data ? splitArchivedTasks(canvas.data) : null), [canvas.data]);

  const refresh = useCallback(() => {
    if (project) void queryClient.invalidateQueries({ queryKey: projectKeys.canvas(project.id) });
  }, [project, queryClient]);

  /**
   * 归档回执只负责 archivedAt：先掐掉可能在飞的旧画布请求，再把这一条并进缓存。
   * 不整张重拉——列表不该为一次归档等一圈网络，旧响应也不该把刚改的投影盖回去；
   * 任务其余字段可能比回执新（SSE 已推过），合并时保留它们。
   * 没有回执的调用（删会话、分叉等）仍走原来的刷新。
   */
  const applyTask = useCallback(
    async (task?: TaskDto) => {
      if (!project || !task) {
        refresh();
        return;
      }
      await queryClient.cancelQueries({ queryKey: projectKeys.canvas(project.id) });
      queryClient.setQueryData<CanvasDto>(projectKeys.canvas(project.id), (current) =>
        current ? patchCanvasTask(current, task) : current
      );
    },
    [project, queryClient, refresh]
  );

  // 列表上的「刷新」：真的再拉一次，而且等它落地才算完（按钮转圈、期间禁用）。
  // 顺手把项目清单也刷一遍——顶栏的项目名/数量就在那份数据里。
  const refreshList = useCallback(async () => {
    const results = await Promise.all([canvas.refetch(), projects.refetch()]);
    const failed = results.find((result) => result.error !== null);
    if (failed?.error) throw failed.error;
  }, [canvas, projects]);

  // 内存里的会话流：先用画布投影的历史播种，之后只吃比它新的帧；断线重连后补帧并刷新画布。
  const { live, seed, loadHistory, history, sync, retrySync, state: stream } = useLiveStream(refresh);

  const seedRef = useRef(seed);
  seedRef.current = seed;
  useEffect(() => {
    const data = canvas.data;
    if (!data) return;
    seedRef.current(data.sessions, data.previews ?? {});
  });

  // 画布卡片上就地说话：发完清掉这张卡的草稿，不走「先选中再进对话」那条路。
  // clientMessageId 由卡片自己的乐观气泡生成，重试沿用同一个；把它透传给服务端才能对账。
  const sendPrompt = useCallback(
    async (
      sessionId: string,
      text: string,
      clientMessageId: string,
      attachments: readonly AttachmentInputDto[] = []
    ): Promise<PromptAckDto> => {
      // 先清草稿再等回复：等的这段时间卡片若被画布重新挂载，不该把刚发出去的话又填回输入框
      // （e2e 偶发失败就是它：模型慢时输入框里又出现了原话，看着像没发出去）。没发出去再放回来。
      setDrafts((current) => ({ ...current, [sessionId]: '' }));
      let ack: PromptAckDto;
      try {
        ack = await api.prompt(sessionId, text, [...attachments], clientMessageId);
      } catch (failure) {
        setDrafts((current) => ({ ...current, [sessionId]: current[sessionId] || text }));
        throw failure;
      }
      refresh();
      return ack;
    },
    [refresh]
  );

  // 同一会话连点两下：只认最后一次请求的回执，别让先到的旧配置盖住后选的。
  const optionLifetime = useRef({ active: true });
  useEffect(() => {
    const lifetime = { active: true };
    optionLifetime.current = lifetime;
    return () => {
      lifetime.active = false;
      clearOptionFeedback();
    };
  }, []);

  /**
   * 改可调项：回执是服务端落库后的快照，可能仍是旧值（agent 超时没确认）。
   * 所以只并这条请求负责的 model/options/optionSpec，成功与否都看回执，不假装已切到目标。
   */
  const changeOption = useCallback(
    async (sessionId: string, optionId: string, value: string | boolean) => {
      const projectId = project?.id;
      const snapshot = queryClient.getQueryData<SessionDto>(['session', sessionId]) ??
        (projectId ? queryClient.getQueryData<CanvasDto>(projectKeys.canvas(projectId))?.sessions.find((item) => item.id === sessionId) : undefined);
      const option = snapshot?.optionSpec.find((item) => item.id === optionId);
      if (option) {
        const request = Symbol();
        const lifetime = optionLifetime.current;
        const original = option.category === 'model' ? option.current : snapshot?.options[optionId] ?? option.current;
        const latest = () => lifetime.active && optionFeedbackIsCurrent(sessionId, optionId, request);
        let readSequence = 0;
        // 只合并运行时选项，不覆盖草稿或其他会话字段；读期间独立改变的设置保留本地新值。
        const readOptions = async (isCurrent: () => boolean = () => true) => {
          const key = projectId ? projectKeys.canvas(projectId) : undefined;
          const canvasBefore = key ? queryClient.getQueryData<CanvasDto>(key)?.sessions.find((item) => item.id === sessionId) : undefined;
          const sessionBefore = queryClient.getQueryData<SessionDto>(['session', sessionId]);
          const observed = await api.session(sessionId);
          if (!latest() || !isCurrent()) return undefined;
          const merge = (current: SessionDto, before: SessionDto | undefined): SessionDto => {
            if (!before || current.updatedAt > observed.updatedAt) return current;
            const changed = (id: string) => current.options[id] !== before.options[id] ||
              current.optionSpec.find((item) => item.id === id)?.current !== before.optionSpec.find((item) => item.id === id)?.current;
            const options = { ...current.options };
            for (const [id, next] of Object.entries(observed.options)) if (!changed(id)) options[id] = next;
            const optionSpec = observed.optionSpec.map((item) => {
              const existing = current.optionSpec.find((candidate) => candidate.id === item.id);
              return existing && changed(item.id) ? { ...item, current: existing.current } : item;
            });
            for (const item of current.optionSpec) if (changed(item.id) && !optionSpec.some((candidate) => candidate.id === item.id)) optionSpec.push(item);
            return { ...current, updatedAt: observed.updatedAt, model: current.model === before.model ? observed.model : current.model, options, optionSpec };
          };
          if (key) queryClient.setQueryData<CanvasDto>(key, (current) => current ? { ...current, sessions: current.sessions.map((item) => item.id === sessionId ? merge(item, canvasBefore) : item) } : current);
          queryClient.setQueryData<SessionDto>(['session', sessionId], (current) => current ? merge(current, sessionBefore) : current);
          return observed;
        };
        const recheck = () => {
          if (!latest()) return;
          const read = ++readSequence;
          void readOptions(() => read === readSequence).then((observed) => {
            if (!latest() || read !== readSequence) return;
            const current = observed?.optionSpec.find((item) => item.id === optionId)?.current;
            setOptionFeedback(sessionId, optionId, { state: 'unconfirmed', target: value, original, ...(current !== undefined && current !== '' ? { observed: current } : {}), recheck, requestToken: request });
          }).catch(() => {
            if (latest() && read === readSequence) setOptionFeedback(sessionId, optionId, { state: 'unconfirmed', target: value, original, recheck, requestToken: request });
          });
        };
        setOptionFeedback(sessionId, optionId, { state: 'pending', target: value, original, requestToken: request });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const receipt = await Promise.race([
            api.changeOptionWithReceipt(sessionId, optionId, value),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 12000); })
          ]);
          if (!latest()) return;
          // A confirmed receipt must actually identify the requested setting.
          const observed = option.category === 'model' ? receipt.session.optionSpec.find((item) => item.id === optionId)?.current : receipt.session.options[optionId] ?? receipt.session.optionSpec.find((item) => item.id === optionId)?.current;
          const state = receipt.state === 'confirmed' && option.category === 'model' && observed !== value ? 'unconfirmed' : receipt.state;
          if (state === 'confirmed' || state === 'saved') {
            await Promise.all([
              projectId ? queryClient.cancelQueries({ queryKey: projectKeys.canvas(projectId) }) : undefined,
              queryClient.cancelQueries({ queryKey: ['session', sessionId] })
            ]);
            if (!latest()) return;
            // Only merge this option, and never replace a newer session projection.
            const patch = (current: SessionDto) => current.updatedAt > receipt.session.updatedAt ? current : {
              ...current,
              updatedAt: receipt.session.updatedAt,
              ...(option.category === 'model' ? { model: receipt.session.model } : {}),
              options: receipt.session.options[optionId] !== undefined
                ? { ...current.options, [optionId]: receipt.session.options[optionId] }
                : current.options,
              optionSpec: state === 'confirmed' ? current.optionSpec.map((item) => item.id === optionId ? (receipt.session.optionSpec.find((candidate) => candidate.id === optionId) ?? item) : item) : current.optionSpec
            };
            if (projectId) queryClient.setQueryData<CanvasDto>(projectKeys.canvas(projectId), (current) => current ? { ...current, sessions: current.sessions.map((item) => item.id === sessionId ? patch(item) : item) } : current);
            queryClient.setQueryData<SessionDto>(['session', sessionId], (current) => current ? patch(current) : current);
          }
          setOptionFeedback(sessionId, optionId, { state, target: value, original, requestToken: request, ...(state === 'unconfirmed' ? { recheck } : {}) });
          if (state === 'confirmed' && option.category === 'model') {
            const read = ++readSequence;
            void readOptions(() => read === readSequence).catch(() => {});
          }
        } catch {
          if (latest()) setOptionFeedback(sessionId, optionId, { state: 'unconfirmed', target: value, original, recheck, requestToken: request });
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        return;
      }
    },
    [project, queryClient]
  );

  // 停止只是「已经请求」：真正结束以运行时回来的状态帧为准，这里只刷新拿服务端证据。
  const interruptSession = useCallback(
    async (sessionId: string) => {
      await api.interrupt(sessionId);
      refresh();
    },
    [refresh]
  );

  // 会话状态变化时刷新画布：卡片状态位由 canvas 数据 + live 帧共同决定。
  useEffect(() => {
    if (Object.keys(live).length === 0) return;
    const timer = setTimeout(refresh, 900);
    return () => clearTimeout(timer);
  }, [live, refresh]);

  /** 进会话说话。画布卡上的「对话」/双击、列表里点行、首页点最近会话，都走这里。 */
  const openSession = useCallback(
    (sessionId: string) => {
      if (!projectRoute) return;
      const existing = window.history.state as { returnTo?: string; fromHub?: boolean } | null;
      const state = {
        fromHub: true,
        returnTo: (projectRoute.view === 'focus' ? existing?.returnTo : null) ?? window.location.hash
      };
      // 已经在会话里换会话用 replace：历史里只留「来源 → 当前会话」，返回键仍然回来源。
      navigate(
        { ...projectRoute, view: 'focus', sessionId },
        projectRoute.view === 'focus' ? 'replace' : 'push',
        state
      );
    },
    [projectRoute, navigate]
  );

  /** 会话里的「返回」：从应用里进来的按历史回来源；直链进来没有来源，退回列表。 */
  const backFromFocus = useCallback(() => {
    const state = window.history.state as { fromHub?: boolean } | null;
    if (state?.fromHub) {
      window.history.back();
      return;
    }
    if (projectRoute) {
      navigate({ ...projectRoute, view: 'list', sessionId: null }, 'replace');
    } else {
      navigate({ page: 'home' }, 'replace');
    }
  }, [projectRoute, navigate]);

  const setTaskStatus = useCallback(
    (taskId: string, status: TaskDto['status']) => {
      void api.setTaskStatus(taskId, status).then(refresh, () => undefined);
    },
    [refresh]
  );

  const saveLayout = useMemo(
    () => (patch: LayoutPatch) => {
      if (!project) return;
      void api.saveLayout(project.id, patch);
    },
    [project]
  );

  // 连线只改画布上的边：直接补缓存，别再拉一次整张画布（大项目一次 400KB+）。
  const linkSessions = useCallback(
    async (aSessionId: string, bSessionId: string) => {
      if (!project) return;
      const link = await api.createSessionLink(project.id, aSessionId, bSessionId);
      queryClient.setQueryData<CanvasDto>(projectKeys.canvas(project.id), (current) => {
        if (!current || current.edges.some((edge) => edge.kind === 'link' && edge.aSessionId === link.aSessionId && edge.bSessionId === link.bSessionId)) return current;
        return { ...current, edges: [...current.edges, { kind: 'link' as const, aSessionId: link.aSessionId, bSessionId: link.bSessionId }] };
      });
    },
    [project, queryClient]
  );

  const unlinkSessions = useCallback(
    async (aSessionId: string, bSessionId: string) => {
      if (!project) return;
      await api.deleteSessionLink(project.id, aSessionId, bSessionId);
      queryClient.setQueryData<CanvasDto>(projectKeys.canvas(project.id), (current) =>
        current
          ? {
              ...current,
              edges: current.edges.filter(
                (edge) =>
                  !(
                    edge.kind === 'link' &&
                    ((edge.aSessionId === aSessionId && edge.bSessionId === bSessionId) || (edge.aSessionId === bSessionId && edge.bSessionId === aSessionId))
                  )
              )
            }
          : current
      );
    },
    [project, queryClient]
  );

  const inCanvas = useMemo(
    () => canvas.data?.sessions.find((session) => session.id === selected) ?? null,
    [canvas.data, selected]
  );
  // 侧聊不进画布，单开一条查询取它；其它会话一律以画布为准。
  const sideSession = useQuery({
    queryKey: ['session', selected],
    queryFn: () => api.session(selected ?? ''),
    enabled: selected !== null && canvas.data !== undefined && inCanvas === null,
    retry: false,
    staleTime: 5_000
  });
  const selectedSession = inCanvas ?? sideSession.data ?? null;

  // 只在会话已获服务端确认、且真的进入对话时记一次；直链和首页入口也包含在内。
  useEffect(() => {
    if (account && project && view === 'focus' && selectedSession?.id === selected) {
      rememberPaletteRecent(account.id, project.id, selectedSession.id);
    }
  }, [account?.id, project?.id, view, selected, selectedSession?.id]);

  // 专注对话要整段历史：投影只带最后几十条事件，长一点的思考就把正文挤出去了。
  const focusedSession = view === 'focus' ? selectedSession : null;
  const loadHistoryRef = useRef(loadHistory);
  loadHistoryRef.current = loadHistory;
  useEffect(() => {
    if (focusedSession) void loadHistoryRef.current(focusedSession);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换会话时拉一次，之后靠 SSE
  }, [focusedSession?.id]);

  // 画布卡片与画布窗口也要整段历史（#105 说卡片能往上翻）：投影只带最后 24 条事件，
  // 一段回复就是几十个 delta，只靠它刷新后卡片上只剩最后一句的半截、前面的提问全没了。
  // 每条会话拉一次，之后靠 SSE；withFullHistory 不会让更新的内存倒退。
  const fullLoaded = useRef(new Set<string>());
  useEffect(() => {
    for (const session of canvas.data?.sessions ?? []) {
      if (fullLoaded.current.has(session.id)) continue;
      fullLoaded.current.add(session.id);
      void loadHistoryRef.current(session);
    }
  }, [canvas.data?.sessions]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearch((open) => !open);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const jump = useCallback(
    (taskId: string, sessionId: string | null) => {
      setSearch(false);
      if (!projectRoute) return;
      // 窄屏没有可用的画布，命中会话就直接进对话。
      const next: View = narrow ? (sessionId ? 'focus' : 'list') : 'canvas';
      navigate({ ...projectRoute, view: next, sessionId });
      setFocus({ id: sessionId ?? taskId, nonce: Date.now() });
    },
    [projectRoute, navigate, narrow]
  );

  if (projectRoute && !project) {
    return <div className="flex h-full items-center justify-center text-meta text-tertiary">载入中…</div>;
  }

  if (project === null) {
    return (
      <HomePage
        onOpen={(picked, sessionId) => {
          // 「接着干」= 直接进那条会话说话，不是先看画布再自己找。
          const state = sessionId ? { fromHub: true, returnTo: window.location.hash } : undefined;
          goProject(picked, sessionId ? 'focus' : homeView, sessionId ?? null, state);
          if (sessionId) setFocus({ id: sessionId, nonce: Date.now() });
        }}
        onOpenTask={(picked, taskId) => {
          // 任务命中先进项目的列表，再把任务日志/状态开成浮层；关掉浮层仍在列表，能接着看别的。
          goProject(picked, 'list', null);
          setTaskDetail(taskId);
        }}
      />
    );
  }

  const paletteActions: PaletteAction[] = [
    { id: 'new-task', group: '操作', label: '新建任务', icon: 'plus', keywords: 'new task xjrw', run: () => setNewTask(true) },
    { id: 'view-canvas', group: '操作', label: '切到画布', icon: 'grid', keywords: 'canvas', run: () => setView('canvas') },
    { id: 'view-list', group: '操作', label: '切到列表', icon: 'list', keywords: 'list', run: () => setView('list') },
    ...(selectedSession
      ? [{ id: 'view-focus', group: '操作', label: '切到会话', icon: 'message' as const, keywords: 'focus chat', run: () => setView('focus') }]
      : []),
    ...(narrow
      ? []
      : [
          {
            id: 'toggle-sidebar',
            group: '操作',
            label: '收起 / 展开侧栏',
            icon: 'panel' as const,
            keys: `${modKeyLabel()}B`,
            keywords: 'sidebar',
            run: () => window.dispatchEvent(new Event(TOGGLE_SIDEBAR_EVENT))
          }
        ]),
    { id: 'theme-auto', group: '主题', label: '主题：跟随系统', icon: 'monitor', keywords: 'theme auto', run: () => setThemePref('auto') },
    { id: 'theme-dark', group: '主题', label: '主题：深色', icon: 'moon', keywords: 'theme dark', run: () => setThemePref('dark') },
    { id: 'theme-light', group: '主题', label: '主题：浅色', icon: 'sun', keywords: 'theme light', run: () => setThemePref('light') },
    { id: 'go-home', group: '前往', label: '首页', icon: 'home', keywords: 'home', run: () => navigate({ page: 'home' }) },
    { id: 'go-machines', group: '前往', label: '机器', icon: 'server', keywords: 'machines workers', run: () => navigate({ page: 'machines', workerId: null, tab: null }) },
    { id: 'go-memory', group: '前往', label: '记忆', icon: 'brain', keywords: 'memory', run: () => navigate({ page: 'memory', scope: null }) },
    { id: 'go-assets', group: '前往', label: '资产', icon: 'package', keywords: 'assets market', run: () => navigate({ page: 'assets', tab: 'catalog', reviewId: null }) },
    { id: 'go-workspaces', group: '前往', label: '团队工作目录', icon: 'folder', keywords: 'workspaces', run: () => navigate({ page: 'workspaces' }) },
    { id: 'go-bots', group: '前往', label: 'Bot', icon: 'bot', keywords: 'bots', run: () => navigate({ page: 'bots', projectId: project.id }) },
    { id: 'go-messages', group: '前往', label: '消息', icon: 'chat', keywords: 'messages im', run: () => navigate({ page: 'messages', projectId: project.id, groupId: null }) },
    { id: 'go-observe', group: '前往', label: '运行记录', icon: 'activity', keywords: 'observe runs', run: () => navigate({ page: 'observe', source: null, id: null }) }
  ];

  const sidebar = (onClose?: () => void) => (
    <ProjectSidebar
      project={project}
      projects={projects.data ?? []}
      selectedId={onClose && view === 'canvas' ? windowFocus : selected}
      canvas={display?.canvas ?? null}
      live={live}
      onInterrupt={interruptSession}
      onExpandSession={(sessionId) => {
        onClose?.();
        setExpandRequest({ id: sessionId, nonce: Date.now() });
        setView('canvas');
      }}
      onHome={() => {
        onClose?.();
        setDrafts({});
        navigate({ page: 'home' });
      }}
      onSwitchProject={(picked) => {
        onClose?.();
        setDrafts({});
        goProject(picked, view === 'focus' ? homeView : view, null);
      }}
      onOpenSession={(sessionId) => {
        onClose?.();
        openSession(sessionId);
      }}
      onSearch={() => {
        onClose?.();
        setSearch(true);
      }}
      onNewTask={() => {
        onClose?.();
        setNewTask(true);
      }}
      onDerive={(taskId) => {
        onClose?.();
        setDeriveFor(taskId);
      }}
      onNewCoordinator={() => {
        onClose?.();
        setNewCoordinator(true);
      }}
      onClose={onClose}
    />
  );

  return (
    <NewSessionWithModelContext.Provider value={(source, model) => setNewModelSession({ projectId: project.id, source, model })}>
    <div className="flex h-full">
      <div className="hidden h-full lg:flex">{sidebar()}</div>
      {/* 手机/平板侧栏走同一个抽屉：Esc、焦点陷阱、外部点按关闭、关掉把焦点还给汉堡按钮。
          以前是个普通 div，键盘用户按 Esc 关不掉，Tab 还能跑到被遮住的页面里。 */}
      {sidebarOpen ? (
        <Sheet title="项目与导航" testId="nav-sheet" scroll={false} onClose={() => setSidebarOpen(false)}>
          {sidebar(() => setSidebarOpen(false))}
        </Sheet>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ProjectBar project={project} view={view} stream={stream} onView={setView} />
        <div className="lg:hidden">
          <ProjectHeader
            project={project}
            projects={projects.data ?? []}
            stream={stream}
            view={view}
            onView={setView}
            onMenu={() => setSidebarOpen(true)}
            onSwitchProject={(picked) => {
              setDrafts({});
              goProject(picked, view === 'focus' ? homeView : view, null);
            }}
            onSearch={() => setSearch(true)}
            onNewTask={() => setNewTask(true)}
          />
        </div>

      {view === 'focus' ? canvas.data && selectedSession ? (
        <FocusView
          canvas={canvas.data}
          session={selectedSession}
          live={resolveLive(selectedSession, canvas.data.previews[selectedSession.id] ?? [], live[selectedSession.id])}
          historyState={history[selectedSession.id] ?? 'loading'}
          onRetryHistory={() => void loadHistory(selectedSession)}
          syncState={sync[selectedSession.id]}
          onRetrySync={() => retrySync(selectedSession.id)}
          draft={drafts[selectedSession.id] ?? ''}
          onDraftChange={(text) => setDrafts((current) => ({ ...current, [selectedSession.id]: text }))}
          onBack={backFromFocus}
          onChanged={refresh}
          onOpenSession={openSession}
          onSeedDraft={(id, text) => setDrafts((current) => ({ ...current, [id]: text }))}
          artifacts={canvas.data.artifacts.filter((artifact) => artifact.sessionId === selectedSession.id)}
          onChangeOption={(optionId, value) =>
            changeOption(selectedSession.id, optionId, value)
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6" data-testid="session-route-state">
          <div className="max-w-sm space-y-3 text-center" role={canvas.isError || sideSession.isError || !selected ? 'alert' : 'status'}>
            <p className="text-body text-primary">{!selected ? '没有指定会话' : canvas.isError ? '项目内容读取失败' : !canvas.data || sideSession.isPending ? '正在读取会话…' : sideSession.error instanceof RequestFailed && sideSession.error.status === 403 ? '没有权限查看这条会话' : sideSession.error instanceof RequestFailed && sideSession.error.status === 404 ? '找不到这条会话' : '会话读取失败'}</p>
            <p className="text-meta text-tertiary">{!canvas.data && !canvas.isError ? '请稍候，确认会话后才能发送消息。' : '确认会话后才能发送消息。'}</p>
            <div className="flex flex-wrap justify-center gap-3 text-sub">
              <button type="button" onClick={backFromFocus} className="min-h-11 text-tertiary hover:text-primary">返回</button>
              {(canvas.isError || sideSession.isError) ? <button type="button" onClick={() => void (canvas.isError ? canvas.refetch() : sideSession.refetch())} className="min-h-11 text-sage underline underline-offset-2">重试</button> : null}
            </div>
          </div>
        </div>
      ) : (
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* min-w-0：不然行里截断的长标题会按 min-content 把这一栏撑出屏（390 宽下整页能横滑 200px） */}
        <div className="relative min-w-0 flex-1">
          {display && view === 'list' ? (
            <ListView
              canvas={display.canvas}
              archivedTasks={display.archived}
              live={live}
              onOpen={openSession}
              onDerive={setDeriveFor}
              onTaskDetail={setTaskDetail}
              onNewTask={() => setNewTask(true)}
              onChanged={applyTask}
              onRefresh={refreshList}
              focusTaskId={createdTask?.id ?? null}
            />
          ) : display ? (
            <CanvasView
              canvas={{ ...display.canvas, layout: display.canvas.layout }}
              live={live}
              history={history}
              onRetryHistory={(session) => void loadHistory(session)}
              sync={sync}
              onRetrySync={retrySync}
              onDerive={setDeriveFor}
              onOpen={openSession}
              onProjectSessions={(sessionId) => { setWindowFocus(sessionId); setSidebarOpen(true); }}
              onWindowFocusChange={setWindowFocus}
              onChanged={refresh}
              onLayoutChange={saveLayout}
              onTaskStatus={setTaskStatus}
              onTaskDetail={setTaskDetail}
              focus={focus}
              expandRequest={expandRequest}
              onExpandHandled={clearExpandRequest}
              drafts={drafts}
              onDraftChange={(sessionId, text) =>
                setDrafts((current) => ({ ...current, [sessionId]: text }))
              }
              onSend={sendPrompt}
              onInterrupt={interruptSession}
              onChangeOption={changeOption}
              onLink={linkSessions}
              onUnlink={unlinkSessions}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-meta text-tertiary">
              {canvas.isError ? (canvas.error as Error).message : '载入中…'}
            </div>
          )}
          {view === 'canvas' && canvas.data && canvas.data.tasks.length === 0 ? (
            <NoTasksHint floating onNewTask={() => setNewTask(true)} />
          ) : null}
          <div
            className={`pointer-events-none absolute bottom-3 left-3 space-y-1 text-meta text-tertiary ${view === 'canvas' ? '' : 'hidden'}`}
          >
            <p>
              <span className="mr-2 inline-block h-px w-6 bg-strong align-middle" />
              派生
            </p>
            <p>
              <span className="mr-2 inline-block w-6 border-t border-dashed border-sage align-middle" />
              分叉
            </p>
          </div>
        </div>

      </div>
      )}

      {search ? (
        <SearchPalette
          key={project.id}
          projectId={project.id}
          accountId={account?.id ?? null}
          canvas={canvas.data}
          onJump={(hit) => jump(hit.taskId, hit.sessionId)}
          onQuickOpen={(sessionId) => { setSearch(false); openSession(sessionId); }}
          onClose={() => setSearch(false)}
          actions={paletteActions}
        />
      ) : null}
      {newTask ? (
        <NewTaskDialog
          projectId={project.id}
          onDone={() => setNewTask(false)}
          onCreated={(task) => setCreatedTask(task)}
        />
      ) : null}
      {taskDetail && canvas.data ? (
        <TaskDetail
          canvas={canvas.data}
          taskId={taskDetail}
          onClose={() => setTaskDetail(null)}
          onOpenSession={(sessionId) => {
            setTaskDetail(null);
            openSession(sessionId);
          }}
          onDerive={(id) => {
            // 关掉详情再开配置：弹窗盖在抽屉上会变成两层，返回时也说不清该退到哪。
            setTaskDetail(null);
            setDeriveFor(id);
          }}
        />
      ) : null}
      {newCoordinator && canvas.data ? (
        <CoordinatorDialog
          canvas={canvas.data}
          onClose={() => setNewCoordinator(false)}
          onStarted={(session) => {
            // 开好（或早就开过）就直接进去：开它就是为了说话。
            setNewCoordinator(false);
            openSession(session.id);
          }}
        />
      ) : null}
      {deriveFor && canvas.data ? (
        <DeriveDialog
          canvas={canvas.data}
          taskId={deriveFor}
          onDone={() => setDeriveFor(null)}
          onDerived={(session) => {
            // 刚开的会话直接进对话：开它就是为了说话。
            setDeriveFor(null);
            openSession(session.id);
          }}
        />
      ) : null}
      {newModelSession?.projectId === project.id && canvas.data ? (
        <NewModelSessionDialog
          key={`${newModelSession.source.id}:${newModelSession.model}`}
          canvas={canvas.data}
          source={newModelSession.source}
          model={newModelSession.model}
          onClose={() => setNewModelSession(null)}
          onCreated={(session) => {
            setNewModelSession(null);
            openSession(session.id);
          }}
        />
      ) : null}
      {createdTask ? (
        <UndoToast
          testId="task-created-toast"
          actionTestId="task-created-start"
          message={`任务「${createdTask.title}」已创建`}
          actionLabel="开始会话"
          onAction={() => {
            const taskId = createdTask.id;
            setCreatedTask(null);
            setDeriveFor(taskId);
          }}
          onDismiss={() => setCreatedTask(null)}
        />
      ) : null}
      </div>
    </div>
    </NewSessionWithModelContext.Provider>
  );
}
