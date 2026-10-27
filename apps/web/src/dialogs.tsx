import { useEffect, useState } from 'react';
import { DialogShell, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialog-shell.tsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type CanvasDto, type SessionDto } from './api.ts';
import { useWorkers } from './workers.tsx';
import { WorkspaceChooser, choiceReady, longLivedRequest, type WorkspaceChoice } from './workspace-chooser.tsx';

/** 两个创建对话框：新建任务、从任务派生会话。窄屏下撑满宽度（留 12px 边）。 */
export function NewTaskDialog({ projectId, onDone }: { projectId: string; onDone: () => void }) {
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
    <DialogShell title="新建任务" onClose={onDone}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim() !== '' && !create.isPending) create.mutate();
        }}
      >
        <p className="mb-3 text-head text-primary">新建任务</p>
        <label className="mb-1 block text-meta text-secondary" htmlFor="task-title">标题</label>
        <input
          id="task-title"
          autoFocus
          className={`mb-3 ${INPUT}`}
          placeholder="比如：给登录页加上验证码"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label className="mb-1 block text-meta text-secondary" htmlFor="task-goal">目标（可留空）</label>
        <textarea
          id="task-goal"
          className={`mb-4 h-20 resize-none ${INPUT}`}
          placeholder="想要达成什么、怎样算做完"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
        {create.error ? <p className="mb-2 text-meta text-rust">{(create.error as Error).message}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} onClick={onDone}>
            取消
          </button>
          <button type="submit" className={PRIMARY_BUTTON} disabled={title.trim().length === 0 || create.isPending}>
            {create.isPending ? '创建中…' : '创建任务'}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

export function DeriveDialog({
  canvas,
  taskId,
  onDone,
  onDerived
}: {
  canvas: CanvasDto;
  taskId: string;
  onDone: () => void;
  /** 派生成功后调用；不传就和取消一样只关掉。 */
  onDerived?: (session: SessionDto) => void;
}) {
  const [agentId, setAgentId] = useState(canvas.agents[0]?.id ?? '');
  const agent = canvas.agents.find((candidate) => candidate.id === agentId);
  const [model, setModel] = useState(agent?.defaultModel ?? '');
  const workers = useWorkers();
  // 运行面板（workspaces.md §9.3）：先选机器，再选工作空间；不预选，没选之前「开始」是灰的
  const [machine, setMachine] = useState<string | null>(null);
  const [choice, setChoice] = useState<WorkspaceChoice | null>(null);
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'starting'>('idle');
  const queryClient = useQueryClient();
  const projectId = canvas.project.id;
  const derive = useMutation({
    mutationFn: async () => {
      if (!choice || machine === null) throw new Error('先选机器和工作空间');
      let workspaceId: string;
      if (choice.type === 'existing') workspaceId = choice.workspaceId;
      else {
        setPhase('preparing');
        const made = await api.createWorkspace(
          projectId,
          choice.type === 'new_temporary'
            ? { workerId: machine, kind: 'temporary', taskId }
            : longLivedRequest(machine, choice)
        );
        workspaceId = made.id;
        // 建好了就记成「已有的」：重试时不再新建第二个
        setChoice({ type: 'existing', workspaceId });
        await queryClient.invalidateQueries({ queryKey: ['workspaces', projectId] });
      }
      setPhase('starting');
      return api.derive({ taskId, agentId, model, workspaceId });
    },
    onSettled: () => setPhase('idle'),
    onSuccess: async (session) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['canvas', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['workspaces', projectId] })
      ]);
      if (onDerived) onDerived(session);
      else onDone();
    }
  });

  useEffect(() => {
    if (agent) setModel(agent.defaultModel);
  }, [agent]);

  // worker 可能比页面晚到（远程机器、或者本机 Pi 还在报模型列表）。不要空着让人点不动。
  useEffect(() => {
    if (agentId === '' && canvas.agents.length > 0) setAgentId(canvas.agents[0]?.id ?? '');
  }, [agentId, canvas.agents]);

  return (
    <DialogShell title="在哪台机器、哪个工作空间干活？" onClose={onDone}>
        <p className="mb-3 text-head text-primary">在哪台机器、哪个工作空间干活？</p>
        {canvas.agents.length === 0 ? (
          <p className="mb-3 border-l border-rust pl-2 text-meta text-secondary">
            还没有机器上线。它起来后，这里会出现它装了的 agent。
            <button
              className="ml-2 text-accent underline-offset-2 hover:underline"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['canvas', canvas.project.id] })}
            >
              重新检查
            </button>
          </p>
        ) : null}
        <WorkspaceChooser
          canvas={canvas}
          taskId={taskId}
          agentId={agentId}
          workers={workers.list}
          machine={machine}
          onMachine={setMachine}
          choice={choice}
          onChoice={setChoice}
        />
        <div className="mb-4 grid grid-cols-1 gap-x-3 sm:grid-cols-2">
        <div>
        <label className="mb-1 block text-meta text-secondary" htmlFor="derive-agent">agent</label>
        <select
          id="derive-agent"
          className={`mb-3 ${INPUT}`}
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
        >
          {canvas.agents.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
        </div>
        <div>
        <label className="mb-1 block text-meta text-secondary" htmlFor="derive-model">模型</label>
        <select
          id="derive-model"
          className={`mb-3 ${INPUT}`}
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
        </div>
        </div>
        {derive.error ? <p className="mb-2 text-meta text-rust">{(derive.error as Error).message}</p> : null}
        <div className="sticky bottom-0 -mx-1 flex justify-end gap-2 bg-panel px-1 pb-[env(safe-area-inset-bottom)] pt-2">
          <button type="button" className={SECONDARY_BUTTON} onClick={onDone}>
            取消
          </button>
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={agentId === '' || machine === null || !choiceReady(choice) || derive.isPending}
            onClick={() => derive.mutate()}
          >
            {phase === 'preparing'
              ? choice?.type === 'new_long_lived' && choice.mode === 'create' && canvas.project.repo
                ? '正在下载仓库…'
                : '正在准备工作空间…' : derive.isPending ? '启动中…' : derive.error ? '重试' : '开始'}
          </button>
        </div>
    </DialogShell>
  );
}
