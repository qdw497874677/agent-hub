import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CanvasDto, ProjectDto } from './api.ts';
import { api } from './api.ts';
import { HomePage } from './home.tsx';
import { useLiveStream } from './live.ts';
import { CanvasView } from './canvas.tsx';
import { Inspector } from './inspector.tsx';
import { ListView, SearchPalette } from './views.tsx';
import { WorkersBadge } from './workers.tsx';

const LAST_PROJECT = 'agent-hub:last-project';

function NewTaskDialog({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.createTask({ projectId, title: title.trim(), goal: goal.trim() || undefined }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['canvas', projectId] });
      onDone();
    }
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70">
      <div className="w-[420px] rounded-md border border-strong bg-panel p-4">
        <p className="mb-3 text-head text-primary">新建任务</p>
        <input
          autoFocus
          className="mb-2 w-full rounded-sm border border-hair bg-card px-2 py-1.5 text-body text-primary outline-none focus:border-accent"
          placeholder="任务标题"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          className="mb-3 h-20 w-full resize-none rounded-sm border border-hair bg-card px-2 py-1.5 text-body text-primary outline-none focus:border-accent"
          placeholder="想要达成什么（可留空）"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
        {create.error ? <p className="mb-2 text-meta text-rust">{(create.error as Error).message}</p> : null}
        <div className="flex justify-end gap-2">
          <button className="rounded-sm border border-hair px-3 py-1 text-meta text-secondary" onClick={onDone}>
            取消
          </button>
          <button
            className="rounded-sm bg-accent px-3 py-1 text-meta text-canvas disabled:opacity-40"
            disabled={title.trim().length === 0 || create.isPending}
            onClick={() => create.mutate()}
          >
            建
          </button>
        </div>
      </div>
    </div>
  );
}

