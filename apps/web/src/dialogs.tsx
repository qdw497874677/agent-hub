import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type CanvasDto } from './api.ts';

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 px-3">
      <div className="w-full max-w-[420px] rounded-md border border-strong bg-panel p-4">
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

export function DeriveDialog({
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 px-3">
      <div className="w-full max-w-[420px] rounded-md border border-strong bg-panel p-4">
        <p className="mb-1 text-head text-primary">开一条会话</p>
        <p className="mb-3 text-meta text-secondary">
          会话从任务派生：任务说清要达成什么，每条会话是一次尝试。同一个任务可以开很多条，
          它们并排跑在画布上，血缘线把每条都连回这个任务。
        </p>
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
            开一条会话
          </button>
        </div>
      </div>
    </div>
  );
}
