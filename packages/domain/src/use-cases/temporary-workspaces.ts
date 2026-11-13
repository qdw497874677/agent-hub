import type { Subject } from '../access.ts';
import type { Project, ProjectSetup } from '../project.ts';
import { isUsable, newWorkspace, type Workspace } from '../workspace.ts';
import { asProjectId, asTaskId, asWorkspaceId, newId, type TaskId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { conflict, invalid, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';
import { createDirectory, gitOn, parentOf, resolveMachine, rootsOf, type Machine } from './machine-dirs.ts';
import { authorizeWorker } from './authorization.ts';
import { MANAGED_DIR } from '../directories.ts';
import { defaultWorkspaceFor, prepareLongLivedWorkspaceUseCase } from './workspaces.ts';

/** 分支和目录名里用的短 slug：只留 ascii 字母数字，中文标题退回 task。 */
export function branchSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return slug === '' ? 'task' : slug;
}

/** 任务分支名 `agent-hub/<slug>-<短 id>`（§10 已定）。 */
export function taskBranch(title: string, shortId: string): string {
  return `agent-hub/${branchSlug(title)}-${shortId}`;
}

const shortId = (): string => newId().replace(/-/g, '').slice(0, 4);

export interface PrepareTemporaryCommand {
  readonly projectId: string;
  readonly taskId: string;
  readonly workerId: string | null;
  readonly home: string;
  /** 沿用这个已有分支（换个地方继续），不新开 `agent-hub/…`。只对 git 项目有意义。 */
  readonly branch?: string | null;
  /** 新分支从哪儿长（换个地方继续到同一台机器：从刚推送的 WIP 分支长）。 */
  readonly base?: string | null;
  /** 档位：shared = 复用项目的长期空间（不建 worktree）；isolated = 新开 worktree。缺省按 project.worktree?.mode ?? 'shared'。 */
  readonly mode?: 'shared' | 'isolated';
  readonly actor?: Subject | null;
}

/**
 * 新建临时工作空间（§4「临时」两项）：
 * - 这台机器上有这个项目的 git 长期工作空间（或项目绑了仓库，先 clone 一个）→ 在它旁边的 `.worktrees/` 下
 *   开 worktree，新分支 `agent-hub/<slug>-<短 id>`（source worktree）；
 * - 否则（非 git 项目）→ 新建空目录 `<roots[0]>/agent-hub-workspaces/.tmp/<slug>-<短 id>`（source created）。
 * 数量不限（§10 第 5 条），提示由界面给。
 */
export async function prepareTemporaryWorkspaceUseCase(
  deps: Pick<Deps, 'fs' | 'git' | 'gateway' | 'now' | 'projects' | 'tasks' | 'workspaces' | 'access'>,
  command: PrepareTemporaryCommand
): Promise<Result<Workspace, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));
  const task = await deps.tasks.byId(asTaskId(command.taskId));
  if (!task || task.projectId !== project.id) return err(notFound('任务不存在'));
  const resolved = await resolveMachine(deps, command.workerId);
  if (!resolved.ok) return resolved;
  const allowed = await authorizeWorker(deps.access, command.actor ?? null, resolved.value.workerId);
  if (!allowed.ok) return allowed;
  const machine = resolved.value;
  // 选了档位就用选定的；没选按项目配置，老项目保持 shared。要沿用已有分支（继续干活）只能是 worktree。
  const mode: 'shared' | 'isolated' = command.branch ? 'isolated' : (command.mode ?? project.worktree?.mode ?? 'shared');
  const setup = project.worktree?.setup ?? null;

  // ADR 0027 §3：清理只删了 checkout，分支还在 → 同一台机器上按原分支、原目录重建，会话历史 / 检查点接得上
  if (mode === 'isolated' && !command.branch) {
    const revived = await reviveRemovedWorktree(deps, task.id, machine);
    if (revived) return ok(revived);
  }

  // shared：直接复用项目在这台机器上的长期空间（不建 worktree，也不跑准备命令——那是人自己的目录）
  if (mode === 'shared') {
    const shared = await sharedWorkspace(deps, project, machine, command);
    if (!shared.ok) return shared;
    if (shared.value) return ok(shared.value);
    // 没有长期空间、也没有仓库可 clone（非 git 项目）：退回下面的临时目录
  }

  const id = shortId();
  const name = `${branchSlug(task.title)}-${id}`;
  const base = mode === 'isolated' ? await gitBase(deps, project, machine, command) : ok(null);
  if (!base.ok) return base;

  let path: string;
  let branch: string | null = null;
  if (base.value) {
    const repoParent = parentOf(base.value.path) ?? '/';
    const repoName = base.value.path.split('/').filter(Boolean).at(-1) ?? 'repo';
    const made = await gitOn(deps, machine.route).addWorktree({
      repoPath: base.value.path,
      path: `${repoParent === '/' ? '' : repoParent}/.worktrees/${repoName}/${name}`,
      branch: command.branch ?? taskBranch(task.title, id),
      base: command.base ?? project.repo?.defaultBranch ?? base.value.branch,
      ...(command.branch ? { existing: true } : {})
    });
    if (!made.ok) return made;
    path = made.value.path;
    branch = made.value.branch;
  } else {
    const roots = await rootsOf(deps, machine.route, command.workerId, command.home);
    const root = roots[0];
    if (root === undefined) return err(invalid('这台机器没有可以新建目录的位置'));
    let parent = root;
    for (const segment of [MANAGED_DIR, '.tmp']) {
      const made = await createDirectory(deps, { workerId: machine.workerId, parent, name: segment, home: command.home });
      if (!made.ok) return made;
      parent = made.value.path;
    }
    const made = await createDirectory(deps, { workerId: machine.workerId, parent, name, home: command.home });
    if (!made.ok) return made;
    path = made.value.path;
  }

  const created = newWorkspace({
    projectId: project.id,
    workerId: machine.workerId,
    path,
    kind: 'temporary',
    source: base.value ? 'worktree' : 'created',
    ownerTaskId: task.id,
    baseWorkspaceId: base.value?.id ?? null,
    branch,
    isGit: base.value !== null,
    // 有准备命令：先 preparing，跑完变 ready / failed（§4 状态机）；没有就直接能用
    state: setup ? 'preparing' : 'ready',
    now: deps.now()
  });
  if (!created.ok) return created;
  if (!setup) {
    await deps.workspaces.save(created.value);
    return ok(created.value);
  }
  const prepared = await runWorkspaceSetup(deps, machine, created.value, setup);
  return ok(prepared);
}

