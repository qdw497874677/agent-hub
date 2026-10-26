import { useEffect, useState } from 'react';
import { DialogShell, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialog-shell.tsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type CanvasDto, type SessionDto } from './api.ts';
import { WorkerChip, WorkerPicker, resolveWorker, useWorkers } from './workers.tsx';

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
  // 项目绑了机器（目录在那台上）：会话只能去那台，不给选；否则可选，默认交给 hub 安排。
  // 没绑定的项目 = 目录在 hub 本机，有本机 Worker 时就是它；只有全靠远程机器时才让人选。
  const bound = resolveWorker(workers.list, canvas.project.workerId);
  const candidates = workers.list.filter((worker) => (worker.agentIds ?? [agentId]).includes(agentId));
  const [workerId, setWorkerId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const derive = useMutation({
    mutationFn: () => api.derive({ taskId, agentId, model, ...(workerId && !bound ? { workerId } : {}) }),
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: ['canvas', canvas.project.id] });
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
    <DialogShell title="开一条会话" onClose={onDone}>
        <p className="mb-1 text-head text-primary">开一条会话</p>
        <p className="mb-3 text-meta text-secondary">
          会话从任务派生：任务说清要达成什么，每条会话是一次尝试。同一个任务可以开很多条，
          它们并排跑在画布上，血缘线把每条都连回这个任务。
        </p>
        {canvas.agents.length === 0 ? (
          <p className="mb-3 border-l border-rust pl-2 text-meta text-secondary">
            还没有 Worker 上线。它起来后，这里会出现它装了的 agent。
            <button
              className="ml-2 text-accent underline-offset-2 hover:underline"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['canvas', canvas.project.id] })}
            >
              重新检查
            </button>
          </p>
        ) : null}
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
        {bound && workers.multi ? (
          <p className="mb-3 flex items-center gap-2 text-meta text-secondary">
            跑在 <WorkerChip worker={bound} /> 上——项目目录在那台机器。
          </p>
        ) : bound ? null : (
          <WorkerPicker workers={candidates} value={workerId} onChange={setWorkerId} allowAuto />
        )}
        <label className="mb-1 block text-meta text-secondary" htmlFor="derive-model">模型</label>
        <select
          id="derive-model"
          className={`mb-4 ${INPUT}`}
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
          <button type="button" className={SECONDARY_BUTTON} onClick={onDone}>
            取消
          </button>
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={agentId === '' || derive.isPending}
            onClick={() => derive.mutate()}
          >
            {derive.isPending ? '启动中…' : '开一条会话'}
          </button>
        </div>
    </DialogShell>
  );
}
