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

export interface Workspace {
  readonly id: WorkspaceId;
  readonly projectId: ProjectId;
  /** 哪台 Worker 的文件系统。null = 和 Server 同机（多机之前迁移过来的老目录）。 */
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
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewWorkspaceInput {
  readonly projectId: ProjectId;
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
  if (input.source === 'worktree' && input.kind !== 'temporary') return err(invalid('worktree 只用于临时工作空间'));
  return ok({
    id: input.id ?? newWorkspaceId(),
    projectId: input.projectId,
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
    createdAt: input.now,
    updatedAt: input.now
  });
}

/** 还能用来跑会话的（没删、没失败、没在准备中）。kept 的临时空间还在，能继续用。 */
export function isUsable(workspace: Workspace): boolean {
  return workspace.state === 'ready' || workspace.state === 'kept';
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

/** 同一个目录在同一台机器上只登记一次（removed 的不算）。 */
export function samePlace(a: Pick<Workspace, 'workerId' | 'path'>, b: Pick<Workspace, 'workerId' | 'path'>): boolean {
  return a.workerId === b.workerId && normalizePath(a.path) === normalizePath(b.path);
}