/** shared 档：项目在这台机器上的长期空间；没有但项目有仓库 → 先 clone 一个（复用 gitBase）。都没有 = null。 */
async function sharedWorkspace(
  deps: Pick<Deps, 'fs' | 'git' | 'gateway' | 'now' | 'projects' | 'workspaces'>,
  project: Project,
  machine: Machine,
  command: PrepareTemporaryCommand
): Promise<Result<Workspace | null, DomainError>> {
  const existing = await defaultWorkspaceFor(deps, project.id, machine.workerId);
  if (existing) return ok(existing);
  return gitBase(deps, project, machine, command);
}

/**
 * 跑项目的准备命令并把结果写进 workspace.setup（docs/design/worktree.md §4）：
 * 同步跑（waitForSetup=false 的异步化留给后续），失败不抛、写 state='failed' + 中文原因，目录保留。
 */
async function runWorkspaceSetup(
  deps: Pick<Deps, 'git' | 'gateway' | 'now' | 'workspaces'>,
  machine: Machine,
  workspace: Workspace,
  setup: ProjectSetup
): Promise<Workspace> {
  const startedAt = deps.now();
  const running: Workspace = {
    ...workspace,
    state: 'preparing',
    updatedAt: startedAt,
    setup: { state: 'running', exitCode: null, message: null, output: null, startedAt, finishedAt: null }
  };
  await deps.workspaces.save(running);
  const base = workspace.baseWorkspaceId ? await deps.workspaces.byId(workspace.baseWorkspaceId) : null;
  const env: Record<string, string> = {
    AGENT_HUB_PROJECT_ROOT: base?.path ?? workspace.path,
    AGENT_HUB_WORKTREE_PATH: workspace.path,
    ...(workspace.branch ? { AGENT_HUB_BRANCH: workspace.branch } : {})
  };
  const ran = await gitOn(deps, machine.route).runSetup({
    path: workspace.path,
    command: setup.command,
    timeoutMs: setup.timeoutSeconds * 1000,
    env
  });
  const finishedAt = deps.now();
  if (!ran.ok) {
    const failed: Workspace = {
      ...running,
      state: 'failed',
      keptReason: '准备失败',
      updatedAt: finishedAt,
      setup: { state: 'failed', exitCode: null, message: ran.error.message, output: null, startedAt, finishedAt }
    };
    await deps.workspaces.save(failed);
    return failed;
  }
  const { exitCode, output, timedOut } = ran.value;
  const tail = output.length > 8192 ? output.slice(-8192) : output;
  const passed = !timedOut && exitCode === 0;
  const next: Workspace = passed
    ? {
        ...running,
        state: 'ready',
        keptReason: null,
        updatedAt: finishedAt,
        setup: { state: 'ready', exitCode, message: null, output: tail, startedAt, finishedAt }
      }
    : {
        ...running,
        state: 'failed',
        keptReason: '准备失败',
        updatedAt: finishedAt,
        setup: {
          state: 'failed',
          exitCode,
          message: timedOut ? `准备命令超时（${setup.timeoutSeconds} 秒）` : `准备命令退出码 ${exitCode}`,
          output: tail,
          startedAt,
          finishedAt
        }
      };
  await deps.workspaces.save(next);
  return next;
}

