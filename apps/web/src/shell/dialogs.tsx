import { useEffect, useState } from 'react';
import { DialogShell, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialog-shell.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, providersApi, type CanvasDto, type HubModelsDto, type SessionDto, type WorkerInfoDto } from './api.ts';
import { useWorkers } from './workers.tsx';
import { WorkspaceChooser, choiceReady, longLivedRequest, type WorkspaceChoice } from '../surfaces/workbench/workspace-chooser.tsx';
import { harnessReason } from './harness.tsx';
import { canSelectMachine, startBlockReason } from './harness-gate.ts';
import { ModelPicker, SEARCHABLE_AFTER } from '../atoms/model-picker.tsx';
import { AgentProfilesDialog } from './agent-profiles-dialog.tsx';

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

/** 选中的那台机器上这个 agent 的模型清单；没选机器或老 Worker 没报，返回 null（退回全局清单）。 */
export function modelsFor(
  workers: readonly WorkerInfoDto[],
  machine: string | null,
  agentId: string
): { models: readonly string[]; defaultModel: string } | null {
  if (machine === null) return null;
  return workers.find((worker) => worker.workerId === machine)?.agentModels?.find((entry) => entry.agentId === agentId) ?? null;
}

/**
 * hub 模型提供商（ADR 0013）的模型接在后面：只给那台机器上这个 agent 认得那种协议的；没选机器不给。
 * 模型 id 是 hub-<slug>/<model>，hub 开会话时才把提供商配给 agent。
 */
