import type { ProjectId, TaskId, WorkspaceId } from './ids.ts';
import { newWorkspaceId } from './ids.ts';
import { conflict, invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * 工作空间（docs/design/workspaces.md §2）：某台机器上的一个真实目录，会话在里面干活。
 * - 长期（long_lived）：人建或选的，跨任务复用，平台永远不删目录；
 * - 临时（temporary）：为一个任务建的，任务结束、确认没有未保存的改动后自动清理。
 */
export type WorkspaceKind = 'long_lived' | 'temporary';
/** 目录怎么来的。只有 created / cloned / worktree 是平台建的，才允许由平台删目录。 */
export type WorkspaceSource = 'linked' | 'created' | 'cloned' | 'worktree';
export type WorkspaceState = 'preparing' | 'ready' | 'failed' | 'kept' | 'removed';

/** 准备命令（项目配置的 setup）在这个目录上跑到哪一步了（docs/design/worktree.md §4）。 */
export type WorkspaceSetupState = 'none' | 'running' | 'ready' | 'failed';

export interface WorkspaceSetup {
  readonly state: WorkspaceSetupState;
  readonly exitCode: number | null;
  /** 失败时给人看的一句中文；其余是 null。 */
  readonly message: string | null;
  /** 命令输出（只留最后 8KB，已抹掉 user:token@）。 */
  readonly output: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface Workspace {
  readonly id: WorkspaceId;
  /**
   * 临时工作空间：所属项目（必填，不共享）。
   * 长期工作空间：最早为哪个项目建的（只作记录 / 回滚用）；团队页直接建的是 null。
   * 长期工作空间给哪些项目用，看关联表（ProjectWorkspaceLink，ADR 0026）。
   */
  readonly projectId: ProjectId | null;
  /** 所属团队（ADR 0026）。null = 没装账号体系 / 老数据，按 hub 团队处理。 */
  readonly teamId: string | null;
  /** 这个目录从哪个仓库下载的（ADR 0026 Q3：仓库配方在工作空间上）；不是 clone 来的是 null。 */
  readonly repoUrl: string | null;
  /** 哪台 Worker 的文件系统。null = 和 Server 同机（多机之前迁移过来的老目录）。 */
  /** 在哪台 Worker 上（本机也记真实 id）。null 只出现在老数据 / 没有本机 Worker 时，按 Server 本机处理。 */
  readonly workerId: string | null;
  readonly path: string;
  readonly kind: WorkspaceKind;
  readonly source: WorkspaceSource;
  /** worktree 从哪个长期工作空间长出来。 */
  readonly baseWorkspaceId: WorkspaceId | null;
  readonly branch: string | null;
  /** 临时工作空间属于哪个任务；长期的一定是 null（表约束同样保证）。 */
  readonly ownerTaskId: TaskId | null;
  readonly label: string | null;
  /** 准备时探测；null = 还没探测过。 */
  readonly isGit: boolean | null;
  readonly state: WorkspaceState;
  /** 清理被拒时的原因（有未提交 / 未推送的改动……）。 */
  readonly keptReason: string | null;
  /** 准备命令的状态；null = 这个目录没配准备命令 / 从没跑过。 */
  readonly setup: WorkspaceSetup | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewWorkspaceInput {
  readonly projectId: ProjectId | null;
  readonly teamId?: string | null;
  readonly repoUrl?: string | null;
  readonly workerId: string | null;
  readonly path: string;
  readonly kind: WorkspaceKind;
  readonly source: WorkspaceSource;
  readonly ownerTaskId?: TaskId | null;
  readonly baseWorkspaceId?: WorkspaceId | null;
  readonly branch?: string | null;
  readonly label?: string | null;
  readonly isGit?: boolean | null;
  readonly state?: WorkspaceState;
  readonly setup?: WorkspaceSetup | null;
  readonly now: number;
  readonly id?: WorkspaceId;
}

export function normalizePath(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

export function newWorkspace(input: NewWorkspaceInput): Result<Workspace, DomainError> {
  if (!input.path.startsWith('/')) return err(invalid('目录必须是绝对路径'));
  const owner = input.ownerTaskId ?? null;
  if ((input.kind === 'temporary') !== (owner !== null)) {
    return err(invalid('临时工作空间必须属于一个任务；长期工作空间不属于任何任务'));
  }
  if (input.kind === 'temporary' && input.projectId === null) return err(invalid('临时工作空间必须属于一个项目'));
  if (input.source === 'worktree' && input.kind !== 'temporary') return err(invalid('worktree 只用于临时工作空间'));
  return ok({
    id: input.id ?? newWorkspaceId(),
    projectId: input.projectId,
    teamId: input.teamId ?? null,
    repoUrl: input.repoUrl ?? null,
    workerId: input.workerId,
    path: normalizePath(input.path),
    kind: input.kind,
    source: input.source,
    baseWorkspaceId: input.baseWorkspaceId ?? null,
    branch: input.branch ?? null,
    ownerTaskId: owner,
    label: input.label?.trim() || null,
    isGit: input.isGit ?? null,
    state: input.state ?? 'ready',
    keptReason: null,
    setup: input.setup ?? null,
    createdAt: input.now,
    updatedAt: input.now
  });
}

/** 还能用来跑会话的（没删、没失败、没在准备中）。kept 的临时空间还在，能继续用。 */
export function isUsable(workspace: Workspace): boolean {
  return workspace.state === 'ready' || workspace.state === 'kept';
}

/**
 * 派发会话前的准备命令检查（docs/design/worktree.md §4）：
 * - failed：返回一句原因（含「可以在机器页重试准备」），调用方翻成 conflict；
 * - running 且 waitForSetup：让调用方拒绝（没有异步等待实现，先挡一下）；
 * - 其余 null。
 */
export function setupNotReady(workspace: Pick<Workspace, 'setup'>, waitForSetup: boolean): string | null {
  const setup = workspace.setup;
  if (setup?.state === 'failed') return `工作空间没有准备好：${setup.message ?? '准备命令失败'}（可以在机器页重试准备）`;
  if (setup?.state === 'running' && waitForSetup) return '工作空间还在准备中：等准备命令跑完再开会话（可以在机器页看进度）';
  return null;
}

/** 平台建的目录才允许平台删（workspaces.md §5；linked 的是人的目录，只解除登记）。 */
export function platformOwnsDirectory(workspace: Workspace): boolean {
  return workspace.source !== 'linked';
}

export function markKept(workspace: Workspace, reason: string, now: number): Workspace {
  return { ...workspace, state: 'kept', keptReason: reason, updatedAt: now };
}

export function markRemoved(workspace: Workspace, now: number): Result<Workspace, DomainError> {
  if (workspace.state === 'removed') return err(conflict('工作空间已经删除了'));
  return ok({ ...workspace, state: 'removed', keptReason: null, updatedAt: now });
}

/** a 是 b 本身或在 b 里面（都已规范化）。 */
function within(a: string, b: string): boolean {
  return a === b || b === '/' || a.startsWith(`${b}/`);
}

/** 项目 ↔ 长期工作空间的关联（ADR 0026，多对多）。 */
export interface ProjectWorkspaceLink {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly linkedBy: string | null;
  readonly linkedAt: number;
}

/**
 * 唯一性（ADR 0026 §6）：同一团队、同一台机器上，活跃的长期工作空间路径唯一且不嵌套。
 * - exact：完全相同的目录已经登记成长期工作空间（调用方复用它、关联到项目即可）；
 * - nested：和某个已登记目录互相嵌套（拒绝）。同项目的临时工作空间不算（沿用原规则）。
 */
export function placeConflict(
  place: { readonly teamId: string | null; readonly workerId: string | null; readonly path: string; readonly projectId?: ProjectId | null },
  registered: readonly Workspace[]
): { readonly exact: Workspace | null; readonly nested: Workspace | null } {
  const path = normalizePath(place.path);
  let exact: Workspace | null = null;
  let nested: Workspace | null = null;
  for (const other of registered) {
    if (other.state === 'removed' || other.workerId !== place.workerId || other.teamId !== place.teamId) continue;
    if (other.kind === 'temporary' && place.projectId != null && other.projectId === place.projectId) continue;
    const otherPath = normalizePath(other.path);
    if (otherPath === path && other.kind === 'long_lived') exact ??= other;
    else if (within(path, otherPath) || within(otherPath, path)) nested ??= other;
  }
  return { exact, nested };
}

/** 同一个工作空间里正在跑的会话，按是不是本项目分开数（跨项目并发警告，ADR 0026 §5）。 */
export function concurrencyOf(
  running: readonly { readonly taskId: string; readonly projectId: string | null }[],
  projectId: string
): { readonly runningTaskIds: readonly string[]; readonly otherProjectSessions: number } {
  const mine = new Set<string>();
  let others = 0;
  for (const session of running) {
    if (session.projectId === projectId) mine.add(session.taskId);
    else others += 1;
  }
  return { runningTaskIds: [...mine], otherProjectSessions: others };
}

/** 同一个目录在同一台机器上只登记一次（removed 的不算）。 */
export function samePlace(a: Pick<Workspace, 'workerId' | 'path'>, b: Pick<Workspace, 'workerId' | 'path'>): boolean {
  return a.workerId === b.workerId && normalizePath(a.path) === normalizePath(b.path);
}
