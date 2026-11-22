import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CanvasDto, SessionDto } from '../../shell/api.ts';
import { api, coordinatorsApi, providersApi } from '../../shell/api.ts';
import { DialogShell, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import { useWorkers } from '../../shell/workers.tsx';
import { ModelPicker } from '../../atoms/model-picker.tsx';
import { coordinatorKeys } from '../../shell/query-keys.ts';
import { modelsFor, withHubModels } from '../../shell/dialogs.tsx';
import { WorkspaceChooser, choiceReady, longLivedRequest, type WorkspaceChoice } from './workspace-chooser.tsx';

/**
 * 新开主会话：在项目的长期工作目录里开一条不归任何任务的会话。
 *
 * 为什么只有「长期目录」：主会话是派工的起点，它的目录要一直在（临时目录会随任务清掉，
 * 隔离 worktree 挂在任务上）。所以这里复用派生的工作目录选择器，只留长期的两种，
 * 其余（临时 / 隔离 / 组合）不出现——不是灰掉，是本来就不适用。
 *
 * 同一条目录只会有一条主会话：服务端按「项目 + 工作目录」复用，已经开过的会直接打开它。
 */
export function CoordinatorDialog({
  canvas,
  onClose,
  onStarted
}: {
  canvas: CanvasDto;
  onClose: () => void;
  /** 开好之后把会话交给调用方打开；`created === false` 表示这条目录本来就有主会话。 */
  onStarted: (session: SessionDto, created: boolean) => void;
}) {
  const projectId = canvas.project.id;
  const queryClient = useQueryClient();
  const workers = useWorkers();
  const [agentId, setAgentId] = useState(canvas.agents[0]?.id ?? '');
  const agent = canvas.agents.find((candidate) => candidate.id === agentId);
  const [model, setModel] = useState(agent?.defaultModel ?? '');
  const [machine, setMachine] = useState<string | null>(null);
  const [choice, setChoice] = useState<WorkspaceChoice | null>(null);
  // 和派生对话框同一套模型清单：这台机器上这个 agent 认得的模型，加上 hub 提供商能给的。
  const hubModels = useQuery({ queryKey: ['hub-models', projectId], queryFn: () => providersApi.modelsExplained(projectId), retry: false });
  const offered = withHubModels(
    modelsFor(workers.list, machine, agentId) ?? { models: agent?.models ?? [], defaultModel: agent?.defaultModel ?? '' },
    workers.list,
    machine,
    agentId,
    hubModels.data?.providers ?? []
  );

  const start = useMutation({
    mutationFn: async () => {
      if (machine === null || choice === null) throw new Error('先选一台机器和一个长期工作目录');
      let workspaceId: string;
      if (choice.type === 'existing') {
        workspaceId = choice.workspaceId;
      } else if (choice.type === 'new_long_lived') {
        // 新目录先建出来再开会话：建目录失败时不会有半条主会话留在登记表里。
        const created = await api.createWorkspace(projectId, longLivedRequest(machine, choice));
        workspaceId = created.id;
      } else {
        throw new Error('主会话只能放在长期工作目录里');
      }
      return coordinatorsApi.start({ projectId, workspaceId, agentId, ...(model === '' ? {} : { model }) });
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: coordinatorKeys.forProject(projectId) }),
        queryClient.invalidateQueries({ queryKey: ['canvas', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['workspaces', projectId] })
      ]);
      onStarted(result.session, result.created);
    }
  });

  const ready = machine !== null && agentId !== '' && choiceReady(choice) && !start.isPending;
  const hint =
    start.error ? (start.error as Error).message
    : machine === null ? '先选一台在线机器'
    : !choiceReady(choice) ? '先选一个长期工作目录'
    : model === '' ? '不指定模型就用这台机器上 agent 的默认模型'
    : null;

  return (
    <DialogShell
      title="新开主会话"
      testId="coordinator-dialog"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>取消</button>
          <button
            type="button"
            data-testid="coordinator-start"
            className={PRIMARY_BUTTON}
            disabled={!ready}
            onClick={() => start.mutate()}
          >
            {start.isPending ? '正在开…' : '开主会话'}
          </button>
        </div>
      }
    >
      <p className="mb-3 text-meta text-secondary">
        在项目的长期工作目录里开一条不归任何任务的会话。派工时从这里发起，执行会话会有自己的目录。
      </p>
      <div className="mb-3 grid grid-cols-1 gap-x-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-meta text-secondary" htmlFor="coordinator-agent">agent</label>
          <select
            id="coordinator-agent"
            data-testid="coordinator-agent"
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
          <label className="mb-1 block text-meta text-secondary" htmlFor="coordinator-model">模型</label>
          <ModelPicker
            id="coordinator-model"
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
      <WorkspaceChooser
        canvas={canvas}
        taskId=""
        agentId={agentId}
        workers={workers.list}
        machine={machine}
        onMachine={setMachine}
        choice={choice}
        onChoice={setChoice}
        longLivedOnly
        hubProtocols={[...new Set((hubModels.data?.providers ?? []).map((provider) => provider.protocol))]}
      />
      <p className="mt-2 text-meta text-tertiary">
        一条长期目录只有一条主会话；已经开过的目录再选一次，会直接打开那条会话。
      </p>
      {hint === null ? null : (
        <p data-testid="coordinator-hint" className="mt-1 text-meta text-tertiary">{hint}</p>
      )}
    </DialogShell>
  );
}