export function withHubModels(
  offered: { models: readonly string[]; defaultModel: string },
  workers: readonly WorkerInfoDto[],
  machine: string | null,
  agentId: string,
  hub: readonly HubModelsDto[]
): { models: readonly string[]; defaultModel: string } {
  if (machine === null || hub.length === 0) return offered;
  const protocols = workers.find((worker) => worker.workerId === machine)?.agentModels?.find((entry) => entry.agentId === agentId)?.providers ?? [];
  const extra = hub.filter((provider) => protocols.includes(provider.protocol)).flatMap((provider) => provider.models.map((model) => model.id));
  return extra.length === 0 ? offered : { models: [...offered.models, ...extra], defaultModel: offered.defaultModel };
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
  const [profileId, setProfileId] = useState('');
  const [profilesOpen, setProfilesOpen] = useState(false);
  const profiles = useQuery({ queryKey: ['agent-profiles'], queryFn: () => api.agentProfiles(), retry: false });
  const workers = useWorkers();
  // 运行面板（workspaces.md §9.3）：先选机器，再选工作空间；不预选，没选之前「开始」是灰的
  const [machine, setMachine] = useState<string | null>(null);
  // 模型清单按机器来：两台机器的 Pi 配的 provider 可能完全不同
  const hubModels = useQuery({ queryKey: ['hub-models', taskId], queryFn: () => providersApi.models(taskId), retry: false });
  const hubProtocols = [...new Set((hubModels.data ?? []).map((provider) => provider.protocol))];
  const selectedHub = (hubModels.data ?? []).flatMap((provider) => provider.models.map((item) => ({ id: item.id, protocol: provider.protocol }))).find((item) => item.id === model) ?? null;
  const offered = withHubModels(
    modelsFor(workers.list, machine, agentId) ?? { models: agent?.models ?? [], defaultModel: agent?.defaultModel ?? '' },
    workers.list,
    machine,
    agentId,
    hubModels.data ?? []
  );
  const [choice, setChoice] = useState<WorkspaceChoice | null>(null);
  // 隔离档（docs/design/worktree.md §2 §3）：默认跟随项目设置，勾上就是 isolated
  const projectIsolated = canvas.project.worktree?.mode === 'isolated';
  const [isolated, setIsolated] = useState(projectIsolated);
  const [modeTouched, setModeTouched] = useState(false);
  useEffect(() => {
    // 项目设置可能在对话框开着的时候才刷到（画布晚一拍）：没动过就跟着走
    if (!modeTouched) setIsolated(projectIsolated);
  }, [projectIsolated, modeTouched]);
  // 显式选中的空间赢：挑了一次性/临时空间，这次就不再另开 worktree（复选框禁用并说明）
  const chosenWorkspace =
    choice?.type === 'existing' ? canvas.workspaces.find((candidate) => candidate.id === choice.workspaceId) : undefined;
  const temporaryChoice = choice?.type === 'new_temporary' || chosenWorkspace?.kind === 'temporary';
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'starting'>('idle');
  const selectedProfile = (profiles.data ?? []).find((profile) => profile.id === profileId) ?? null;
  const profileAgent = selectedProfile === null ? null : (canvas.agents.find((candidate) => candidate.id === selectedProfile.agentId) ?? null);
  const profileOptionIds = new Set((profileAgent?.options ?? []).map((option) => option.id));
  const unsupportedProfileOptions =
    selectedProfile === null ? [] : Object.keys(selectedProfile.options).filter((id) => !profileOptionIds.has(id));
  const profileModelUnavailable =
    selectedProfile !== null &&
    selectedProfile.model !== '' &&
    offered.models.length > 0 &&
    !offered.models.includes(selectedProfile.model);
  const queryClient = useQueryClient();
  const projectId = canvas.project.id;
  const derive = useMutation({
    mutationFn: async () => {
      // 勾了隔离：不在这里建空间，交给 server 按项目配置现建 worktree 并跑准备命令（workspaceId 为空才会走档位）。
      const isolateNew = isolated && !temporaryChoice;
      if (machine === null) throw new Error('先选机器');
      if (!isolateNew && !choice) throw new Error('先选机器和工作空间');
      let workspaceId: string | null = null;
      if (isolateNew) workspaceId = null;
      else if (choice?.type === 'existing') workspaceId = choice.workspaceId;
      else {
        setPhase('preparing');
        if (choice === null) throw new Error('先选机器和工作空间');
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
      setPhase(isolateNew ? 'preparing' : 'starting');
      // 勾上 = 明确要 isolated；没勾但项目默认是 isolated = 明确要 shared。与项目默认一致就不发，让 server 用它自己的默认。
      // 选了临时空间就不发档位：显式选中的 workspaceId 赢，别让一句话的复选框把它盖掉。
      const workspaceMode: 'shared' | 'isolated' | null = temporaryChoice ? null : isolated ? 'isolated' : projectIsolated ? 'shared' : null;
      return api.derive({
        taskId,
        agentId,
        model,
        workerId: machine,
        ...(workspaceId === null ? {} : { workspaceId }),
        ...(workspaceMode === null ? {} : { workspaceMode }),
        ...(profileId ? { profileId } : {})
      });
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

  const offeredKey = `${offered.defaultModel}\n${offered.models.join('\n')}`;
  useEffect(() => {
    // 换了 agent 或机器：当前模型那边没有就换成那边的默认
    setModel((current) => (offered.models.includes(current) ? current : offered.defaultModel));
  }, [offeredKey]);

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
        <div
          className={isolated && !temporaryChoice ? 'pointer-events-none opacity-40' : ''}
          aria-disabled={isolated && !temporaryChoice ? true : undefined}
          data-testid="derive-workspace-region"
        >
          <WorkspaceChooser
            canvas={canvas}
            taskId={taskId}
            agentId={agentId}
            workers={workers.list}
            machine={machine}
            onMachine={setMachine}
            choice={choice}
            onChoice={setChoice}
            hubProtocols={hubProtocols}
          />
        </div>
        <label className={`mb-3 flex items-start gap-2 text-meta ${temporaryChoice ? 'text-tertiary' : 'text-secondary'}`}>
          <input
            type="checkbox"
            className="mt-0.5"
            data-testid="derive-isolated"
            checked={isolated && !temporaryChoice}
            disabled={temporaryChoice}
            onChange={(event) => {
              setModeTouched(true);
              setIsolated(event.target.checked);
            }}
          />
          <span className="min-w-0">
            <span className="block text-primary">这个任务用隔离 worktree（新分支）</span>
            <span className="block text-tertiary">
              {temporaryChoice
                ? '已经选了临时空间，这次不会再开 worktree。想换成就地新开，把上面改回长期空间或先不选。'
                : `会新开分支 agent-hub/…，结束后按策略清理；这次不占用上面选的工作空间。并行任务、会开 PR 时选这个；不勾就在上面选的空间里直接干。${projectIsolated ? '（项目默认已开隔离）' : ''}`}
            </span>
          </span>
        </label>
        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <label className="block text-meta text-secondary" htmlFor="derive-profile">Agent 配置（可留空）</label>
            <button type="button" className="text-meta text-accent underline-offset-2 hover:underline" onClick={() => setProfilesOpen(true)}>
              管理
            </button>
          </div>
          <select
            id="derive-profile"
            className={INPUT}
            value={profileId}
            onChange={(event) => {
              const next = event.target.value;
              setProfileId(next);
              const profile = (profiles.data ?? []).find((candidate) => candidate.id === next);
              if (profile) {
                setAgentId(profile.agentId);
                setModel(profile.model);
              }
            }}
          >
            <option value="">不用配置，手动选</option>
            {(profiles.data ?? []).map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · {profile.agentId}{profile.model ? ` · ${profile.model}` : ''}
              </option>
            ))}
          </select>
          {profiles.error ? <p className="mt-1 text-meta text-rust">{(profiles.error as Error).message}</p> : null}
          {selectedProfile !== null && profileAgent === null ? (
            <p className="mt-1 text-meta text-rust">这个配置的 agent「{selectedProfile.agentId}」当前没有运行时在线。</p>
          ) : null}
          {profileModelUnavailable ? (
            <p className="mt-1 text-meta text-rust">这个配置的模型「{selectedProfile.model}」在当前机器/运行时不可用。</p>
          ) : null}
          {unsupportedProfileOptions.length > 0 ? (
            <p className="mt-1 text-meta text-rust">
              这个配置带有当前 agent 不认识的选项：{unsupportedProfileOptions.join('、')}，派生后会被忽略。
            </p>
          ) : null}
        </div>
        <div className="mb-4 grid grid-cols-1 gap-x-3 sm:grid-cols-2">
        <div>
        <label className="mb-1 block text-meta text-secondary" htmlFor="derive-agent">agent</label>
        <select
          id="derive-agent"
          className={`mb-3 ${INPUT}`}
          value={agentId}
          onChange={(event) => {
            setProfileId('');
            setAgentId(event.target.value);
          }}
        >
          {canvas.agents.map((candidate) => {
            // 选了机器：那台上不能用的 agent 变灰并写明原因（没选机器时由下面的机器列表说明）
            const worker = machine === null ? undefined : workers.byId(machine);
            const why = worker ? harnessReason(worker, candidate.id) : null;
            const disabled = why !== null && !(why === '未配置模型' && canSelectMachine(worker, candidate.id, hubProtocols));
            return (
              <option key={candidate.id} value={candidate.id} disabled={disabled}>
                {why ? `${candidate.label}（${why}）` : candidate.label}
              </option>
            );
          })}
        </select>
        </div>
        <div>
        <label className="mb-1 block text-meta text-secondary" htmlFor="derive-model">模型</label>
        {offered.models.length > SEARCHABLE_AFTER ? (
          <ModelPicker
            id="derive-model"
            className={`mb-3 ${INPUT}`}
            scope={agentId}
            value={model}
            onChange={(value) => {
              setProfileId('');
              setModel(value);
            }}
            items={offered.models.map((candidate) => ({ value: candidate, label: candidate }))}
          />
        ) : (
          <select
            id="derive-model"
            className={`mb-3 ${INPUT}`}
            value={model}
            disabled={offered.models.length === 0}
            onChange={(event) => {
              setProfileId('');
              setModel(event.target.value);
            }}
          >
            {offered.models.length === 0 ? (
              <option value="">用 agent 自己的默认</option>
            ) : (
              offered.models.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))
            )}
          </select>
        )}
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
            disabled={agentId === '' || machine === null || startBlockReason(workers.byId(machine), agentId, model, selectedHub?.protocol ?? null) !== null || !choiceReady(choice) || derive.isPending}
            onClick={() => derive.mutate()}
          >
            {phase === 'preparing'
              ? choice?.type === 'new_long_lived' && choice.mode === 'create' && canvas.project.repo
                ? '正在下载仓库…'
                : '正在准备工作空间…' : derive.isPending ? '启动中…' : derive.error ? '重试' : '开始'}
          </button>
        </div>
        {profilesOpen ? <AgentProfilesDialog agents={canvas.agents} onClose={() => setProfilesOpen(false)} /> : null}
    </DialogShell>
  );
}
