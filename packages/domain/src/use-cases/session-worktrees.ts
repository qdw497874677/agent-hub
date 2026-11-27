import type { Session } from '../session.ts';
import { isUsable, markKept, markRemoved, type Workspace } from '../workspace.ts';
import type { DomainError } from '../errors.ts';
import { conflict } from '../errors.ts';
import type { Result } from '../result.ts';
import { err } from '../result.ts';
import type { Deps } from './deps.ts';
import { gitFor } from './machine-dirs.ts';
import { fenceWorkspace, finishFence, finishSettledFailure } from './workdir-safety.ts';

export type SessionWorktreeDeps = Pick<Deps, 'gateway' | 'git' | 'now' | 'sessions' | 'workspaces'> &
  Partial<Pick<Deps, 'workspaceGroups' | 'workdirSafety' | 'plannedWorktreeGuard'>>;

const active = (session: Session): boolean => session.settledAt == null;

/** 收起 / 删除会话时，每个 worktree / 成员仓的清理结果。 */
export type WorktreeCleanupAction = 'removed' | 'kept' | 'deferred';
export interface WorktreeCleanupItem {
  readonly workspaceId: string;
  /** 组合组里的成员仓库名；单仓会话没有这一项。 */
  readonly member?: string;
  readonly action: WorktreeCleanupAction;
  readonly reason: string;
}


/** 会话还在用这个工作空间（自己除外）。长期目录有别人在用就不拆 worktree。 */
async function othersUsing(deps: SessionWorktreeDeps, workspaceId: string, selfId: string): Promise<boolean> {
  const sessions = await deps.sessions.listByWorkspace(workspaceId as never);
  return sessions.some((session) => session.id !== selfId && active(session));
}

async function detachOne(
  deps: SessionWorktreeDeps,
  workspace: Workspace,
  force: boolean,
  member?: string
): Promise<WorktreeCleanupItem> {
  const base = { workspaceId: workspace.id, ...(member ? { member } : {}) };
  // Planned outputs cannot yet be reconstructed by the legacy restore path, even after first use.
  if (deps.plannedWorktreeGuard?.forOutput(workspace.id)) {
    return { ...base, action: 'deferred', reason: '计划工作空间暂不自动拆除：旧恢复流程无法验证来源' };
  }
  if (deps.plannedWorktreeGuard?.isWorkspaceProtected(workspace.id) || (workspace.groupId && deps.plannedWorktreeGuard?.isGroupProtected(workspace.groupId))) {
    return { ...base, action: 'deferred', reason: '工作空间受未完成或首次使用前的计划保护' };
  }
  if (workspace.source !== 'worktree') {
    return { ...base, action: 'deferred', reason: '不是可拆除的 worktree，留给 workspace_sweep' };
  }
  if (workspace.state === 'removed') {
    return { ...base, action: 'removed', reason: '已经拆除' };
  }
  const git = await gitFor(deps, workspace.workerId);
  let fence: string | null;
  try { fence = await fenceWorkspace(deps, workspace, async (current) => !deps.plannedWorktreeGuard?.forOutput(current.id) && !deps.plannedWorktreeGuard?.isWorkspaceProtected(current.id) && !(current.groupId && deps.plannedWorktreeGuard?.isGroupProtected(current.groupId))); } catch { return { ...base, action: 'deferred', reason: '工作目录受计划保护、有终端或待确认的删除' }; }
  const outcome = await git.remove(workspace.path, 'worktree', { force });
  if (!outcome.ok) {
    await finishSettledFailure(deps, fence, outcome.error);
    const message = 'message' in outcome.error ? String(outcome.error.message) : '拆除失败';
    return { ...base, action: 'deferred', reason: `拆除失败，留给 workspace_sweep：${message}` };
  }
  if (outcome.value.removed) {
    const gone = markRemoved(workspace, deps.now());
    if (!gone.ok) {
      if (deps.workdirSafety) return { ...base, action: 'deferred', reason: '工作目录登记未能更新，删除待确认' };
    } else if ((await deps.workspaces.save(gone.value)).status !== 'saved' && deps.workdirSafety) {
      return { ...base, action: 'deferred', reason: '工作目录登记未能更新，删除待确认' };
    }
    await finishFence(deps, fence);
    return { ...base, action: 'removed', reason: '干净的临时 worktree 已拆除' };
  }
  // 收起且有未提交改动：目录留下，标成 kept，恢复会话时还在原路径。
  const reason = outcome.value.reason || '有未提交改动，留给 workspace_sweep';
  if (!force) await deps.workspaces.save(markKept(workspace, reason, deps.now()));
  await finishFence(deps, fence);
  return { ...base, action: 'kept', reason };
}

