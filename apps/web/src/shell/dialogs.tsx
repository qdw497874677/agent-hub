import { useEffect, useRef, useState } from 'react';
import { DialogShell, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialog-shell.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, assetsApi, assetSetsApi, providersApi, type CanvasDto, type HubModelsDto, type SessionDto, type TaskDto, type WorkerInfoDto } from './api.ts';
import {
  assetNote,
  assetSelectionKey,
  includedAssetIds,
  isIncluded,
  selectionFor,
  submitAssetIds,
  toggleAsset,
  type AssetSelection
} from '../atoms/derive-assets.ts';
import {
  itemCountText,
  setChoiceFor,
  submitAssetSetIds,
  toggleSetChoice,
  type AssetSetChoice
} from '../atoms/asset-sets.ts';
import { useWorkers } from './workers.tsx';
import { WorkspaceChooser, choiceReady, longLivedRequest, repoName, useWorkspaceViews, type WorkspaceChoice } from '../surfaces/workbench/workspace-chooser.tsx';
import { shortPath, workspaceName } from '../atoms/workspace-format.ts';
import { harnessReason } from './harness.tsx';
import { Icon } from '../atoms/icons.tsx';
import { agentNote, canSelectMachine, emptyModelOption, hubCovers, machineAvailability, startHint } from './harness-gate.ts';
import { ModelPicker } from '../atoms/model-picker.tsx';
import { useNarrow } from './device.ts';
import { AgentProfilesDialog } from './agent-profiles-dialog.tsx';
import { cloneErrorHint } from '../surfaces/workbench/project-repos.ts';
import { groupStateNote, memberStateLabel, failedGroupIdFromWorkspaces, type WorkspaceGroupView } from '../surfaces/workbench/workspace-group.ts';

