import { shortPath, workspaceName } from '../../atoms/workspace-format.ts';
export { shortPath, workspaceName };
import { LinkWorkspaces } from './link-workspaces.tsx';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type CanvasDto, type CreateWorkspaceRequest, type WorkerInfoDto, type WorkspaceDto, type WorkspaceViewDto } from '../../shell/api.ts';
import { DirectoryPicker } from './directory-picker.tsx';
import { WorkerChip, WorkerPicker, resolveWorker } from '../../shell/workers.tsx';
import { RecheckButton, harnessHint, harnessReason } from '../../shell/harness.tsx';
import { canSelectMachine } from '../../shell/harness-gate.ts';

/**
 * 运行面板的核心（docs/design/workspaces.md §9.3）：「在哪台机器、哪个工作空间干活？」
 * - 第一行选机器（只有一台在线就直接用它）；
 * - 下面单选：已有的工作空间 / 新建持久工作空间 / 新建临时工作空间。
 * - 不预选：持久和临时之间没有默认，也不记上次；没选之前「开始」是灰的。
 */
export type WorkspaceChoice =
  | { readonly type: 'existing'; readonly workspaceId: string }
  | { readonly type: 'new_long_lived'; readonly mode: 'create' | 'link'; readonly path: string | null }
  | { readonly type: 'new_temporary' }
  /** 按项目配置在这台机器上现建一个隔离 worktree（新分支），准备命令跑完才起 agent。 */
  | { readonly type: 'new_worktree' }
  /** 多仓库项目：每个仓库各开一个 worktree，agent 在总目录里工作（docs/design/multi-repo.md §11.5）。 */
  | { readonly type: 'new_group' };

/** 选完了没有：「选已有目录」还没点目录不算。 */
export function choiceReady(choice: WorkspaceChoice | null): boolean {
  if (choice === null) return false;
  // 新建持久工作空间两种方式都得先选好目录（新建 = 选一个空文件夹 / 放仓库的地方；关联 = 已有目录）
  return !(choice.type === 'new_long_lived' && !choice.path);
}

/** 新建持久工作空间的请求体：派生对话框和「换个地方继续」共用。 */
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
  long_lived: '持久：一直保留，下次还能接着用。',
  temporary: '临时：任务结束后自动清理；有未保存的改动会保留并提醒你。'
} as const;
export const CONCURRENT_HINT = '另一个任务也在这里干活，改动可能互相影响';

const ROW = 'flex min-h-[56px] w-full items-start gap-2 rounded-sm border px-3 py-2 text-left';
const rowClass = (selected: boolean) => `${ROW} ${selected ? 'border-accent bg-card' : 'border-hair hover:border-strong'}`;

