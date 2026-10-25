import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from './api.ts';
import { api } from './api.ts';
import { HomePage } from './home.tsx';
import { resolveLive, useLiveStream } from './live.ts';
import { CanvasView, type LayoutPatch } from './canvas.tsx';
import { Inspector } from './inspector.tsx';
import { ListView, SearchPalette } from './views.tsx';
import { FocusView } from './focus.tsx';
import { DeriveDialog, NewTaskDialog } from './dialogs.tsx';
import { ProjectHeader } from './header.tsx';
import { useRoute } from './use-route.ts';
import { useNarrow } from './device.ts';
import type { View } from './route.ts';

const LAST_PROJECT = 'agent-hub:last-project';

export function App() {
  const [route, navigate] = useRoute();
  // 手机上画布没法用手指精确拖拽，默认进列表；桌面默认进画布。
  const narrow = useNarrow();
  const homeView: View = narrow ? 'list' : 'canvas';
  const [newTask, setNewTask] = useState(false);
  const [deriveFor, setDeriveFor] = useState<string | null>(null);
  const [search, setSearch] = useState(false);
  // 草稿存在 App 层而不是 Inspector 里：S6.4 要求切视图不丢草稿，
  // 组件一卸载 useState 就没了，所以它必须活在两者之上。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 跳到某个节点：nonce 让「同一条命中点第二次」也能重新居中。
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const queryClient = useQueryClient();

  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const projectRoute = route?.page === 'project' ? route : null;
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
    } else if (projectRoute && !project) {
      navigate({ page: 'home' }, 'replace');
    }
  }, [route, projectRoute, project, projects.data, navigate, homeView]);

  const goProject = useCallback(
    (picked: ProjectDto, next: View, sessionId: string | null) => {
      localStorage.setItem(LAST_PROJECT, picked.id);
      navigate({ page: 'project', projectId: picked.id, view: next, sessionId });
    },
    [navigate]
  );

  const setSelected = useCallback(
    (sessionId: string | null) => {
      if (projectRoute) navigate({ ...projectRoute, sessionId }, 'replace');
    },
    [projectRoute, navigate]
  );

  const setView = useCallback(
    (next: View) => {
      if (projectRoute) navigate({ ...projectRoute, view: next });
    },
    [projectRoute, navigate]
  );

  const canvas = useQuery({
    queryKey: ['canvas', project?.id],
    queryFn: () => api.canvas(project?.id ?? ''),
    enabled: project !== null,
    // 节点还没上线时自己轮询：别让「等 worker」变成用户要记住的手动刷新
    refetchInterval: (query) => ((query.state.data?.agents.length ?? 0) === 0 ? 2000 : false)
  });

  const refresh = useCallback(() => {
    if (project) void queryClient.invalidateQueries({ queryKey: ['canvas', project.id] });
  }, [project, queryClient]);

  // 内存里的会话流：先用画布投影的历史播种，之后只吃比它新的帧；断线重连后补帧并刷新画布。
  const { live, seed, state: stream } = useLiveStream(refresh);

  const seedRef = useRef(seed);
  seedRef.current = seed;
  useEffect(() => {
    const data = canvas.data;
    if (!data) return;
    seedRef.current(data.sessions, data.previews ?? {});
  });

  // 画布卡片上就地说话：发完清掉这张卡的草稿，不走「先选中再进对话」那条路。
  const sendPrompt = useCallback(
    async (sessionId: string, text: string) => {
      await api.prompt(sessionId, text);
      setDrafts((current) => ({ ...current, [sessionId]: '' }));
      refresh();
    },
    [refresh]
  );

  // 改可调项：候选清单是 agent 报的，服务端把新值交给 agent 后才落库。
  const changeOption = useCallback(
    async (sessionId: string, optionId: string, value: string | boolean) => {
      await api.changeOption(sessionId, optionId, value);
      refresh();
    },
    [refresh]
  );

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
      if (projectRoute) navigate({ ...projectRoute, view: 'focus', sessionId });
    },
    [projectRoute, navigate]
  );

  const setTaskStatus = useCallback(
    (taskId: string, status: 'open' | 'done' | 'abandoned') => {
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

  const selectedSession = useMemo(
    () => canvas.data?.sessions.find((session) => session.id === selected) ?? null,
    [canvas.data, selected]
  );

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
          goProject(picked, sessionId ? 'focus' : homeView, sessionId ?? null);
          if (sessionId) setFocus({ id: sessionId, nonce: Date.now() });
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ProjectHeader
        project={project}
        projects={projects.data ?? []}
        view={view}
        canFocus={selectedSession !== null}
        stream={stream}
        onHome={() => {
          setDrafts({});
          navigate({ page: 'home' });
        }}
        onSwitchProject={(picked) => {
          setDrafts({});
          goProject(picked, view === 'focus' ? homeView : view, null);
        }}
        onView={setView}
        onSearch={() => setSearch(true)}
        onNewTask={() => setNewTask(true)}
      />

      {canvas.data && view === 'focus' && selectedSession ? (
        <FocusView
          canvas={canvas.data}
          session={selectedSession}
          live={resolveLive(selectedSession, canvas.data.previews[selectedSession.id] ?? [], live[selectedSession.id])}
          draft={drafts[selectedSession.id] ?? ''}
          onDraftChange={(text) => setDrafts((current) => ({ ...current, [selectedSession.id]: text }))}
          onBack={() => setView(homeView)}
          onChanged={refresh}
          onChangeOption={(optionId, value) =>
            changeOption(selectedSession.id, optionId, value)
          }
        />
      ) : (
      <div className="flex min-h-0 flex-1">
        <div className="relative flex-1">
          {canvas.data && view === 'list' ? (
            <ListView
              canvas={canvas.data}
              live={live}
              onOpen={openSession}
              onDerive={setDeriveFor}
            />
          ) : canvas.data ? (
            <CanvasView
              canvas={{ ...canvas.data, layout: canvas.data.layout }}
              live={live}
              onSelect={setSelected}
              onDerive={setDeriveFor}
              onOpen={openSession}
              onLayoutChange={saveLayout}
              onTaskStatus={setTaskStatus}
              focus={focus}
              drafts={drafts}
              onDraftChange={(sessionId, text) =>
                setDrafts((current) => ({ ...current, [sessionId]: text }))
              }
              onSend={sendPrompt}
              onInterrupt={interruptSession}
              onChangeOption={changeOption}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-meta text-tertiary">
              {canvas.isError ? (canvas.error as Error).message : '载入中…'}
            </div>
          )}
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

        {selectedSession ? (
          <Inspector
            canvas={
              canvas.data ?? {
                project,
                tasks: [],
                sessions: [],
                artifacts: [],
                edges: [],
                layout: { projectId: project.id, positions: {}, sizes: {}, updatedAt: 0 },
                agents: [],
                previews: {}
              }
            }
            session={selectedSession}
            artifacts={(canvas.data?.artifacts ?? []).filter((artifact) => artifact.sessionId === selectedSession.id)}
            onClose={() => setSelected(null)}
            onFocus={() => selectedSession && openSession(selectedSession.id)}
            onChanged={refresh}
            onChangeOption={(optionId, value) => changeOption(selectedSession.id, optionId, value)}
            draft={drafts[selectedSession.id] ?? ''}
            onDraftChange={(text) => setDrafts((current) => ({ ...current, [selectedSession.id]: text }))}
            live={resolveLive(selectedSession, canvas.data?.previews[selectedSession.id] ?? [], live[selectedSession.id])}
          />
        ) : null}
      </div>
      )}

      {search ? (
        <SearchPalette
          projectId={project.id}
          onJump={(hit) => jump(hit.taskId, hit.sessionId)}
          onClose={() => setSearch(false)}
        />
      ) : null}
      {newTask ? <NewTaskDialog projectId={project.id} onDone={() => setNewTask(false)} /> : null}
      {deriveFor && canvas.data ? (
        <DeriveDialog canvas={canvas.data} taskId={deriveFor} onDone={() => setDeriveFor(null)} />
      ) : null}
    </div>
  );
}
