import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CanvasDto, SessionDto } from '../../shell/api.ts';
import { delegationsApi, providersApi } from '../../shell/api.ts';
import { DialogShell, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import { useWorkers } from '../../shell/workers.tsx';
import { ModelPicker } from '../../atoms/model-picker.tsx';
import { delegationKeys, projectKeys } from '../../shell/query-keys.ts';
import { modelsFor, withHubModels } from '../../shell/dialogs.tsx';
import { matchRepoForWorkspace } from '../../atoms/delegation.ts';

function newRequestKey(): string {
  const value = String(globalThis.crypto?.randomUUID?.() ?? '');
  return value === '' ? `delegation-${Date.now().toString(36)}` : value;
}

/**
 * 从主会话派工到一个具体任务。
 *
 * 这里选的全是人写的部分：哪个任务、哪个仓库、从哪条基线拉、要它做什么、用什么 agent/模型。
 * 一次只派一个仓库——多仓一个 PR 不在当前范围里。
 */
export function DelegateDialog({
  canvas,
  session,
  onClose,
  onStarted
}: {
  canvas: CanvasDto;
  /** 发起派工的主会话。 */
  session: SessionDto;
  onClose: () => void;
  onStarted: (delegationId: string) => void;
}) {
  const projectId = canvas.project.id;
  const queryClient = useQueryClient();
  const workers = useWorkers();
  const repos = canvas.project.repos;
  const workspace = canvas.workspaces.find((candidate) => candidate.id === session.workspaceId) ?? null;
  const matched = matchRepoForWorkspace(repos, workspace?.repoUrl ?? canvas.project.repo?.url ?? null);

  const [taskId, setTaskId] = useState(canvas.tasks[0]?.id ?? '');
  const [repoId, setRepoId] = useState(matched?.id ?? repos[0]?.id ?? '');
  const repo = repos.find((candidate) => candidate.id === repoId) ?? null;
  const [baseBranch, setBaseBranch] = useState(repo?.defaultBranch ?? 'main');
  const [instructions, setInstructions] = useState('');
  const [agentId, setAgentId] = useState(session.agentId);
  const [model, setModel] = useState(session.model ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 一次派工一个请求键：失败重试、双击都复用同一个，服务端才认得出是「同一次派工」。
  const [requestKey] = useState(newRequestKey);

  const hubModels = useQuery({ queryKey: ['hub-models', projectId], queryFn: () => providersApi.modelsExplained(projectId), retry: false });
  const agent = canvas.agents.find((candidate) => candidate.id === agentId);
  const offered = withHubModels(
    modelsFor(workers.list, null, agentId) ?? { models: agent?.models ?? [], defaultModel: agent?.defaultModel ?? '' },
    workers.list,
    null,
    agentId,
    hubModels.data?.providers ?? []
  );

  const ready = taskId !== '' && repoId !== '' && baseBranch.trim() !== '' && instructions.trim() !== '' && agentId !== '' && !busy;
  const hint =
    error ??
    (repos.length === 0 ? '这个项目还没有绑定仓库：先给项目加一个 HTTPS 仓库'
      : taskId === '' ? '先选一个同项目的任务'
      : baseBranch.trim() === '' ? '基线分支不能为空'
      : instructions.trim() === '' ? '写清楚要执行的这一段：执行会话只有这段说明和仓库'
      : model === '' ? '不指定模型就用执行 agent 的默认模型'
      : null);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = await delegationsApi.start(session.id, {
        requestKey,
        taskId,
        repoId,
        baseBranch: baseBranch.trim(),
        instructions: instructions.trim(),
        agentId,
        ...(model === '' ? {} : { model })
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: delegationKeys.forCoordinator(session.id) }),
        queryClient.invalidateQueries({ queryKey: projectKeys.canvas(projectId) })
      ]);
      onStarted(result.delegation.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '派工没成功');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell
      title="派工到任务"
      testId="delegate-dialog"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>取消</button>
          <button
            type="button"
            data-testid="delegate-submit"
            data-request-key={requestKey}
            className={PRIMARY_BUTTON}
            disabled={!ready}
            onClick={() => void submit()}
          >
            {busy ? '正在派工…' : '派工'}
          </button>
        </div>
      }
    >
      <p className="mb-3 text-meta text-secondary">
        执行会话会在主会话目录旁边拉一个独立的 worktree，主目录不切分支、不动手头的改动。
      </p>

      <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-meta text-secondary" htmlFor="delegate-task">任务</label>
          <select
            id="delegate-task"
            data-testid="delegate-task"
            className={`mb-3 ${INPUT}`}
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
          >
            {canvas.tasks.length === 0 ? <option value="">（这个项目还没有任务）</option> : null}
            {canvas.tasks.map((task) => (
              <option key={task.id} value={task.id}>{task.title}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-meta text-secondary" htmlFor="delegate-repo">仓库</label>
          <select
            id="delegate-repo"
            data-testid="delegate-repo"
            className={`mb-3 ${INPUT}`}
            value={repoId}
            onChange={(event) => {
              const picked = repos.find((candidate) => candidate.id === event.target.value) ?? null;
              setRepoId(event.target.value);
              setBaseBranch(picked?.defaultBranch ?? 'main');
            }}
          >
            {repos.length === 0 ? <option value="">（没有绑定仓库）</option> : null}
            {repos.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.url}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-meta text-secondary" htmlFor="delegate-base">基线分支</label>
          <input
            id="delegate-base"
            data-testid="delegate-base"
            className={`mb-3 ${INPUT}`}
            value={baseBranch}
            onChange={(event) => setBaseBranch(event.target.value)}
            placeholder="main"
          />
        </div>
        <div>
          <label className="mb-1 block text-meta text-secondary" htmlFor="delegate-agent">agent</label>
          <select
            id="delegate-agent"
            data-testid="delegate-agent"
            className={`mb-3 ${INPUT}`}
            value={agentId}
            onChange={(event) => {
              const picked = canvas.agents.find((candidate) => candidate.id === event.target.value);
              setAgentId(event.target.value);
              setModel(picked?.defaultModel ?? '');
            }}
          >
            {canvas.agents.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-meta text-secondary" htmlFor="delegate-model">模型</label>
          <ModelPicker
            id="delegate-model"
            className={`mb-3 ${INPUT}`}
            scope={agentId}
            value={model}
            disabled={offered.models.length === 0}
            onChange={setModel}
            items={offered.models.map((candidate) => ({ value: candidate, label: candidate }))}
            {...(offered.models.includes(model) || model === '' ? {} : { placeholder: model })}
          />
        </div>
      </div>

      <label className="mb-1 block text-meta text-secondary" htmlFor="delegate-instructions">执行说明</label>
      <textarea
        id="delegate-instructions"
        data-testid="delegate-instructions"
        className={`${INPUT} min-h-24 resize-y`}
        value={instructions}
        maxLength={20000}
        onChange={(event) => setInstructions(event.target.value)}
        placeholder="要它做什么、改哪些地方、跑什么检查、做到什么程度算完"
      />

      {repo !== null ? (
        <p className="mt-2 text-meta text-tertiary" data-testid="delegate-repo-hint">
          {repo.name} · {repo.url}
          {repo.hasToken === false && repo.tokenHint ? ` · ${repo.tokenHint}` : ''}
        </p>
      ) : null}
      {hint === null ? null : (
        <p data-testid="delegate-hint" className="mt-1 text-meta text-tertiary">{hint}</p>
      )}
    </DialogShell>
  );
}