/**
 * 会话删除或收起时：对它独占的临时 worktree 执行 `git worktree remove` + prune（由 git.remove 实现）。
 * 长期工作空间不动。组合组里还有别的活跃会话时也不动。
 *
 * `force`：删除会话时为 true（人已经确认丢掉这条会话）；收起时为 false，有未提交改动就留下。
 */
export async function releaseSessionWorktrees(
  deps: SessionWorktreeDeps,
  session: Session,
  options: { readonly force: boolean }
): Promise<readonly WorktreeCleanupItem[]> {
  const items: WorktreeCleanupItem[] = [];
  if (session.groupId && deps.workspaceGroups) {
    const group = await deps.workspaceGroups.byId(session.groupId);
    if (!group) return items;
    const siblings = await deps.sessions.listByProject(group.projectId);
    if (siblings.some((other) => other.id !== session.id && other.groupId === group.id && active(other))) {
      for (const member of group.members) {
        items.push({
          workspaceId: member.workspaceId,
          member: member.name,
          action: 'deferred',
          reason: '组里还有活跃会话，留给 workspace_sweep'
        });
      }
      return items;
    }
    for (const member of group.members) {
      const workspace = await deps.workspaces.byId(member.workspaceId);
      if (workspace) items.push(await detachOne(deps, workspace, options.force, member.name));
    }
    return items;
  }
  if (!session.workspaceId) return items;
  const workspace = await deps.workspaces.byId(session.workspaceId);
  if (!workspace) return items;
  if (workspace.kind !== 'temporary' || workspace.source !== 'worktree') {
    return [{ workspaceId: workspace.id, action: 'deferred', reason: '长期工作空间不在收起时拆除' }];
  }
  if (await othersUsing(deps, workspace.id, session.id)) {
    return [{ workspaceId: workspace.id, action: 'deferred', reason: '还有别的会话在用，留给 workspace_sweep' }];
  }
  items.push(await detachOne(deps, workspace, options.force));
  return items;
}

/**
 * 收起后再打开：按原来的分支把 worktree 加回来（分支在 remove 时保留）。
 */
export async function restoreSessionWorktrees(deps: SessionWorktreeDeps, session: Session): Promise<Result<void, DomainError> | null> {
  const targets: Workspace[] = [];
  const plannedSession = !!(session.workspaceId && deps.plannedWorktreeGuard?.forOutput(session.workspaceId));
  if (session.groupId && deps.workspaceGroups) {
    const group = await deps.workspaceGroups.byId(session.groupId);
    if (!group) return plannedSession ? err(conflict('计划组合不存在，无法验证恢复状态')) : null;
    for (const member of group.members) {
      const workspace = await deps.workspaces.byId(member.workspaceId);
      if (!workspace && (plannedSession || deps.plannedWorktreeGuard?.forOutput(member.workspaceId))) return err(conflict('计划组合成员不存在，无法验证恢复状态'));
      if (workspace) targets.push(workspace);
    }
  } else if (session.workspaceId) {
    const workspace = await deps.workspaces.byId(session.workspaceId);
    if (!workspace && plannedSession) return err(conflict('计划工作空间不存在，无法验证恢复状态'));
    if (workspace) targets.push(workspace);
  }
  for (const workspace of targets) {
    if (deps.plannedWorktreeGuard?.forOutput(workspace.id) && !isUsable(workspace)) {
      return err(conflict('计划工作空间无法通过旧恢复流程验证，请通过计划恢复'));
    }
    if (workspace.source !== 'worktree' || isUsable(workspace) || !workspace.branch || !workspace.baseWorkspaceId) continue;
    const base = await deps.workspaces.byId(workspace.baseWorkspaceId);
    if (!base) continue;
    const git = await gitFor(deps, workspace.workerId);
    const made = await git.addWorktree({
      repoPath: base.path,
      path: workspace.path,
      branch: workspace.branch,
      existing: true
    });
    if (!made.ok) return made;
    await deps.workspaces.save({ ...workspace, state: 'ready', keptReason: null, path: made.value.path, updatedAt: deps.now() });
  }
  return null;
}
