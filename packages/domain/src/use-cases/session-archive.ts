import type { Session } from '../session.ts';
import type { Workspace } from '../workspace.ts';
import type { WorkspaceGroup } from '../workspace-group.ts';
import type { PullRequestLink } from '../ports/pull-requests.ts';
import type { Deps } from './deps.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import type { WorkspaceRepository } from '../ports/workspace-repository.ts';
import { gitFor } from './machine-dirs.ts';

export type ArchiveDeps = {
  now: () => number;
  sessions: Pick<SessionRepository, 'byId' | 'save' | 'listByWorkspace' | 'listByProject'>;
  workspaces: Pick<WorkspaceRepository, 'byId'>;
} & Partial<Pick<Deps, 'workspaceGroups' | 'cleanup' | 'git' | 'gateway'>>;

/** 会话还在活跃列表里（没收起）。跑着的也不自动收起。 */
export const isActiveSession = (session: Session): boolean => session.settledAt == null && session.status !== 'running';

/** 收起会话：只改 settledAt，不拆 worktree、不删会话（T3 两段生命周期的第一层）。 */
export async function archiveSessionsQuietly(
  deps: Pick<ArchiveDeps, 'now' | 'sessions'>,
  sessions: readonly Session[]
): Promise<number> {
  let count = 0;
  for (const session of sessions) {
    if (session.settledAt != null || session.status === 'running') continue;
    await deps.sessions.save({ ...session, settledAt: deps.now() });
    count += 1;
  }
  return count;
}

async function sessionsOfWorkspace(deps: ArchiveDeps, workspace: Workspace): Promise<Session[]> {
  const direct = await deps.sessions.listByWorkspace(workspace.id);
  if (!workspace.groupId || !deps.workspaceGroups) return direct;
  const group = await deps.workspaceGroups.byId(workspace.groupId);
  if (!group) return direct;
  const all = await deps.sessions.listByProject(group.projectId);
  const siblings = all.filter((session) => session.groupId === group.id);
  const seen = new Set(direct.map((session) => session.id));
  return [...direct, ...siblings.filter((session) => !seen.has(session.id))];
}

/**
 * 某条 PR 刚合并：单仓会话立刻收起；组合会话要等每个成员都已合并或没有改动，才整组收起。
 * 不拆 worktree，会话记录保留。
 */
export async function archiveAfterPullRequestMerged(deps: ArchiveDeps, link: PullRequestLink): Promise<number> {
  const sessions: Session[] = [];
  if (link.sessionId) {
    const session = await deps.sessions.byId(link.sessionId as Session['id']);
    if (session) sessions.push(session);
  }
  if (link.workspaceId) {
    const workspace = await deps.workspaces.byId(link.workspaceId as Workspace['id']);
    if (workspace) {
      for (const session of await sessionsOfWorkspace(deps, workspace)) {
        if (!sessions.some((existing) => existing.id === session.id)) sessions.push(session);
      }
    }
  }
  if (sessions.length === 0) return 0;

  const combo = sessions.find((session) => session.groupId) ?? null;
  if (combo?.groupId && deps.workspaceGroups) {
    const group = await deps.workspaceGroups.byId(combo.groupId);
    if (group && !(await comboReadyToArchive(deps, group))) return 0;
  }
  return archiveSessionsQuietly(deps, sessions);
}

/** 组合组：每个成员都有已合并的 PR，或者这个成员本身没有改动，才允许整组收起。 */
export async function comboReadyToArchive(deps: ArchiveDeps, group: WorkspaceGroup): Promise<boolean> {
  const prs = deps.cleanup?.pullRequests;
  for (const member of group.members) {
    const workspace = await deps.workspaces.byId(member.workspaceId);
    if (!workspace || workspace.state === 'removed') continue;
    const mine = prs
      ? [
          ...(await prs.byWorkspace(workspace.id)),
          ...(workspace.ownerTaskId ? (await prs.byTask(workspace.ownerTaskId)).filter((pr) => pr.branch === workspace.branch) : [])
        ]
      : [];
    if (mine.some((pr) => pr.state === 'merged')) continue;
    // 没有已合并 PR：工作区干净且没有未推送提交，才算「这个仓库没有改动」
    if (!deps.git && !deps.gateway) return false;
    const git = await gitFor(deps as Parameters<typeof gitFor>[0], workspace.workerId);
    const status = await git.status(workspace.path);
    if (!status.ok) return false;
    const clean = !status.value.dirty && status.value.untracked === 0 && status.value.unpushed === 0;
    if (!clean) return false;
  }
  return group.members.length > 0;
}