/** 两个创建对话框：新建任务、从任务派生会话。窄屏下撑满宽度（留 12px 边）。 */
export function NewTaskDialog({
  projectId,
  onDone,
  onCreated
}: {
  projectId: string;
  onDone: () => void;
  onCreated?: (task: TaskDto) => void;
}) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.createTask({ projectId, title: title.trim(), goal: goal.trim() || undefined }),
    onSuccess: async (task) => {
      await queryClient.invalidateQueries({ queryKey: ['canvas', projectId] });
      onDone();
      onCreated?.(task);
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
        <label className="mb-1 block text-meta text-secondary" htmlFor="task-goal">目标</label>
        <textarea
          id="task-goal"
          className={`mb-4 h-20 resize-none ${INPUT}`}
          placeholder="怎样算做完（可选）"
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
  // 手机上先说清「给哪条任务、在哪台机器上开」，再收起不常用的高级项；
  // 桌面上这些区块照旧全部展开（见下面的 max-md:order-*）。
  const narrow = useNarrow();
  const [agentSectionOpen, setAgentSectionOpen] = useState(false);
  const [assetsSectionOpen, setAssetsSectionOpen] = useState(false);
  // 「换 Agent」只做两件事：展开手机上的折叠区，把焦点放回原来的选择器。不动 agent / 机器 / 目录。
  const agentPicker = useRef<HTMLSelectElement>(null);
  const [agentFocusSignal, setAgentFocusSignal] = useState(0);
  useEffect(() => {
    if (agentFocusSignal === 0) return;
    const timer = window.setTimeout(() => {
      const select = agentPicker.current;
      if (select === null) return;
      select.focus();
      select.scrollIntoView({ block: 'center' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [agentFocusSignal]);
  const profiles = useQuery({ queryKey: ['agent-profiles'], queryFn: () => api.agentProfiles(), retry: false });
  const workers = useWorkers();
  // 底部复核行要念出「已有的哪个目录」：和 chooser 共用同一份查询（同一个 key，不多打一次请求）。
  const workspaceViews = useWorkspaceViews(canvas.project.id);
  // 运行面板（workspaces.md §9.3）：先选机器，再选工作目录；不预选，没选之前「开始」是灰的
  const [machine, setMachine] = useState<string | null>(null);
  // 资产（asset-hub.md）：选中机器后看这一趟会带哪些技能 / 指令 / MCP；默认全选，取消即排除。
  // 换机器 / 换项目就重新全选——不同机器下发的是不同的资产集。
  const [assetSelection, setAssetSelection] = useState<AssetSelection | null>(null);
  const assetPlan = useQuery({
    queryKey: ['project-assets', canvas.project.id, machine],
    queryFn: () => assetsApi.projectPlan(canvas.project.id, machine ?? ''),
    enabled: machine !== null,
    retry: false
  });
  const assetEntries = assetPlan.data?.entries ?? [];
  // 带上也起不来的（MCP 缺密钥等）默认不勾，行内标红说原因
  const selection = selectionFor(assetSelection, assetSelectionKey(canvas.project.id, machine), assetEntries);
  // 资产组合（asset-hub.md「资产组合」）：项目默认带哪几组，这里可以整组取消，也可以换成别的组合。
  // 用户没动过 → 不传 assetSetIds（后端按项目默认展开）；动过 → 传当前这组 id（可能为空）。
  const setList = useQuery({ queryKey: ['asset-sets'], queryFn: () => assetSetsApi.list(), retry: false });
  const [assetSetChoice, setAssetSetChoice] = useState<AssetSetChoice | null>(null);
  const sets = setList.data ?? [];
  const chosen = setChoiceFor(assetSetChoice, canvas.project.assetSetIds ?? []);
  const chosenSets = chosen.ids.flatMap((id) => {
    const set = sets.find((candidate) => candidate.id === id);
    return set ? [set] : [];
  });
  const spareSets = sets.filter((set) => !chosen.ids.includes(set.id));
  // 模型清单按机器来：两台机器的 Pi 配的 provider 可能完全不同
  const hubModels = useQuery({ queryKey: ['hub-models', taskId], queryFn: () => providersApi.modelsExplained(taskId), retry: false });
  const hubList = hubModels.data?.providers ?? [];
  const hubHidden = hubModels.data?.hidden ?? [];
  const hubProtocols = [...new Set(hubList.map((provider) => provider.protocol))];
  const availability = machineAvailability(workers.list, agentId, hubProtocols, {
    loading: workers.list.length === 0 && workers.loading,
    failed: workers.list.length === 0 && workers.failed
  });
  const selectedHub = hubList.flatMap((provider) => provider.models.map((item) => ({ id: item.id, protocol: provider.protocol }))).find((item) => item.id === model) ?? null;
  const offered = withHubModels(
    modelsFor(workers.list, machine, agentId) ?? { models: agent?.models ?? [], defaultModel: agent?.defaultModel ?? '' },
    workers.list,
    machine,
    agentId,
    hubList
  );
  const [choice, setChoice] = useState<WorkspaceChoice | null>(null);
  // 组合工作目录：建好的那组留着，准备失败时可以原地重试，不必再建一组
  const [group, setGroup] = useState<WorkspaceGroupView | null>(null);
  // 「开始」点不了时的原因：一行话放在按钮上方，手机上不用去猜、也没有 hover 可看
  const hint = startHint({
    agentId,
    agentLabel: agent?.label ?? agentId,
    machine,
    worker: workers.byId(machine),
    model,
    protocol: selectedHub?.protocol ?? null,
    workspaceReady: choiceReady(choice),
    workspaceNeedsPath: choice?.type === 'new_long_lived' && !choice.path,
    hubAvailable: hubCovers(workers.byId(machine), agentId, hubProtocols),
    machines: availability
  });
  // 模型框的空值项：状态为空时显式画出来，别让浏览器把第一项画成「已选」（见 emptyModelOption）
  const emptyModel = emptyModelOption(offered.models, model, hubCovers(workers.byId(machine), agentId, hubProtocols));
  // 多仓项目默认新建组合工作目录；否则若项目默认隔离，替用户选上「新建隔离 worktree」。
  const projectIsolated = canvas.project.worktree?.mode === 'isolated';
  const multiRepo = Boolean(canvas.project.primaryRepoId) && (canvas.project.repos?.length ?? 0) > 1;
  const [modeTouched, setModeTouched] = useState(false);
  useEffect(() => {
    if (modeTouched || choice !== null) return;
    if (multiRepo) {
      setChoice({ type: 'new_group', repoIds: canvas.project.repos.map((repo) => repo.id) });
      return;
    }
    if (projectIsolated) setChoice({ type: 'new_worktree' });
  }, [projectIsolated, multiRepo, modeTouched, choice]);
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'starting'>('idle');
  // 正在等什么、在哪台机器上等：从点「开始」那一刻的选项取，之后改选项也不会把它说错。
  const [busy, setBusy] = useState<{ readonly title: string; readonly scope: string } | null>(null);
  /** 组合工作目录准备失败时，主按钮不重复建组：让下面的「重试准备」处理这一组。 */
  const groupFailed = choice?.type === 'new_group' && group !== null && group.state === 'failed';
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
  // 手机顶上那张「给谁开、在哪开」的摘要；桌面上不渲染（md:hidden）
  const taskTitle = canvas.tasks.find((task) => task.id === taskId)?.title ?? '这条任务';
  const agentLabel = agent?.label ?? (agentId === '' ? '还没选 agent' : agentId);
  const machineLabel = machine === null ? '还没选机器' : (workers.byId(machine)?.label ?? '这台机器');
  // 底部复核行：这次会开在哪（机器 / 目录），用什么（agent / 模型）。和上面的选择重复一点，
  // 但它是常驻在按钮边上的那一行——滚下去改完目录不用再翻回去确认。
  const chosenWorkspace =
    choice?.type === 'existing'
      ? (workspaceViews.data ?? []).find(({ workspace }) => workspace.id === choice.workspaceId)?.workspace ?? null
      : null;
  const workspaceSummary = (() => {
    if (choice === null) return '还没选工作目录';
    if (choice.type === 'existing') return chosenWorkspace === null ? '已有的工作目录' : workspaceName(chosenWorkspace);
    if (choice.type === 'new_empty') return '仅对话 · 空的临时目录';
    if (choice.type === 'new_temporary') return '新建临时工作目录';
    if (choice.type === 'new_worktree') return '新建隔离目录（新分支）';
    if (choice.type === 'new_group') return `新建组合工作目录（${choice.repoIds.length} 个仓库）`;
    const how = choice.mode === 'link' ? '选已有目录' : canvas.project.repo ? '下载仓库' : '新建空目录';
    return choice.path === null
      ? `新建持久目录 · ${how} · 还没选目录`
      : `新建持久目录 · ${how} · ${shortPath(choice.path)}`;
  })();
  // agent / 模型这块什么时候自己打开：模型没选或配置对不上时，别让人猜「开始」为什么是灰的
  const modelNeedsAttention = model === '' || profileModelUnavailable || unsupportedProfileOptions.length > 0;
  const queryClient = useQueryClient();
  const projectId = canvas.project.id;
  /** 建组失败后把那一组找回来（见 failedGroupIdFromWorkspaces）；找不回来就只留错误，不再抛新错盖住它。 */
  const adoptFailedGroup = async (taskIdForGroup: string, since: number): Promise<WorkspaceGroupView | null> => {
    try {
      const canvasNow = await api.canvas(projectId);
      const id = failedGroupIdFromWorkspaces(canvasNow.workspaces, taskIdForGroup, since);
      if (id === null) return null;
      const found = await api.workspaceGroup(id);
      return found.state === 'failed' ? found : null;
    } catch {
      return null;
    }
  };
  const derive = useMutation({
    mutationFn: async () => {
      if (machine === null) throw new Error('先选机器');
      if (!choice) throw new Error('先选机器和工作目录');
      const place = workers.byId(machine)?.label ?? '这台机器';
      // 选了「新建隔离 worktree」：不在这里建空间，交给 server 按项目配置现建并跑准备命令
      // （workspaceId 为空、workspaceMode=isolated 才会走档位）。
      const isolateNew = choice.type === 'new_worktree';
      const groupNew = choice.type === 'new_group';
      let workspaceId: string | null = null;
      if (isolateNew) {
        workspaceId = null;
        setBusy({ title: '正在准备隔离目录…', scope: place });
      } else if (choice.type === 'existing') workspaceId = choice.workspaceId;
      else if (!groupNew) {
        setPhase('preparing');
        // 进度只说这一趟真正在做的事（下载仓库 / 建目录 / 登记），别拿「下载」概括所有准备。
        if (choice.type === 'new_empty') setBusy({ title: '正在新建空的临时目录…', scope: place });
        else if (choice.type === 'new_temporary') setBusy({ title: '正在新建临时工作目录…', scope: place });
        else if (choice.mode === 'link') setBusy({ title: '正在登记持久工作目录…', scope: `${place} · ${shortPath(choice.path ?? '')}` });
        else if (canvas.project.repo)
          setBusy({
            title: '正在下载仓库…',
            scope: `${place} · ${repoName(canvas.project.repo.url)} → ${shortPath(choice.path ?? '')}`
          });
        else setBusy({ title: '正在新建持久工作目录…', scope: `${place} · ${shortPath(choice.path ?? '')}` });
        const made = await api.createWorkspace(
          projectId,
          choice.type === 'new_empty'
            ? { workerId: machine, kind: 'temporary', taskId, mode: 'empty' }
            : choice.type === 'new_temporary'
              ? { workerId: machine, kind: 'temporary', taskId }
              : longLivedRequest(machine, choice)
        );
        workspaceId = made.id;
        // 建好了就记成「已有的」：重试时不再新建第二个
        setChoice({ type: 'existing', workspaceId });
        await queryClient.invalidateQueries({ queryKey: ['workspaces', projectId] });
      }
      // 组合工作目录（docs/design/multi-repo.md §11.5）：先把每个仓库的 worktree 备好，再派生会话；
      // 只把 groupId 交给 derive，整组跟随。失败留在这页：原因 + 重试准备，不静默吞掉。
      let groupId: string | null = null;
      if (groupNew) {
        if (group !== null && group.state === 'ready') {
          groupId = group.id;
        } else {
          setPhase('preparing');
          setBusy({ title: '正在准备组合工作目录…', scope: `${place} · ${choice.type === 'new_group' ? choice.repoIds.length : 0} 个仓库` });
          const since = Date.now();
          let made: WorkspaceGroupView;
          try {
            made = await api.createWorkspaceGroup(projectId, {
              taskId,
              workerId: machine,
              ...(choice.type === 'new_group' && choice.repoIds.length > 0 ? { repoIds: choice.repoIds } : {})
            });
          } catch (failure) {
            // 后端建组失败时只回错误：成员的工作目录已经登记，带着 groupId。
            // 把那一组找回来，对话框里才能显示原因、并给出「重试准备」。
            const recovered = await adoptFailedGroup(taskId, since);
            if (recovered) setGroup(recovered);
            throw failure;
          }
          setGroup(made);
          if (made.state !== 'ready') {
            throw new Error(made.error?.trim() || '组合工作目录准备失败');
          }
          groupId = made.id;
        }
        await queryClient.invalidateQueries({ queryKey: ['workspace-group', groupId] });
        setPhase('starting');
      } else {
        setPhase(isolateNew ? 'preparing' : 'starting');
      }
      const workspaceMode: 'shared' | 'isolated' | null = isolateNew ? 'isolated' : null;
      // 资产：一项都没取消就不传（旧行为：用项目生效集全部）；取消了就传勾选后的 id（可能为空数组）。
      const assetIds = submitAssetIds(assetEntries, selection);
      // 组合同理：没动过就不传（用项目默认），动过就传当前选中（可能为空数组）。
      const assetSetIds = submitAssetSetIds(chosen);
      return api.derive({
        taskId,
        agentId,
        model,
        workerId: machine,
        ...(workspaceId === null ? {} : { workspaceId }),
        ...(groupId === null ? {} : { groupId }),
        ...(workspaceMode === null ? {} : { workspaceMode }),
        ...(assetIds === undefined ? {} : { assetIds }),
        ...(assetSetIds === undefined ? {} : { assetSetIds }),
        ...(profileId ? { profileId } : {})
      });
    },
    onSettled: () => {
      setBusy(null);
      setPhase('idle');
    },
    onSuccess: async (session) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['canvas', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['workspaces', projectId] })
      ]);
      if (onDerived) onDerived(session);
      else onDone();
    }
  });
  const retryGroup = useMutation({
    mutationFn: (groupId: string) => api.retryWorkspaceGroup(groupId),
    onSuccess: async (next) => {
      setGroup(next);
      // 上一次失败的结论作废：这一组已经重新跑过了
      derive.reset();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workspace-group', next.id] }),
        queryClient.invalidateQueries({ queryKey: ['workspaces', projectId] })
      ]);
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

  const switchAgent = () => {
    setAgentSectionOpen(true);
    setAgentFocusSignal((value) => value + 1);
  };

  return (
    <DialogShell
      title="开始会话"
      onClose={onDone}
      footer={
        <div className="flex flex-col gap-1.5">
          {/* 一行说清一件事：正在等什么 → 还缺什么 → 这次会开在哪。
              进度行按点击那一刻的选项写，不跟着下拉框改口；没用 hover 也能看懂。 */}
          {derive.isPending && busy !== null ? (
            <p data-testid="derive-busy" aria-live="polite" className="text-meta text-secondary">
              {busy.title}
              <span className="text-tertiary"> · {busy.scope}</span>
            </p>
          ) : hint !== null ? (
            <p data-testid="derive-start-hint" className="text-meta text-secondary">
              {hint}
            </p>
          ) : (
            <div data-testid="derive-review" className="flex flex-col gap-0.5 md:hidden">
              <p className="truncate text-meta text-secondary" title={`${machineLabel} · ${workspaceSummary}`}>
                {machineLabel} · {workspaceSummary}
              </p>
              <p className="truncate text-meta text-tertiary" title={`${agentLabel} · ${model === '' ? '还没选模型' : model}`}>
                {agentLabel} · {model === '' ? '还没选模型' : model}
              </p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={SECONDARY_BUTTON} onClick={onDone}>
              取消
            </button>
            <button type="button" className={PRIMARY_BUTTON} disabled={hint !== null || derive.isPending || groupFailed} onClick={() => derive.mutate()}>
              {derive.isPending ? (phase === 'starting' ? '启动中…' : '准备中…') : derive.error ? '重试' : '开始'}
            </button>
          </div>
        </div>
      }
    >
        {/* 手机上抽屉顶端有个拖动条：留 4px，第一行不至于贴着它的边。 */}
        <div className="flex flex-col pt-1 md:pt-0">
        <p className="mb-3 text-head text-primary max-md:hidden">开始会话</p>
        {/* 手机上先给一句「给哪条任务开」：机器、agent、模型在下面的选择区和底部复核行里，不在这里重复 */}
        <section data-testid="derive-target" className="mb-3 max-md:order-2 md:hidden">
          <p className="text-meta text-tertiary">为这条任务开一条新会话</p>
          <p className="mt-0.5 line-clamp-2 text-body text-primary">{taskTitle}</p>
          <p className="mt-0.5 truncate text-meta text-tertiary">{canvas.project.name}</p>
        </section>
        <div data-testid="derive-workspace-region" className="max-md:order-5">
          <WorkspaceChooser
            canvas={canvas}
            taskId={taskId}
            agentId={agentId}
            workers={workers.list}
            machine={machine}
            onMachine={setMachine}
            choice={choice}
            onChoice={(next) => {
              setModeTouched(true);
              // 上一次「重试准备」的错误只针对旧的选项
              if (next?.type !== 'new_group') retryGroup.reset();
              setChoice(next);
            }}
            hubProtocols={hubProtocols}
            groups
            chatOnly
            onSwitchAgent={switchAgent}
          />
        </div>
        <div className="mb-3 max-md:order-6">
          <div className="mb-1 flex items-center justify-between gap-2">
            <label className="block text-meta text-secondary" htmlFor="derive-profile">启动预设（可选）</label>
            <button type="button" className="text-meta text-link underline-offset-2 hover:underline" onClick={() => setProfilesOpen(true)}>
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
        <details
          data-testid="derive-agent-section"
          className="group max-md:order-7 max-md:mb-3 max-md:rounded-md max-md:border max-md:border-hair"
          open={narrow ? agentSectionOpen || modelNeedsAttention : true}
          onToggle={(event) => {
            if (narrow) setAgentSectionOpen(event.currentTarget.open);
          }}
        >
          <summary className="hidden min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 px-3 max-md:flex [&::-webkit-details-marker]:hidden">
            <span className="shrink-0 text-body text-primary">agent 与模型</span>
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-meta text-tertiary">
                {agentLabel} · {model === '' ? '还没选模型' : model}
              </span>
              <Icon name="chevron-down" size={14} className="shrink-0 text-tertiary transition-transform group-open:rotate-180" />
            </span>
          </summary>
        <div className="mb-4 grid grid-cols-1 gap-x-3 sm:grid-cols-2 max-md:mb-0 max-md:px-3 max-md:pb-3">
        <div>
        <label className="mb-1 block text-meta text-secondary" htmlFor="derive-agent">agent</label>
        <select
          id="derive-agent"
          ref={agentPicker}
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
            const covered = why === '未配置模型' && canSelectMachine(worker, candidate.id, hubProtocols);
            const disabled = why !== null && !covered;
            const note = agentNote(why, covered);
            return (
              <option key={candidate.id} value={candidate.id} disabled={disabled}>
                {note ? `${candidate.label}（${note}）` : candidate.label}
              </option>
            );
          })}
        </select>
        </div>
        <div>
        <label className="mb-1 block text-meta text-secondary" htmlFor="derive-model">模型</label>
        {/* 和输入框、Bot 设置同一个选择器：按提供方分组、可搜索；不替人选，空着就写「选择模型…」 */}
        <ModelPicker
          id="derive-model"
          className={`mb-3 ${INPUT}`}
          scope={agentId}
          value={model}
          disabled={offered.models.length === 0}
          onChange={(value) => {
            setProfileId('');
            setModel(value);
          }}
          items={offered.models.map((candidate) => ({ value: candidate, label: candidate }))}
          {...(emptyModel === null ? {} : { placeholder: emptyModel })}
        />
        </div>
        {/* 为什么某个 hub 提供商没出现在上面：把它被剔掉的原因直接写出来，不要让人去猜。 */}
        {hubHidden.length === 0 ? null : (
          <p className="mb-3 text-meta text-tertiary" data-testid="hub-models-hidden">
            {hubHidden.map((item) => `${item.name || item.slug}：${item.reason}`).join('；')}
          </p>
        )}
        </div>
        </details>
        {/* 资产：这一趟要带哪些技能 / 指令 / MCP（默认全选，取消即不带）。手机上换行不横向滚。 */}
        <details
          data-testid="derive-assets-section"
          className="group max-md:order-8 max-md:mb-3 max-md:rounded-md max-md:border max-md:border-hair"
          open={narrow ? assetsSectionOpen : true}
          onToggle={(event) => {
            if (narrow) setAssetsSectionOpen(event.currentTarget.open);
          }}
        >
          <summary className="hidden min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 px-3 max-md:flex [&::-webkit-details-marker]:hidden">
            <span className="shrink-0 text-body text-primary">资产</span>
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-meta text-tertiary">
                {machine === null ? '选好机器后可以看会带哪些' : `这次带 ${includedAssetIds(assetEntries, selection).length} 项`}
              </span>
              <Icon name="chevron-down" size={14} className="shrink-0 text-tertiary transition-transform group-open:rotate-180" />
            </span>
          </summary>
        <div className="mb-3 max-md:mb-0 max-md:px-3 max-md:pb-3" data-testid="derive-assets">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-meta text-secondary">资产</span>
            {machine !== null && assetPlan.data !== undefined ? (
              <span className="text-meta text-tertiary" data-testid="derive-assets-count">
                这次会话带哪些 · {includedAssetIds(assetEntries, selection).length} 项
              </span>
            ) : null}
          </div>
          {sets.length === 0 ? null : (
            <div className="mb-2" data-testid="derive-asset-sets">
              <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
                <span className="text-meta text-secondary">组合</span>
                <span className="text-meta text-tertiary">
                  {chosenSets.length ? `${chosenSets.length} 组 · 按序号叠加` : '这次不带组合'}
                </span>
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {[...chosenSets.map((set, index) => ({ set, order: index + 1 })), ...spareSets.map((set) => ({ set, order: 0 }))].map(
                  ({ set, order }) => {
                    const on = order > 0;
                    return (
                      <li key={set.id} className="max-w-full">
                        <label
                          data-testid="derive-asset-set"
                          data-set-id={set.id}
                          className={`flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-meta ${
                            on ? 'border-fg/40 bg-selected text-primary' : 'border-hair text-tertiary'
                          }`}
                        >
                          <input
                            type="checkbox"
                            data-testid="derive-asset-set-toggle"
                            className="h-3.5 w-3.5 shrink-0 accent-[var(--color-fg)]"
                            checked={on}
                            onChange={(event) => setAssetSetChoice(toggleSetChoice(chosen, set.id, event.target.checked))}
                          />
                          {on ? (
                            <span aria-hidden className="shrink-0 font-mono text-meta text-secondary">
                              {order}
                            </span>
                          ) : null}
                          <span className="min-w-0 break-words">
                            {set.name} · {itemCountText(set.items.length)}
                          </span>
                        </label>
                      </li>
                    );
                  }
                )}
              </ul>
              {chosen.touched ? (
                <p className="mt-1 text-meta text-tertiary" data-testid="derive-asset-sets-note">
                  已改动：{chosen.ids.length ? `这次带 ${chosen.ids.length} 组` : '这次不带组合'}，下面的资产列表仍按项目默认组合显示。
                </p>
              ) : null}
            </div>
          )}
          {machine === null ? (
            <p className="text-meta text-tertiary" data-testid="derive-assets-empty">
              选好机器后可以看会带哪些资产
            </p>
          ) : assetPlan.isLoading ? (
            <p className="text-meta text-tertiary">正在读取这台机器的资产…</p>
          ) : assetPlan.error ? (
            <p className="text-meta text-rust">{(assetPlan.error as Error).message}</p>
          ) : assetEntries.length === 0 ? (
            <p className="text-meta text-tertiary" data-testid="derive-assets-empty">
              这台机器还没有资产
            </p>
          ) : (
            <ul className="flex flex-col">
              {assetEntries.map((entry) => (
                <li key={entry.assetId}>
                  <label
                    data-testid="derive-asset"
                    data-asset-id={entry.assetId}
                    data-problem={entry.problem ? 'true' : undefined}
                    className="flex cursor-pointer items-start gap-2 py-1"
                  >
                    <input
                      type="checkbox"
                      data-testid="derive-asset-toggle"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-fg)]"
                      checked={isIncluded(selection, entry.assetId)}
                      onChange={(event) => setAssetSelection(toggleAsset(selection, entry.assetId, event.target.checked))}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-meta text-primary">{entry.name}</span>
                      <span className="block break-words text-meta text-tertiary">{assetNote(entry)}</span>
                      {entry.problem ? (
                        <span data-testid="derive-asset-problem" className="block break-words text-meta text-rust">
                          {entry.problem}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        </details>
        {derive.error ? (
          <div className="mb-2 max-md:order-4" data-testid="derive-error">
            <p className="text-meta text-rust">{(derive.error as Error).message}</p>
            {cloneErrorHint((derive.error as Error).message) !== null ? (
              <p className="mt-1 text-meta text-tertiary" data-testid="derive-error-hint">
                {cloneErrorHint((derive.error as Error).message)}
              </p>
            ) : null}
          </div>
        ) : null}
        {group !== null && choice?.type === 'new_group' && group.state !== 'ready' ? (
          <div className="mb-2 max-md:order-9 border-l border-rust pl-2" data-testid="derive-group">
            <p className="text-meta text-rust">{groupStateNote(group) ?? '组合工作目录还没准备好'}</p>
            {group.members.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-meta text-tertiary">
                {group.members.map((member) => (
                  <li key={member.workspaceId}>
                    <span className="font-mono text-secondary">{member.name}</span> · {memberStateLabel(member)}
                    {member.error ? `：${member.error}` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            {group.state === 'failed' ? (
              <button
                type="button"
                className="mt-1 min-h-[32px] rounded-sm border border-hair px-2 text-meta text-secondary hover:border-strong hover:text-primary disabled:opacity-40"
                data-testid="derive-group-retry"
                disabled={retryGroup.isPending}
                onClick={() => retryGroup.mutate(group.id)}
              >
                {retryGroup.isPending ? '正在重试…' : '重试准备'}
              </button>
            ) : null}
            {retryGroup.error ? <p className="mt-1 text-meta text-rust">{(retryGroup.error as Error).message}</p> : null}
          </div>
        ) : null}
        {profilesOpen ? <AgentProfilesDialog agents={canvas.agents} onClose={() => setProfilesOpen(false)} /> : null}
        </div>
    </DialogShell>
  );
}
