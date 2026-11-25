import { shortPath, workspaceName } from '../../atoms/workspace-format.ts';
import { Icon } from '../../atoms/icons.tsx';
export { shortPath, workspaceName };
import { LinkWorkspaces } from './link-workspaces.tsx';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CanvasDto, type CreateWorkspaceRequest, type WorkerInfoDto, type WorkspaceDto, type WorkspaceViewDto } from '../../shell/api.ts';
import { DirectoryPicker } from './directory-picker.tsx';
import { projectKeys } from '../../shell/query-keys.ts';
import { WorkerChip, WorkerPicker, resolveWorker, useWorkers } from '../../shell/workers.tsx';
import { RecheckButton, harnessHint, harnessReason } from '../../shell/harness.tsx';
import { machineAvailability, machineSelectable, workerOffersAgent } from '../../shell/harness-gate.ts';
import { useNarrow } from '../../shell/device.ts';

/**
 * 运行面板的核心（docs/design/workspaces.md §9.3）：「在哪台机器、哪个工作目录干活？」
 * - 第一行选机器（只有一台在线就直接用它）；
 * - 下面单选：已有的工作目录 / 仅对话 / 新建持久工作目录 / 新建临时工作目录。
 * - 不预选：持久和临时之间没有默认，也不记上次；没选之前「开始」是灰的。
 */
export type WorkspaceChoice =
  | { readonly type: 'existing'; readonly workspaceId: string }
  | { readonly type: 'new_long_lived'; readonly mode: 'create' | 'link'; readonly path: string | null }
  | { readonly type: 'new_temporary' }
  /** 只聊天：开一个空的临时目录，不下载仓库、不跑准备命令。 */
  | { readonly type: 'new_empty' }
  /** 按项目配置在这台机器上现建一个隔离 worktree（新分支），准备命令跑完才起 agent。 */
  | { readonly type: 'new_worktree' }
  /** 多仓库项目：每个仓库各开一个 worktree，agent 在总目录里工作（docs/design/multi-repo.md §11.5）。 */
  | { readonly type: 'new_group'; readonly repoIds: readonly string[] };

/** 选完了没有：「选已有目录」还没点目录不算。 */
export function choiceReady(choice: WorkspaceChoice | null): boolean {
  if (choice === null) return false;
  if (choice.type === 'new_group') return choice.repoIds.length >= 1;
  // 新建持久工作目录两种方式都得先选好目录（新建 = 选一个空文件夹 / 放仓库的地方；关联 = 已有目录）
  return !(choice.type === 'new_long_lived' && !choice.path);
}

/** 新建持久工作目录的请求体：派生对话框和「换个地方继续」共用。 */
export function longLivedRequest(
  machine: string,
  choice: Extract<WorkspaceChoice, { type: 'new_long_lived' }>
): CreateWorkspaceRequest {
  return { workerId: machine, kind: 'long_lived', mode: choice.mode, ...(choice.path ? { path: choice.path } : {}) };
}

export function useWorkspaceViews(projectId: string) {
  return useQuery({ queryKey: ['workspaces', projectId], queryFn: () => api.workspaces(projectId), refetchInterval: 5000 });
}

export const KIND_LABEL = { long_lived: '持久', temporary: '临时' } as const;
export const KIND_HINT = {
  long_lived: '持久：一直保留',
  temporary: '临时：用完清理（有未保存的改动会保留）'
} as const;
export const CONCURRENT_HINT = '另一个任务也在这里干活，改动可能互相影响';

// 一行标题也撑得住 44px 的触摸高度：选项本身按内容长，别给空行留白（手机上四种方式一屏能比完）。
const ROW = 'flex min-h-[44px] w-full items-start gap-2 rounded-sm border px-3 py-1.5 text-left';
const rowClass = (selected: boolean) => `${ROW} ${selected ? 'border-fg/40 bg-selected' : 'border-hair hover:border-strong'}`;

