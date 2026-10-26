import { markKept, markRemoved, platformOwnsDirectory, type Workspace } from '../workspace.ts';
import type { GitStatus } from '../ports/workspace-git.ts';
import { asWorkspaceId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { conflict, invalid, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';
import { gitOn } from './machine-dirs.ts';

type CleanupDeps = Pick<Deps, 'git' | 'gateway' | 'now' | 'sessions' | 'tasks' | 'workspaces'>;

/** 删了会丢什么，说人话；都没有返回 null（§5 第 3 条）。 */
export function unsavedReason(status: GitStatus): string | null {
  const parts: string[] = [];
  if (status.dirty) parts.push('有未提交的改动');
  if (status.untracked > 0) parts.push(`有 ${status.untracked} 个未跟踪的文件`);
  if (status.unpushed > 0) parts.push(`有 ${status.unpushed} 个提交还没推送或合并`);
  return parts.length > 0 ? parts.join('，') : null;
}

const FINISHED = new Set(['done', 'abandoned']);

async function busy(deps: Pick<Deps, 'sessions'>, workspace: Workspace): Promise<boolean> {
  return (await deps.sessions.listByProject(workspace.projectId)).some(
    (session) => session.workspaceId === workspace.id && session.status === 'running'
  );
}

const removeKind = (workspace: Workspace) => (workspace.source === 'worktree' ? 'worktree' : 'directory');

export interface SweepReport {
  readonly removed: readonly string[];
  readonly kept: readonly string[];
  /** 有会话在跑、机器离线……下次再查。 */
  readonly skipped: readonly string[];
}

/**
 * 清理临时工作空间（§5）：任务结束（done / abandoned）的临时工作空间，确认没有会丢的东西才删。
 * 触发：任务改成结束时（只查那个任务）、hub 启动时、每小时一次。
 * 有会话在跑、机器离线 → 跳过；有改动 → kept 并写原因（只提醒，不设期限）；干净 → 删目录（worktree 的分支保留）。
 * kept 的也会再查：人推送 / 合并之后下一轮就删掉。
 */
export async function sweepTemporaryWorkspacesUseCase(
  deps: CleanupDeps,
  scope: { readonly taskId?: string } = {}
): Promise<SweepReport> {
  const removed: string[] = [];
  const kept: string[] = [];
  const skipped: string[] = [];
  const candidates = (await deps.workspaces.temporaries()).filter(
    (workspace) => (workspace.state === 'ready' || workspace.state === 'kept') && (!scope.taskId || workspace.ownerTaskId === scope.taskId)
  );
  for (const workspace of candidates) {
    const task = workspace.ownerTaskId ? await deps.tasks.byId(workspace.ownerTaskId) : null;
    if (task && !FINISHED.has(task.status)) continue; // 任务还在做（或被重新打开）：继续用
    if (await busy(deps, workspace)) {
      skipped.push(workspace.id);
      continue;
    }
    const git = gitOn(deps, workspace.workerId);
    const status = await git.status(workspace.path);
    if (!status.ok) {
      skipped.push(workspace.id); // 多半是机器离线：上线后再查
      continue;
    }
    const reason = unsavedReason(status.value);
    if (reason) {
      if (workspace.state !== 'kept' || workspace.keptReason !== reason) await deps.workspaces.save(markKept(workspace, reason, deps.now()));
      kept.push(workspace.id);
      continue;
    }
    // Worker 那边删之前还会再查一次（hub 以为干净但其实不干净时以它为准）
    const outcome = await git.remove(workspace.path, removeKind(workspace));
    if (!outcome.ok) {
      skipped.push(workspace.id);
      continue;
    }
    if (outcome.value.removed) {
      const gone = markRemoved(workspace, deps.now());
      if (gone.ok) await deps.workspaces.save(gone.value);
      removed.push(workspace.id);
    } else {
      await deps.workspaces.save(markKept(workspace, outcome.value.reason, deps.now()));
      kept.push(workspace.id);
    }
  }
  return { removed, kept, skipped };
}

/** 删之前给人看的：会丢什么（「强制删除」的二次确认里列出来）。 */
export async function workspaceChangesUseCase(
  deps: Pick<Deps, 'git' | 'gateway' | 'workspaces'>,
  workspaceId: string
): Promise<Result<{ readonly status: GitStatus; readonly reason: string | null }, DomainError>> {
  const workspace = await deps.workspaces.byId(asWorkspaceId(workspaceId));
  if (!workspace || workspace.state === 'removed') return err(notFound('工作空间不存在'));
  const status = await gitOn(deps, workspace.workerId).status(workspace.path);
  if (!status.ok) return status;
  return ok({ status: status.value, reason: unsavedReason(status.value) });
}

export interface RemoveWorkspaceCommand {
  readonly workspaceId: string;
  /**
   * 同时删除目录。持久的只有平台建的（created / cloned）才允许（§10 第 3 条），且界面已二次确认；
   * 临时的本来就是平台建的。
   */
  readonly deleteDirectory: boolean;
  /** 有改动也删（人已在二次确认里看过会丢什么）。不给就和自动清理一样：有改动拒绝并标 kept。 */
  readonly force?: boolean;
}

/**
 * 移除工作空间（项目设置 · 工作空间）：
 * - 只移除登记：目录不碰（机器永久下线、或者是人的目录时用）；
 * - 连目录一起删：见 deleteDirectory / force。
 * 有会话在里面跑一律拒绝，先停会话；还有临时工作空间从这个持久工作空间长出来，也不能删它的目录。
 */
export async function removeWorkspaceUseCase(
  deps: CleanupDeps,
  command: RemoveWorkspaceCommand
): Promise<Result<Workspace, DomainError>> {
  const workspace = await deps.workspaces.byId(asWorkspaceId(command.workspaceId));
  if (!workspace || workspace.state === 'removed') return err(notFound('工作空间不存在'));
  if (await busy(deps, workspace)) return err(conflict('有会话正在这个工作空间里运行，先停掉它'));
  if (command.deleteDirectory) {
    if (!platformOwnsDirectory(workspace)) return err(invalid('这是你自己选的目录，平台不会删它；只能移除登记'));
    if (workspace.kind === 'long_lived') {
      const children = (await deps.workspaces.byProject(workspace.projectId)).filter(
        (other) => other.baseWorkspaceId === workspace.id && other.state !== 'removed'
      );
      if (children.length > 0) return err(conflict(`还有 ${children.length} 个临时工作空间是从它开出来的，先处理它们`));
    }
    const outcome = await gitOn(deps, workspace.workerId).remove(workspace.path, removeKind(workspace), { force: command.force === true });
    if (!outcome.ok) return outcome;
    if (!outcome.value.removed) {
      const keptOne = workspace.kind === 'temporary' ? markKept(workspace, outcome.value.reason, deps.now()) : workspace;
      if (keptOne !== workspace) await deps.workspaces.save(keptOne);
      return err(conflict(`没有删：${outcome.value.reason}`));
    }
  }
  const gone = markRemoved(workspace, deps.now());
  if (!gone.ok) return gone;
  await deps.workspaces.save(gone.value);
  return ok(gone.value);
}