/** 单选圆点：选中的除了描边还给一个实心点 + 一圈很淡的外环，深色屏上一眼能看出选了哪个。 */
function Radio({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
        on ? 'border-accent ring-2 ring-accent/20' : 'border-strong'
      }`}
    >
      {on ? <span className="block h-2 w-2 rounded-full bg-accent" /> : null}
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
  groups = false
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
   * 显示「新建组合工作空间」：只有派生（新会话）能建组，「换个地方继续」是同一个会话，
   * 整组跟随会换掉它的工作空间，所以那儿不出现。
   */
  groups?: boolean;
}) {
  const views = useWorkspaceViews(canvas.project.id);
  // 「这台机器没有 git 基座」时那个动作按钮：加一就让下面的关联面板展开并滚进视野
  const [linkSignal, setLinkSignal] = useState(0);
  const agentLabel = canvas.agents.find((agent) => agent.id === agentId)?.label ?? agentId;
  const local = resolveWorker(workers, null);
  const offers = (worker: WorkerInfoDto) => (worker.agentIds ?? [agentId]).includes(agentId);
  const machines = workers.filter(offers);
  const online = machines.filter((worker) => worker.state === 'online');
  // 装了不等于能用：没登录 / 没配模型的那台变灰、不能选（老 Worker 不报，当能用）
  const selectable = (worker: WorkerInfoDto) => canSelectMachine(worker, agentId, hubProtocols);
  const blocked = online.filter((worker) => !selectable(worker));
  const usable = online.filter(selectable);

  // 只有一台能用的机器：直接用它（不是「默认」，是没得选）
  useEffect(() => {
    if (machine === null && usable.length === 1) onMachine(usable[0]!.workerId);
    if (machine !== null && !usable.some((worker) => worker.workerId === machine)) onMachine(null);
  }, [machine, usable, onMachine]);

  // 工作空间的 workerId null = hub 本机 → 本机那台 Worker
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

  // 换机器：之前选的工作空间不在这台上了，清掉，免得误开到别处
  useEffect(() => {
    if (choice?.type === 'existing' && !here.some(({ workspace }) => workspace.id === choice.workspaceId)) onChoice(null);
  }, [choice, here, onChoice]);

  // 这台机器上能不能开 worktree：有 git 的持久工作空间，或者项目绑了仓库（会先下载）
  const sameMachine = (views.data ?? []).filter(({ workspace }) => machine !== null && hostOf(workspace) === machine);
  const gitHere =
    canvas.project.repo !== null ||
    sameMachine.some(({ workspace }) => workspace.kind === 'long_lived' && workspace.isGit === true && workspace.state !== 'removed');
  const temporariesHere = sameMachine.filter(
    ({ workspace }) => workspace.kind === 'temporary' && workspace.ownerTaskId === taskId && workspace.state !== 'removed'
  ).length;

  const machineName = machines.find((worker) => worker.workerId === machine)?.label ?? '这台机器';

  return (
    <section aria-label="工作空间" className="mb-3">
      {machines.length < 2 || usable.length === 0 ? (
        <p className="mb-1 text-meta text-secondary" title="干活的那台电脑。agent 在它上面读写文件、执行命令。">机器</p>
      ) : null}
      {online.length === 0 ? (
        <p className="mb-3 border-l border-rust pl-2 text-meta text-secondary">
          现在没有在线的机器。打开一台已接入的机器，或者接入一台新的。
        </p>
      ) : machines.length < 2 && usable.length > 0 ? (
        <p className="mb-3">
          <WorkerChip worker={machines[0]} />
        </p>
      ) : machines.length >= 2 ? (
        <WorkerPicker
          label="机器"
          workers={machines}
          value={machine}
          onChange={onMachine}
          unavailable={(worker) => harnessReason(worker, agentId)}
        />
      ) : null}
      {blocked.length > 0 ? (
        <div data-testid="harness-unavailable" className="mb-3 border-l border-rust pl-2 text-meta text-secondary">
          {blocked.map((worker) => (
            <p key={worker.workerId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0">
                「{worker.label}」上的 {agentLabel} 暂不可用：<span className="text-rust">{harnessReason(worker, agentId)}</span>
                {harnessHint(worker, agentId) ? <span className="block text-tertiary">{harnessHint(worker, agentId)}</span> : null}
              </span>
              <RecheckButton workerId={worker.workerId} />
            </p>
          ))}
        </div>
      ) : null}

      {machine === null ? null : (
        <>
          <p className="mb-1 text-meta text-secondary" title="机器上的一个文件夹，agent 只在这里面干活。">工作空间</p>
          <div role="radiogroup" aria-label="选择工作空间" className="flex flex-col gap-1.5">
            {views.isLoading ? <p className="text-meta text-tertiary">正在读取工作空间…</p> : null}
            {!views.isLoading && here.length === 0 ? (
              <p data-testid="ws-none-linked" className="text-meta text-tertiary">本项目在这台机器上还没有关联工作空间。关联一个团队里已有的，或者新建一个。</p>
            ) : null}
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
                      <span data-testid="ws-other-projects" className="mt-0.5 block text-meta text-rust" title={CONCURRENT_HINT}>
                        ⚠ 其他项目有 {otherProjectSessions} 个会话也在这里干活
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            <NewTemporary
              canvas={canvas}
              taskId={taskId}
              machineName={machineName}
              gitHere={gitHere}
              existing={temporariesHere}
              selected={choice?.type === 'new_temporary'}
              onSelect={() => onChoice({ type: 'new_temporary' })}
            />
            <NewWorktree
              canvas={canvas}
              taskId={taskId}
              machineName={machineName}
              gitHere={gitHere}
              selected={choice?.type === 'new_worktree'}
              onSelect={() => onChoice({ type: 'new_worktree' })}
              onFixGit={() => setLinkSignal((value) => value + 1)}
            />
            {groups && canvas.project.repos.length > 1 ? (
              <NewGroup
                canvas={canvas}
                machineName={machineName}
                selected={choice?.type === 'new_group'}
                onSelect={() => onChoice({ type: 'new_group' })}
              />
            ) : null}
            <NewLongLived
              canvas={canvas}
              machine={machine}
              machineName={machineName}
              choice={choice}
              onChoice={onChoice}
            />
          </div>
          {/* 关联入口放在所有 radio 之后：单选组要连续，它是组外的补充（样式也就轻一层）。 */}
          <LinkWorkspaces
            projectId={canvas.project.id}
            linked={(views.data ?? []).map(({ workspace }) => workspace.id)}
            workerId={machine}
            expandSignal={linkSignal}
            onLinked={(workspaceId) => onChoice({ type: 'existing', workspaceId })}
          />
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
          <span className="block text-body text-primary">新建持久工作空间</span>
          <span className="block text-meta text-tertiary">一直保留，下次还能接着用</span>
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
                  choice.mode === mode ? 'border-accent text-primary' : 'border-hair text-secondary hover:border-strong'
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
                将把 <span className="font-mono">{shortPath(choice.path)}</span> 登记成持久工作空间（不会删它）
              </>
            ) : canvas.project.repo ? (
              <>
                将把 <span className="font-mono">{repoName(canvas.project.repo.url)}</span> 下载到 {machineName} 的{' '}
                <span className="font-mono">{shortPath(choice.path)}</span>（用这台机器自己的 git 凭据）
              </>
            ) : (
              <>
                将在 {machineName} 的 <span className="font-mono">{shortPath(choice.path)}</span> 新建持久工作空间
              </>
            )}
            <button type="button" className="ml-2 text-accent hover:underline" onClick={() => setPicking((open) => !open)}>
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
        <span className="block text-body text-primary">新建临时工作空间</span>
        {/* 未选中只有一行：挑东西的时候不用读完每个选项的说明书 */}
        <span className="block text-meta text-tertiary">
          {gitHere ? '每个任务一个分支，用完自动清理' : '为这个任务单独开一份，用完自动清理'}
        </span>
        {existing > 0 ? (
          <span className="mt-0.5 block text-meta text-rust">这个任务已经有 {existing} 个临时工作空间</span>
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
 * 隔离 worktree：和「新建临时工作空间」是同一件事的两种口径——
 * 临时空间是「随便一个目录」，worktree 是「按项目配置开的分支目录 + 准备命令」。
 * 放在工作空间选择里而不是对话框上的复选框：机器和工作空间本来就是一起选的。
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
        title={gitHere ? undefined : '这台机器上还没有可用的 git 目录：先在下面关联一个，或给项目绑定仓库'}
      >
        <Radio on={selected} />
        <span className={`min-w-0 flex-1 ${gitHere ? '' : 'opacity-60'}`}>
          <span className="block text-body text-primary">新建隔离 worktree（新分支）</span>
          <span className="block text-meta text-tertiary">
            {gitHere ? '按项目配置现建，分支互不干扰' : '按项目配置在这台机器上现建一个隔离目录'}
          </span>
          {gitHere && selected ? (
            <span className="mt-1 block text-meta text-secondary">
              在 {machineName} 上新开分支 <span className="font-mono">{branchPreview(title)}</span>
              {setup?.command ? '，先跑项目配置的准备命令，跑完才起 agent' : ''}
            </span>
          ) : null}
        </span>
      </button>
      {/* 不可用不只是一行灰字：留着这一行（用户会来这儿找），说清缺什么，再给一个能点的动作。 */}
      {gitHere ? null : (
        <div data-testid="ws-new-worktree-blocked" className="mt-1.5 w-full border-l border-rust pl-2 text-meta">
          <p className="text-rust">这台机器上还没有可用的 git 目录</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              data-testid="ws-new-worktree-fix"
              className="min-h-[32px] shrink-0 rounded-sm border border-hair px-2 text-meta text-secondary hover:border-accent hover:text-accent"
              onClick={onFixGit}
            >
              关联 git 目录
            </button>
            <span className="text-tertiary">或在项目设置里绑定仓库</span>
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * 组合工作空间：项目有多个仓库时才会出现。每个仓库在新目录里各开一个 worktree，
 * 子目录名就是仓库名；agent 在总目录里工作，跨仓库的改动一次提交。
 * 只在 repos.length > 1 时挂载：单仓库项目用上面的隔离 worktree 就够了。
 */
function NewGroup({
  canvas,
  machineName,
  selected,
  onSelect
}: {
  canvas: CanvasDto;
  machineName: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const repos = canvas.project.repos;
  return (
    <div className={`${rowClass(selected)} flex-col`}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        data-testid="ws-new-group"
        className="flex w-full items-start gap-2 text-left"
        onClick={onSelect}
      >
        <Radio on={selected} />
        <span className="min-w-0 flex-1">
          <span className="block text-body text-primary">新建组合工作空间 · {repos.length} 个仓库</span>
          <span className="block text-meta text-tertiary">每个仓库在新目录里各开一个 worktree，agent 在总目录里工作</span>
          {selected ? (
            <span className="mt-1 block text-meta text-secondary">
              在 {machineName} 上准备 {repos.length} 个子目录：
              <span className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-tertiary">
                {repos.map((repo) => (
                  <span key={repo.id} className="font-mono">
                    {repo.name}
                    {repo.defaultBranch ? `@${repo.defaultBranch}` : ''}
                  </span>
                ))}
              </span>
            </span>
          ) : null}
        </span>
      </button>
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
