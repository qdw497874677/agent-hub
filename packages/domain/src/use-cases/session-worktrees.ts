import type { Session } from '../session.ts';
import { isUsable, markKept, markRemoved, type Workspace } from '../workspace.ts';
import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';
import type { Deps } from './deps.ts';
import { gitFor } from './machine-dirs.ts';

export type SessionWorktreeDeps = Pick<Deps, 'gateway' | 'git' | 'now' | 'sessions' | 'workspaces'> &
  Partial<Pick<Deps, 'workspaceGroups'>>;

const active = (session: Session): boolean => session.settledAt == null;

/** 会话还在用这个工作空间（自己除外）。长期目录有别人在用就不拆 worktree。 */
async function othersUsing(deps: SessionWorktreeDeps, workspaceId: string, selfId: string): Promise<boolean> {
  const sessions = await deps.sessions.listByWorkspace(workspaceId as never);
  return sessions.some((session) => session.id !== selfId && active(session));
}

async function detachOne(deps: SessionWorktreeDeps, workspace: Workspace, force: boolean): Promise<void> {
  if (workspace.source !== 'worktree' || workspace.state === 'removed') return;
  const git = await gitFor(deps, workspace.workerId);
  const outcome = await git.remove(workspace.path, 'worktree', { force });
  if (!outcome.ok) return;
  if (outcome.value.removed) {
    const gone = markRemoved(workspace, deps.now());
    if (gone.ok) await deps.workspaces.save(gone.value);
    return;
  }
  // 收起且有未提交改动：目录留下，标成 kept，恢复会话时还在原路径。
  if (!force) await deps.workspaces.save(markKept(workspace, outcome.value.reason, deps.now()));
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
): Promise<void> {
  if (session.groupId && deps.workspaceGroups) {
    const group = await deps.workspaceGroups.byId(session.groupId);
    if (!group) return;
    const siblings = await deps.sessions.listByProject(group.projectId);
    if (siblings.some((other) => other.id !== session.id && other.groupId === group.id && active(other))) return;
    for (const member of group.members) {
      const workspace = await deps.workspaces.byId(member.workspaceId);
      if (workspace) await detachOne(deps, workspace, options.force);
    }
    return;
  }
  if (!session.workspaceId) return;
  const workspace = await deps.workspaces.byId(session.workspaceId);
  if (!workspace || workspace.kind !== 'temporary' || workspace.source !== 'worktree') return;
  if (await othersUsing(deps, workspace.id, session.id)) return;
  await detachOne(deps, workspace, options.force);
}

/**
 * 收起后再打开：按原来的分支把 worktree 加回来（分支在 remove 时保留）。
 */
export async function restoreSessionWorktrees(deps: SessionWorktreeDeps, session: Session): Promise<Result<void, DomainError> | null> {
  const targets: Workspace[] = [];
  if (session.groupId && deps.workspaceGroups) {
    const group = await deps.workspaceGroups.byId(session.groupId);
    if (!group) return null;
    for (const member of group.members) {
      const workspace = await deps.workspaces.byId(member.workspaceId);
      if (workspace) targets.push(workspace);
    }
  } else if (session.workspaceId) {
    const workspace = await deps.workspaces.byId(session.workspaceId);
    if (workspace) targets.push(workspace);
  }
  for (const workspace of targets) {
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