function DeriveDialog({
  canvas,
  taskId,
  onDone
}: {
  canvas: CanvasDto;
  taskId: string;
  onDone: () => void;
}) {
  const [agentId, setAgentId] = useState(canvas.agents[0]?.id ?? '');
  const agent = canvas.agents.find((candidate) => candidate.id === agentId);
  const [model, setModel] = useState(agent?.defaultModel ?? '');
  const queryClient = useQueryClient();
  const derive = useMutation({
    mutationFn: () => api.derive({ taskId, agentId, model }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['canvas', canvas.project.id] });
      onDone();
    }
  });

  useEffect(() => {
    if (agent) setModel(agent.defaultModel);
  }, [agent]);

  // worker 可能比页面晚到（远程节点、或者本机 Pi 还在报模型列表）。不要空着让人点不动。
  useEffect(() => {
    if (agentId === '' && canvas.agents.length > 0) setAgentId(canvas.agents[0]?.id ?? '');
  }, [agentId, canvas.agents]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70">
      <div className="w-[420px] rounded-md border border-strong bg-panel p-4">
        <p className="mb-3 text-head text-primary">从任务派生会话</p>
        {canvas.agents.length === 0 ? (
          <p className="mb-3 border-l border-rust pl-2 text-meta text-secondary">
            还没有节点上线。worker 起来后，这里会出现它装了的 agent。
            <button
              className="ml-2 text-accent underline-offset-2 hover:underline"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['canvas', canvas.project.id] })}
            >
              重新检查
            </button>
          </p>
        ) : null}
        <label className="mb-1 block text-meta text-tertiary">agent</label>
        <select
          className="mb-2 w-full rounded-sm border border-hair bg-card px-2 py-1.5 text-body text-primary outline-none"
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
        >
          {canvas.agents.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
        <label className="mb-1 block text-meta text-tertiary">模型</label>
        <select
          className="mb-3 w-full rounded-sm border border-hair bg-card px-2 py-1.5 text-body text-primary outline-none disabled:text-tertiary"
          value={model}
          disabled={(agent?.models ?? []).length === 0}
          onChange={(event) => setModel(event.target.value)}
        >
          {(agent?.models ?? []).length === 0 ? (
            <option value="">用 agent 自己的默认</option>
          ) : (
            (agent?.models ?? []).map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))
          )}
        </select>
        {derive.error ? <p className="mb-2 text-meta text-rust">{(derive.error as Error).message}</p> : null}
        <div className="flex justify-end gap-2">
          <button className="rounded-sm border border-hair px-3 py-1 text-meta text-secondary" onClick={onDone}>
            取消
          </button>
          <button
            className="rounded-sm bg-accent px-3 py-1 text-meta text-canvas disabled:opacity-40"
            disabled={agentId === '' || derive.isPending}
            onClick={() => derive.mutate()}
          >
            派生
          </button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [project, setProject] = useState<ProjectDto | null>(null);
  // 点了「首页」之后别再自动跳回去：localStorage 记的是「上次那个项目」，
  // 不是「必须打开的那个项目」，否则首页按钮会把自己立刻弹掉。
  const [atHome, setAtHome] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [newTask, setNewTask] = useState(false);
  const [deriveFor, setDeriveFor] = useState<string | null>(null);
  const [view, setView] = useState<'canvas' | 'list'>('canvas');
  const [search, setSearch] = useState(false);
  // 草稿存在 App 层而不是 Inspector 里：S6.4 要求切视图不丢草稿，
  // 组件一卸载 useState 就没了，所以它必须活在两者之上。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 跳到某个节点：nonce 让「同一条命中点第二次」也能重新居中。
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const live = useLiveStream();
  const queryClient = useQueryClient();

  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });

  useEffect(() => {
    if (project || atHome || !projects.data) return;
    // 只认「上次打开的那个」。没有就停在选择页——不替用户挑一个看起来像的项目。
    const remembered = localStorage.getItem(LAST_PROJECT);
    const found = projects.data.find((candidate) => candidate.id === remembered);
    if (found) setProject(found);
  }, [project, atHome, projects.data]);

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

  // 会话状态变化时刷新画布：卡片状态位由 canvas 数据 + live 帧共同决定。
  useEffect(() => {
    if (Object.keys(live).length === 0) return;
    const timer = setTimeout(refresh, 900);
    return () => clearTimeout(timer);
  }, [live, refresh]);

  const setTaskStatus = useCallback(
    (taskId: string, status: 'open' | 'done' | 'abandoned') => {
      void api.setTaskStatus(taskId, status).then(refresh, () => undefined);
    },
    [refresh]
  );

  const saveLayout = useMemo(
    () => (positions: Record<string, { x: number; y: number }>) => {
      if (!project) return;
      void api.saveLayout(project.id, positions);
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

  const jump = useCallback((taskId: string, sessionId: string | null) => {
    setSearch(false);
    setView('canvas');
    setSelected(sessionId);
    setFocus({ id: sessionId ?? taskId, nonce: Date.now() });
  }, []);

  if (project === null) {
    return (
      <HomePage
        onOpen={(picked, sessionId) => {
          localStorage.setItem(LAST_PROJECT, picked.id);
          setAtHome(false);
          setProject(picked);
          setSelected(sessionId ?? null);
          if (sessionId) setFocus({ id: sessionId, nonce: Date.now() });
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-hair px-3">
        <div className="flex items-baseline gap-3">
          <button
            className="rounded-sm border border-hair px-1.5 py-0.5 text-meta text-secondary hover:border-strong"
            title="回到首页"
            onClick={() => {
              setAtHome(true);
              setProject(null);
              setSelected(null);
              setDrafts({});
            }}
          >
            ⌂
          </button>
          <select
            className="cursor-pointer appearance-none bg-transparent text-head text-primary outline-none"
            value={project.id}
            onChange={(event) => {
              const picked = (projects.data ?? []).find((candidate) => candidate.id === event.target.value);
              if (!picked) return;
              localStorage.setItem(LAST_PROJECT, picked.id);
              setProject(picked);
              setSelected(null);
              setDrafts({});
            }}
            title="切换项目"
          >
            {(projects.data ?? [project]).map((candidate) => (
              <option key={candidate.id} value={candidate.id} className="bg-panel text-body">
                {candidate.name}
              </option>
            ))}
          </select>
          <span className="font-mono text-meta text-tertiary">{project.rootPath}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-sm border border-hair">
            {(['canvas', 'list'] as const).map((mode) => (
              <button
                key={mode}
                className={`px-2.5 py-1 text-meta ${view === mode ? 'bg-card text-primary' : 'text-tertiary hover:text-secondary'}`}
                onClick={() => setView(mode)}
              >
                {mode === 'canvas' ? '画布' : '列表'}
              </button>
            ))}
          </div>
          <WorkersBadge />
          <button
            className="rounded-sm border border-hair px-2.5 py-1 text-meta text-tertiary hover:border-accent hover:text-accent"
            onClick={() => setSearch(true)}
            title="搜索任务与会话（⌘K）"
          >
            搜索 ⌘K
          </button>
          <button
            className="rounded-sm border border-hair px-2.5 py-1 text-meta text-secondary hover:border-accent hover:text-accent"
            onClick={() => setNewTask(true)}
          >
            新建任务
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative flex-1">
          {canvas.data && view === 'list' ? (
            <ListView
              canvas={canvas.data}
              live={live}
              onOpen={(sessionId) => jump(canvas.data.sessions.find((s) => s.id === sessionId)?.taskId ?? '', sessionId)}
              onDerive={setDeriveFor}
            />
          ) : canvas.data ? (
            <CanvasView
              canvas={{ ...canvas.data, layout: canvas.data.layout }}
              live={live}
              onSelect={setSelected}
              onDerive={setDeriveFor}
              onLayoutChange={saveLayout}
              onTaskStatus={setTaskStatus}
              focus={focus}
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
                layout: { projectId: project.id, positions: {}, updatedAt: 0 },
                agents: [],
                previews: {}
              }
            }
            session={selectedSession}
            artifacts={(canvas.data?.artifacts ?? []).filter((artifact) => artifact.sessionId === selectedSession.id)}
            onClose={() => setSelected(null)}
            onChanged={refresh}
            draft={drafts[selectedSession.id] ?? ''}
            onDraftChange={(text) => setDrafts((current) => ({ ...current, [selectedSession.id]: text }))}
          />
        ) : null}
      </div>

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