/** 单选圆点：选中的除了描边还给一个实心点 + 一圈很淡的外环，深色屏上一眼能看出选了哪个。 */
function Radio({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
        on ? 'border-fg' : 'border-strong'
      }`}
    >
      {on ? <span className="block h-2 w-2 rounded-full bg-fg" /> : null}
    </span>
  );
}

export function WorkspaceChooser({
  canvas,
  taskId,
  agentId,
  workers,
  machine,
  onMachine,
  choice,
  onChoice,
  hubProtocols = [],
  groups = false,
  longLivedOnly = false,
  chatOnly = false,
  onSwitchAgent
}: {
  canvas: CanvasDto;
  taskId: string;
  agentId: string;
  workers: readonly WorkerInfoDto[];
  /** 选中的机器（Worker id）；null = 还没选。 */
  machine: string | null;
  onMachine: (workerId: string | null) => void;
  choice: WorkspaceChoice | null;
  onChoice: (choice: WorkspaceChoice | null) => void;
  /** 已有 hub 模型的协议。未配置原生模型时，同协议的机器仍可选，用来再选 hub 模型。 */
  hubProtocols?: readonly string[];
  /**
   * 显示「新建组合工作目录」：只有派生（新会话）能建组，「换个地方继续」是同一个会话，
   * 整组跟随会换掉它的工作目录，所以那儿不出现。
   */
  groups?: boolean;
  /**
   * 只给长期目录：主会话是派工的起点，目录要一直在，所以临时 / 隔离 / 组合都不适用于它。
   * 不是灰掉禁用，是本来就只该有这一种。
   */
  longLivedOnly?: boolean;
  /**
   * 显示「仅对话」：给这条任务开一个空的临时目录，不下载仓库、不跑准备命令。
   * 只有派生新会话时给；「换个地方继续」还是原来那几种，免得悄悄换掉会话的目录类型。
   */
  chatOnly?: boolean;
  /**
   * 有在线机器、但没有一台能跑当前 agent 时的出口：展开并聚焦原来的 agent 选择器。
   * 只有派生对话框有这个选择器；「换个地方继续」是固定 agent，不传。
   */
  onSwitchAgent?: () => void;
}) {
  const views = useWorkspaceViews(canvas.project.id);
  const workerQuery = useWorkers();
  const queryClient = useQueryClient();
  // 「这台机器没有 git 基座」时那个动作按钮：加一就让下面的关联面板展开并滚进视野
  const [linkSignal, setLinkSignal] = useState(0);
  // 手机上把「组合工作目录 / 关联已有目录」收进一行摘要里：选过一次就敞开，别把已选项藏起来
  const narrow = useNarrow();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // 别的机器上的 agent 不可用：默认只留一行汇总，展开才看原因 / 处理提示 / 重新检测。
  const [whyOpen, setWhyOpen] = useState(false);
  const agentLabel = canvas.agents.find((agent) => agent.id === agentId)?.label ?? agentId;
  const local = resolveWorker(workers, null);
  const offers = (worker: WorkerInfoDto) => workerOffersAgent(worker, agentId);
  const machines = workers.filter(offers);
  const online = machines.filter((worker) => worker.state === 'online');
  // 装了不等于能用：没登录 / 没配模型的那台变灰、不能选（老 Worker 不报，当能用）。
  // 和空态分类、派生对话框底部的说明共用 machineSelectable，避免三处条件慢慢漂开。
  const selectable = (worker: WorkerInfoDto) => machineSelectable(worker, agentId, hubProtocols);
  const blocked = online.filter((worker) => !selectable(worker));
  const usable = online.filter(selectable);
  const availability = machineAvailability(workers, agentId, hubProtocols, {
    loading: workers.length === 0 && workerQuery.loading,
    failed: workers.length === 0 && workerQuery.failed
  });
  const canSwitchAgent = onSwitchAgent !== undefined;
  const availabilityText = (() => {
    switch (availability.kind) {
      case 'unknown':
        return availability.loading ? '正在读取机器状态…' : '机器状态没读到。检查网络后重试。';
      case 'no-agent':
        return '还没有可用的 agent。先让一台装着 agent 的机器上线，再回来开始。';
      case 'no-machines':
        return '还没有接入机器。先在「机器」里接入一台，再回来开始。';
      case 'all-offline':
        return '现在没有在线的机器。打开一台已接入的机器，或接入一台新的，再回来开始。';
      case 'agent-unavailable':
        if (availability.missing > 0 && availability.blocked > 0) {
          return canSwitchAgent
            ? `在线的机器上有的没装 ${agentLabel}，有的暂时用不了。换一个 agent，或按下面的原因修好再回来。`
            : `在线的机器上有的没装 ${agentLabel}，有的暂时用不了。换一台装着它的机器，或按下面的原因修好再回来。`;
        }
        if (availability.missing > 0) {
          return canSwitchAgent
            ? `在线的机器上都没有 ${agentLabel}。换一个 agent，或先在这台机器上安装它。`
            : `在线的机器上都没有 ${agentLabel}。换一台装着它的机器，或先安装它。`;
        }
        return canSwitchAgent
          ? `在线的机器上 ${agentLabel} 暂时都用不了。换一个 agent，或按下面的原因修好再回来。`
          : `在线的机器上 ${agentLabel} 暂时都用不了。换一台机器，或按下面的原因修好再回来。`;
      case 'available':
        return null;
    }
  })();
  const recheckMachines = () => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workers'] }),
      queryClient.invalidateQueries({ queryKey: projectKeys.canvas(canvas.project.id) })
    ]);
  };

  // 只有一台能用的机器：直接用它（不是「默认」，是没得选）
  useEffect(() => {
    if (machine === null && usable.length === 1) onMachine(usable[0]!.workerId);
    // 机器还在、只是这台上的 agent 暂时探测失败、或机器短暂离线：保留用户选的机器，
    // 连带选择器里正在浏览的目录。启动由各对话框的可用性检查挡住，不替人换机器。
    // 只有这台机器彻底不提供当前 agent 了（比如换了 agent）才清掉；列表短暂为空时保留，别误清。
    if (machine !== null && workers.length > 0 && !workers.some((worker) => worker.workerId === machine && offers(worker))) {
      onMachine(null);
    }
  }, [machine, usable, workers, agentId, onMachine]);

  // 工作目录的 workerId null = hub 本机 → 本机那台 Worker
  const hostOf = (workspace: WorkspaceDto) => workspace.workerId ?? local?.workerId ?? null;
  const lastUsed = useMemo(() => {
    const at = new Map<string, number>();
    for (const session of canvas.sessions) {
      if (session.workspaceId) at.set(session.workspaceId, Math.max(at.get(session.workspaceId) ?? 0, session.updatedAt));
    }
    return at;
  }, [canvas.sessions]);
  const here: WorkspaceViewDto[] = (views.data ?? [])
    .filter(({ workspace }) => machine !== null && hostOf(workspace) === machine)
    .filter(({ workspace }) => workspace.state === 'ready' || workspace.state === 'kept')
    .filter(({ workspace }) => workspace.kind === 'long_lived' || workspace.ownerTaskId === taskId)
    .sort(
      (a, b) =>
        (lastUsed.get(b.workspace.id) ?? b.workspace.createdAt) - (lastUsed.get(a.workspace.id) ?? a.workspace.createdAt)
    );

  // 换机器：之前选的工作目录不在这台上了，清掉，免得误开到别处
  useEffect(() => {
    if (choice?.type === 'existing' && !here.some(({ workspace }) => workspace.id === choice.workspaceId)) onChoice(null);
  }, [choice, here, onChoice]);

  // 这台机器上能不能开 worktree：有 git 的持久工作目录，或者项目绑了仓库（会先下载）
  const sameMachine = (views.data ?? []).filter(({ workspace }) => machine !== null && hostOf(workspace) === machine);
  const gitHere =
    canvas.project.repo !== null ||
    sameMachine.some(({ workspace }) => workspace.kind === 'long_lived' && workspace.isGit === true && workspace.state !== 'removed');
  const temporariesHere = sameMachine.filter(
    ({ workspace }) => workspace.kind === 'temporary' && workspace.ownerTaskId === taskId && workspace.state !== 'removed'
  ).length;

  const machineName = workers.find((worker) => worker.workerId === machine)?.label ?? '这台机器';
  // 选中的机器还在列表里，但此刻开不了（agent 探测失败 / 机器离线）：保留选择，只把原因说清。
  const chosenWorker = machine === null ? undefined : workers.find((worker) => worker.workerId === machine);
  const chosenMissingAgent = chosenWorker !== undefined && !offers(chosenWorker);
  const chosenBlock =
    chosenWorker === undefined
      ? null
      : chosenWorker.state !== 'online'
        ? 'offline'
        : harnessReason(chosenWorker, agentId)?.trim() || null;
  const groupSelected = choice?.type === 'new_group';
  const groupNode =
    groups && !longLivedOnly && Boolean(canvas.project.primaryRepoId) && canvas.project.repos.length > 1 ? (
      <NewGroup canvas={canvas} machineName={machineName} choice={choice} onChoice={onChoice} />
    ) : null;
  const linkNode = (
    <LinkWorkspaces
      projectId={canvas.project.id}
      linked={(views.data ?? []).map(({ workspace }) => workspace.id)}
      workerId={machine}
      expandSignal={linkSignal}
      onLinked={(workspaceId) => onChoice({ type: 'existing', workspaceId })}
    />
  );

  return (
    <section aria-label="工作目录" className="mb-3">
      {machines.length > 0 && machines.length < 2 ? (
        <p className="mb-1 text-meta text-secondary" title="干活的那台电脑。agent 在它上面读写文件、执行命令。">机器</p>
      ) : null}
      {availabilityText === null ? null : (
        <div
          data-testid="machine-availability"
          data-kind={availability.kind}
          aria-live="polite"
          className="mb-3 border-l-2 border-rust pl-2 text-meta text-secondary"
        >
          <p>{availabilityText}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {availability.kind === 'agent-unavailable' && onSwitchAgent !== undefined ? (
              <button
                type="button"
                data-testid="derive-switch-agent"
                className="min-h-[44px] rounded-sm border border-hair px-2 text-meta text-secondary hover:border-strong hover:text-primary md:min-h-[28px]"
                onClick={onSwitchAgent}
              >
                换 Agent
              </button>
            ) : null}
            {availability.kind === 'no-agent' ||
            availability.kind === 'no-machines' ||
            availability.kind === 'all-offline' ||
            (availability.kind === 'unknown' && !availability.loading) ||
            (availability.kind === 'agent-unavailable' && availability.blocked === 0) ? (
              <button
                type="button"
                className="min-h-[44px] rounded-sm border border-hair px-2 text-meta text-secondary hover:border-strong md:min-h-[28px]"
                onClick={recheckMachines}
              >
                重新检查
              </button>
            ) : null}
          </div>
        </div>
      )}
      {chosenMissingAgent ? (
        <div data-testid="machine-selected-incompatible" className="mb-3 text-meta text-secondary">
          <p>已选机器：<WorkerChip worker={chosenWorker} /></p>
          <p className="mt-1">这台机器没有 {agentLabel}。已保留机器和目录；要在其他机器上开始，请重新选择机器。</p>
        </div>
      ) : null}
      {machines.length === 1 && usable.length > 0 && (machine === null || machine === machines[0]?.workerId) ? (
        <p className="mb-3">
          <WorkerChip worker={machines[0]} />
        </p>
      ) : machines.length === 1 && usable.length > 0 ? (
        <div className="mb-3">
          <p className="mb-1 text-meta text-secondary">选择其他机器</p>
          <button type="button" data-testid="machine-select-alternative" className="min-h-[44px] rounded-sm border border-hair px-2 text-meta text-secondary hover:border-strong hover:text-primary md:min-h-[32px]" onClick={() => onMachine(machines[0]!.workerId)}>
            {machines[0]!.label}
          </button>
        </div>
      ) : machines.length >= 2 ? (
        <WorkerPicker
          label="机器"
          workers={machines}
          value={machine}
          onChange={onMachine}
          unavailable={(worker) =>
            machineSelectable(worker, agentId, hubProtocols) ? null : harnessReason(worker, agentId) ?? '暂不可用'
          }
        />
      ) : null}
      {machine === null || chosenBlock === null ? null : (
        <p data-testid="machine-blocked" className="mb-3 border-l border-rust pl-2 text-meta text-secondary">
          {chosenBlock === 'offline' ? (
            <>这台机器现在不在线。选好的机器和目录都保留；等它回来再开始。</>
          ) : (
            <>这台机器上的 {agentLabel} 暂时用不了：{chosenBlock}。选好的机器和目录都保留；等它恢复再开始。</>
          )}
        </p>
      )}
      {blocked.length > 0 ? (
        // 别的机器为什么不能选：一行汇总就够（已选机器的工作目录才是主线）。
        // 原因和处理办法收进 details，需要时再展开，别在手机上占掉半屏。
        <details
          data-testid="harness-unavailable"
          open={usable.length === 0 ? true : whyOpen}
          onToggle={(event) => {
            if (usable.length > 0) setWhyOpen(event.currentTarget.open);
          }}
          className="group mb-3 rounded-sm border border-hair"
        >
          <summary className="flex min-h-[36px] cursor-pointer list-none items-center justify-between gap-2 px-2 py-1 text-meta text-secondary [&::-webkit-details-marker]:hidden">
            {/* 机器那一行已经写着哪台、为什么（灰掉的格子带原因），这里只留一个「看处理办法」的入口，
                不把同一句话再念一遍。 */}
            <span className="min-w-0 truncate">
              {blocked.length === 1
                ? `「${blocked[0]!.label}」上的 ${agentLabel} 为什么用不了`
                : `${blocked.length} 台机器上的 ${agentLabel} 为什么用不了`}
            </span>
            <Icon name="chevron-down" size={14} className="shrink-0 text-tertiary transition-transform group-open:rotate-180" />
          </summary>
          <ul className="space-y-1 border-t border-hair px-2 py-1.5">
            {blocked.map((worker) => (
              <li key={worker.workerId} data-testid="harness-unavailable-item" className="text-meta">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 text-secondary">
                    {blocked.length === 1 ? '原因：' : `${worker.label}：`}
                    <span className="text-rust">{harnessReason(worker, agentId) ?? '暂不可用'}</span>
                  </span>
                  <RecheckButton workerId={worker.workerId} />
                </span>
                {harnessHint(worker, agentId) === null ? null : (
                  <span className="block text-tertiary">{harnessHint(worker, agentId)}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {machine === null ? null : (
        <>
          {/* 标题行顺带说「这台机器上还没有」：不再单独占一行灰字，把纵向空间留给可选方式。 */}
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <p className="min-w-0 truncate text-meta text-secondary" title="机器上的一个文件夹，agent 只在这里面干活。">工作目录</p>
            {views.isLoading ? (
              <span className="shrink-0 text-meta text-tertiary">正在读取…</span>
            ) : here.length === 0 ? (
              <span data-testid="ws-none-linked" className="shrink-0 text-meta text-tertiary">这台机器上还没有</span>
            ) : null}
          </div>
          <div role="radiogroup" aria-label="选择工作目录" className="flex flex-col gap-1.5">
            {here.map(({ workspace, runningTaskIds, otherProjectSessions }) => {
              const selected = choice?.type === 'existing' && choice.workspaceId === workspace.id;
              const others = runningTaskIds.some((id) => id !== taskId);
              return (
                <button
                  key={workspace.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={rowClass(selected)}
                  onClick={() => onChoice({ type: 'existing', workspaceId: workspace.id })}
                >
                  <Radio on={selected} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-primary">
                      {workspaceName(workspace)}
                      <span className="text-meta text-tertiary" title={KIND_HINT[workspace.kind]}>
                        {' · '}
                        {KIND_LABEL[workspace.kind]}
                        {workspace.state === 'kept' ? ' · 已保留' : ''}
                        {workspace.branch ? ` · ${workspace.branch}` : ''}
                      </span>
                    </span>
                    <span className="block truncate font-mono text-meta text-tertiary" title={workspace.path}>
                      {shortPath(workspace.path)}
                    </span>
                    {others ? (
                      <span className="mt-0.5 block text-meta text-rust" title={CONCURRENT_HINT}>
                        ⚠ {CONCURRENT_HINT}
                      </span>
                    ) : null}
                    {(otherProjectSessions ?? 0) > 0 ? (
                      // 独占归属下恒为 0；留着只是因为老后端还会算这个数。
                      <span data-testid="ws-other-projects" className="mt-0.5 block text-meta text-tertiary">
                        这个目录已归本项目独占
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            {chatOnly && !longLivedOnly ? (
              <NewEmpty
                machineName={machineName}
                selected={choice?.type === 'new_empty'}
                onSelect={() => onChoice({ type: 'new_empty' })}
              />
            ) : null}
            {longLivedOnly ? null : (
            <NewTemporary
              canvas={canvas}
              taskId={taskId}
              machineName={machineName}
              gitHere={gitHere}
              existing={temporariesHere}
              selected={choice?.type === 'new_temporary'}
              onSelect={() => onChoice({ type: 'new_temporary' })}
            />
            )}
            {longLivedOnly ? null : (
            <NewWorktree
              canvas={canvas}
              taskId={taskId}
              machineName={machineName}
              gitHere={gitHere}
              selected={choice?.type === 'new_worktree'}
              onSelect={() => onChoice({ type: 'new_worktree' })}
              onFixGit={() => setLinkSignal((value) => value + 1)}
            />
            )}
            <NewLongLived
              canvas={canvas}
              machine={machine}
              machineName={machineName}
              choice={choice}
              onChoice={onChoice}
            />
            {/* 手机：常用三种排在前面，不常用的两种折起来，别插在中间打断比较。 */}
            {narrow ? (
              <details
                data-testid="ws-advanced"
                open={advancedOpen || groupSelected}
                onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
                className="group rounded-sm border border-hair"
              >
                <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 px-2 text-meta text-secondary [&::-webkit-details-marker]:hidden">
                  <span>更多创建方式</span>
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate text-right text-meta text-tertiary">
                      {groupSelected ? '已选：组合工作目录' : '多仓组合、关联已有目录'}
                    </span>
                    <Icon name="chevron-down" size={14} className="shrink-0 text-tertiary transition-transform group-open:rotate-180" />
                  </span>
                </summary>
                <div className="flex flex-col gap-1.5 p-1">
                  {groupNode}
                  {linkNode}
                </div>
              </details>
            ) : null}
          </div>
          {/* 关联入口放在所有 radio 之后：单选组要连续，它是组外的补充（样式也就轻一层）。 */}
          {narrow ? null : (
            <>
              {groupNode}
              {linkNode}
            </>
          )}
        </>
      )}
    </section>
  );
}

function NewLongLived({
  canvas,
  machine,
  machineName,
  choice,
  onChoice
}: {
  canvas: CanvasDto;
  machine: string;
  machineName: string;
  choice: WorkspaceChoice | null;
  onChoice: (choice: WorkspaceChoice) => void;
}) {
  const selected = choice?.type === 'new_long_lived';
  const [picking, setPicking] = useState(false);
  return (
    <div className={`${rowClass(selected)} flex-col`}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        className="flex w-full items-start gap-2 text-left"
        onClick={() => {
          if (selected) return;
          onChoice({ type: 'new_long_lived', mode: 'create', path: null });
          setPicking(true);
        }}
      >
        <Radio on={selected} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body text-primary">
            新建持久工作目录
            {selected ? null : <span className="text-meta text-tertiary"> · 一直保留</span>}
          </span>
        </span>
      </button>
      {selected ? (
        <div className="w-full pl-5">
          <div className="mb-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="怎么新建">
            {(
              [
                ['create', canvas.project.repo ? '下载仓库' : '新建空目录'],
                ['link', '选已有目录']
              ] as const
            ).map(([mode, text]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={choice.mode === mode}
                className={`min-h-[32px] rounded-sm border px-2 text-meta ${
                  choice.mode === mode ? 'border-fg/40 bg-selected text-primary' : 'border-hair text-secondary hover:border-strong'
                }`}
                onClick={() => {
                  if (choice.mode === mode) return;
                  onChoice({ type: 'new_long_lived', mode, path: null });
                  setPicking(true);
                }}
              >
                {text}
              </button>
            ))}
          </div>
          <p className="text-meta text-tertiary">
            {choice.path === null ? (
              choice.mode === 'link' ? (
                '选一个这台机器上已有的目录'
              ) : canvas.project.repo ? (
                <>
                  选一个空文件夹放 <span className="font-mono">{repoName(canvas.project.repo.url)}</span>（可以就地「新建文件夹」）
                </>
              ) : (
                '选一个空文件夹（可以就地「新建文件夹」）'
              )
            ) : choice.mode === 'link' ? (
              <>
                将把 <span className="font-mono">{shortPath(choice.path)}</span> 登记成持久工作目录（不会删它）
              </>
            ) : canvas.project.repo ? (
              <>
                将把 <span className="font-mono">{repoName(canvas.project.repo.url)}</span> 下载到 {machineName} 的{' '}
                <span className="font-mono">{shortPath(choice.path)}</span>（用这台机器自己的 git 凭据）
              </>
            ) : (
              <>
                将在 {machineName} 的 <span className="font-mono">{shortPath(choice.path)}</span> 新建持久工作目录
              </>
            )}
            <button type="button" className="ml-2 text-link hover:underline" onClick={() => setPicking((open) => !open)}>
              {picking ? '收起' : choice.path ? '换一个' : '浏览…'}
            </button>
          </p>
          {picking ? (
            <div className="mt-2">
              {/* 和建项目选目录同一个选择器：从托管目录起步、能就地「新建文件夹」、手机全屏 */}
              <DirectoryPicker
                workerId={machine}
                project={canvas.project.name}
                onCancel={() => setPicking(false)}
                onPick={(path) => {
                  onChoice({ type: 'new_long_lived', mode: choice.mode, path });
                  setPicking(false);
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 和服务端 branchSlug 同一规则，只用来预告分支名（短 id 建好才知道）。 */
export function branchPreview(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return `agent-hub/${slug === '' ? 'task' : slug}-…`;
}

/**
 * 仅对话：这条任务不需要仓库里的代码，只要一个干净的临时目录聊天。
 * 和「新建临时工作目录」的区别是它绝不碰仓库——不下载、不开 worktree、不跑准备命令。
 */
function NewEmpty({
  machineName,
  selected,
  onSelect
}: {
  machineName: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid="ws-new-empty"
      className={rowClass(selected)}
      onClick={onSelect}
    >
      <Radio on={selected} />
      <span className="min-w-0 flex-1">
        <span className="block text-body text-primary">仅对话</span>
        <span className="mt-0.5 block text-meta text-secondary">空的临时目录，不下载仓库、不运行准备命令</span>
        {selected ? (
          <span className="mt-1 block text-meta text-tertiary">
            在 {machineName} 的 <span className="font-mono">~/agent-hub-workspaces/.tmp/</span> 下新建
            <span className="block">有未保存的改动会保留并提醒你</span>
          </span>
        ) : null}
      </span>
    </button>
  );
}

function NewTemporary({
  canvas,
  taskId,
  machineName,
  gitHere,
  existing,
  selected,
  onSelect
}: {
  canvas: CanvasDto;
  taskId: string;
  machineName: string;
  gitHere: boolean;
  existing: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const title = canvas.tasks.find((task) => task.id === taskId)?.title ?? '';
  return (
    <button type="button" role="radio" aria-checked={selected} className={rowClass(selected)} onClick={onSelect}>
      <Radio on={selected} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-primary">
          新建临时工作目录
          {selected ? null : <span className="text-meta text-tertiary"> · 用完清理</span>}
        </span>
        {existing > 0 ? (
          <span className="mt-0.5 block text-meta text-rust">这个任务已经有 {existing} 个临时工作目录</span>
        ) : null}
        {selected ? (
          <span className="mt-1 block text-meta text-secondary">
            {gitHere ? (
              <>
                新开分支 <span className="font-mono">{branchPreview(title)}</span>（在 {machineName} 上）
              </>
            ) : (
              <>
                在 {machineName} 的 <span className="font-mono">~/agent-hub-workspaces/.tmp/</span> 下建空目录
              </>
            )}
            <span className="block text-tertiary">有未保存的改动会保留并提醒你</span>
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * 隔离 worktree：和「新建临时工作目录」是同一件事的两种口径——
 * 临时空间是「随便一个目录」，worktree 是「按项目配置开的分支目录 + 准备命令」。
 * 放在工作目录选择里而不是对话框上的复选框：机器和工作目录本来就是一起选的。
 */
function NewWorktree({
  canvas,
  taskId,
  machineName,
  gitHere,
  selected,
  onSelect,
  onFixGit
}: {
  canvas: CanvasDto;
  taskId: string;
  machineName: string;
  gitHere: boolean;
  selected: boolean;
  onSelect: () => void;
  /** 「关联 git 目录」：就地展开下面的关联面板。 */
  onFixGit: () => void;
}) {
  const title = canvas.tasks.find((task) => task.id === taskId)?.title ?? '';
  const setup = canvas.project.worktree?.setup ?? null;
  return (
    <div className={`${rowClass(selected)} flex-col`}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-disabled={gitHere ? undefined : true}
        data-testid="ws-new-worktree"
        className="flex w-full items-start gap-2 text-left"
        onClick={() => {
          if (!gitHere) return;
          onSelect();
        }}
        title={gitHere ? undefined : '这台机器上还没有可用的 git 目录：先关联一个，或给项目绑定仓库'}
      >
        <Radio on={selected} />
        <span className={`min-w-0 flex-1 ${gitHere ? '' : 'opacity-60'}`}>
          <span className="block truncate text-body text-primary">
            新建隔离目录（新分支）
            {gitHere && !selected ? <span className="text-meta text-tertiary"> · 不影响当前目录</span> : null}
          </span>
          {gitHere && selected ? (
            <span className="mt-1 block text-meta text-secondary">
              在 {machineName} 上新开分支 <span className="font-mono">{branchPreview(title)}</span>
              {setup?.command ? '，先跑项目配置的准备命令，跑完才起 agent' : ''}
            </span>
          ) : null}
        </span>
      </button>
      {/* 不可用不只是一行灰字：留着这一行（用户会来这儿找），说清缺什么，再给一个能点的动作。
          只占一行，不抢选中项的版面。 */}
      {gitHere ? null : (
        <p data-testid="ws-new-worktree-blocked" className="mt-0.5 flex w-full flex-wrap items-center gap-x-2 pl-[22px] text-meta text-tertiary">
          <span>这台机器还没有 git 目录</span>
          <button
            type="button"
            data-testid="ws-new-worktree-fix"
            className="min-h-[32px] shrink-0 rounded-sm px-1.5 text-link underline-offset-2 hover:underline"
            title="也可以在项目设置里绑定仓库"
            onClick={onFixGit}
          >
            关联 git 目录
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * 组合工作目录：项目有多个仓库时才会出现。每个仓库在新目录里各开一个 worktree，
 * 子目录名就是仓库名；agent 在总目录里工作，跨仓库的改动一次提交。
 * 只在指定了主仓库且 repos.length > 1 时挂载。
 */
function NewGroup({
  canvas,
  machineName,
  choice,
  onChoice
}: {
  canvas: CanvasDto;
  machineName: string;
  choice: WorkspaceChoice | null;
  onChoice: (choice: WorkspaceChoice) => void;
}) {
  const repos = canvas.project.repos;
  const primaryId = canvas.project.primaryRepoId ?? null;
  const selected = choice?.type === 'new_group';
  const repoIds = selected && choice.type === 'new_group' ? choice.repoIds : repos.map((repo) => repo.id);
  const toggle = (id: string, on: boolean) => {
    if (id === primaryId) return;
    const next = on ? [...new Set([...repoIds, id])] : repoIds.filter((item) => item !== id);
    if (primaryId && !next.includes(primaryId)) next.unshift(primaryId);
    if (next.length === 0) return;
    onChoice({ type: 'new_group', repoIds: next });
  };
  return (
    <div className={`${rowClass(selected)} flex-col`}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        data-testid="ws-new-group"
        className="flex w-full items-start gap-2 text-left"
        onClick={() => onChoice({ type: 'new_group', repoIds: repos.map((repo) => repo.id) })}
      >
        <Radio on={selected} />
        <span className="min-w-0 flex-1">
          <span className="block text-body text-primary">新建组合工作目录（{repoIds.length}/{repos.length}）</span>
        </span>
      </button>
      {selected ? (
        <div className="mt-1 ml-6 space-y-1 text-meta text-secondary">
          <p>在 {machineName} 上，主仓库是工作目录，其他在 ../repos/ 下。</p>
          {repos.map((repo) => {
            const checked = repoIds.includes(repo.id);
            const locked = repo.id === primaryId;
            return (
              <label key={repo.id} className="flex items-center gap-2" data-testid={`ws-group-repo-${repo.name}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={locked}
                  onChange={(event) => toggle(repo.id, event.target.checked)}
                />
                <span className="font-mono">
                  {repo.name}
                  {locked ? '（主仓库）' : ''}
                  {repo.defaultBranch ? `@${repo.defaultBranch}` : ''}
                </span>
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** github.com/me/foo：去掉协议、凭据和 .git，给人看。 */
export function repoName(url: string): string {
  return url
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:(?!\d)/, '/')
    .replace(/\.git$/, '');
}