export interface RetryWorkspaceSetupCommand {
  readonly workspaceId: string;
  readonly actor?: Subject | null;
}

/** 重跑准备命令：只对 setup.state==='failed' 的工作空间有效（§4「重试」）。项目没配命令 = 没得重试。 */
export async function retryWorkspaceSetupUseCase(
  deps: Pick<Deps, 'fs' | 'git' | 'gateway' | 'now' | 'projects' | 'workspaces' | 'access'>,
  command: RetryWorkspaceSetupCommand
): Promise<Result<Workspace, DomainError>> {
  const workspace = await deps.workspaces.byId(asWorkspaceId(command.workspaceId));
  if (!workspace) return err(notFound('工作空间不存在'));
  if (workspace.state === 'removed') return err(conflict('工作空间已经删除了'));
  if (workspace.setup?.state !== 'failed') return err(conflict('只有准备失败的工作空间可以重试'));
  if (!workspace.projectId) return err(conflict('这个工作空间不属于任何项目'));
  const project = await deps.projects.byId(workspace.projectId);
  if (!project) return err(notFound('项目不存在'));
  const setup = project.worktree?.setup;
  if (!setup) return err(conflict('这个项目没有配置准备命令'));
  const resolved = await resolveMachine(deps, workspace.workerId);
  if (!resolved.ok) return resolved;
  const allowed = await authorizeWorker(deps.access, command.actor ?? null, resolved.value.workerId);
  if (!allowed.ok) return allowed;
  return ok(await runWorkspaceSetup(deps, resolved.value, workspace, setup));
}

/** 这个任务在这台机器上被清理掉的 worktree（最近的那个）：按原分支检出回原路径。失败（分支被删了…）= null，调用方照常新开。 */
async function reviveRemovedWorktree(
  deps: Pick<Deps, 'git' | 'gateway' | 'now' | 'workspaces'>,
  taskId: TaskId,
  machine: Machine
): Promise<Workspace | null> {
  const gone = (await deps.workspaces.byTask(taskId))
    .filter((w) => w.state === 'removed' && w.source === 'worktree' && w.branch && w.baseWorkspaceId && w.workerId === machine.workerId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!gone?.branch || !gone.baseWorkspaceId) return null;
  const base = await deps.workspaces.byId(gone.baseWorkspaceId);
  if (!base || !isUsable(base)) return null;
  const made = await gitOn(deps, machine.route).addWorktree({ repoPath: base.path, path: gone.path, branch: gone.branch, existing: true });
  if (!made.ok) return null;
  const revived: Workspace = { ...gone, path: made.value.path, branch: made.value.branch, state: 'ready', keptReason: null, updatedAt: deps.now() };
  await deps.workspaces.save(revived);
  return revived;
}

/** worktree 从哪个长期工作空间长：这台机器上最近建的 git 长期工作空间；没有但项目有仓库就先 clone 一个。 */
async function gitBase(
  deps: Pick<Deps, 'fs' | 'git' | 'gateway' | 'now' | 'projects' | 'workspaces'>,
  project: Project,
  machine: Machine,
  command: PrepareTemporaryCommand
): Promise<Result<Workspace | null, DomainError>> {
  const candidates = (await deps.workspaces.byProject(project.id))
    .filter((workspace) => workspace.kind === 'long_lived' && isUsable(workspace) && workspace.workerId === machine.workerId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const known = candidates.find((workspace) => workspace.isGit === true);
  if (known) return ok(known);
  // 老登记没探测过：现在问一下
  const git = gitOn(deps, machine.route);
  for (const workspace of candidates.filter((candidate) => candidate.isGit === null)) {
    const inspected = await git.inspect(workspace.path);
    if (!inspected.ok || !inspected.value.isGit) continue;
    const updated = { ...workspace, isGit: true, branch: inspected.value.branch, updatedAt: deps.now() };
    await deps.workspaces.save(updated);
    return ok(updated);
  }
  if (!project.repo) return ok(null);
  const cloned = await prepareLongLivedWorkspaceUseCase(deps, {
    actor: command.actor,
    projectId: project.id,
    workerId: command.workerId,
    plan: { mode: 'create' },
    home: command.home
  });
  return cloned.ok ? ok(cloned.value) : cloned;
}
