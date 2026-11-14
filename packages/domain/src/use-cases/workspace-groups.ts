import type { Subject } from '../access.ts';
import type { DomainError } from '../errors.ts';
import { conflict, forbidden, invalid, notFound } from '../errors.ts';
import { asProjectId, asTaskId, asWorkspaceGroupId, newId } from '../ids.ts';
import type { Project, ProjectRepo } from '../project.ts';
import type { WorkspaceGroupRepository } from '../ports/workspace-groups.ts';
import { err, ok, type Result } from '../result.ts';
import { isUsable, markRemoved, newWorkspace, type Workspace } from '../workspace.ts';
import {
  WORKSPACE_GROUP_MEMBERS_MAX,
  WORKSPACE_GROUP_NAME,
  failedMembers,
  groupMemberRoot,
  groupState,
  type WorkspaceGroup,
  type WorkspaceGroupMember
} from '../workspace-group.ts';
import { authorizeWorker, canManageTeamWorkspaces } from './authorization.ts';
import type { Deps } from './deps.ts';
import { gitOn, resolveMachine, type Machine } from './machine-dirs.ts';
import { branchSlug, runWorkspaceSetup, shortId } from './temporary-workspaces.ts';
import { actorId, prepareTeamWorkspace } from './workspaces.ts';

/**
 * 组合工作空间（docs/design/multi-repo.md §4–§6）：
 * 一个组 = 同一台机器上一个容器目录 + 每个仓库一个 worktree 成员。
 *
 * - 建组：容器 `<root>`，成员 `<root>/<repo-name>`，任一成员失败整组 failed，容器保留等重试；
 * - 重试：只重试 failed 成员（已建成的成员不动）；
 * - 删组：容器整体删掉，成员登记逐条 remove，最后删组行。
 *
 * TODO(groupId): `Workspace.groupId` 的持久化列由另一条线补；成员表（workspace_group_members）
 * 已经记着归属，所以即便 sqlite 读回来少了 groupId，组的语义仍然完整。
 */

export type WorkspaceGroupDeps = Pick<
  Deps,
  'fs' | 'git' | 'gateway' | 'now' | 'projects' | 'sessions' | 'tasks' | 'workspaces' | 'access'
> & {
  readonly workspaceGroups?: WorkspaceGroupRepository;
  /** 删组前要先丢 checkpoint（同 removeWorkspaceUseCase）。 */
  readonly cleanup?: NonNullable<Deps['cleanup']>;
};

export interface BuildWorkspaceGroupCommand {
  readonly projectId: string;
  readonly taskId: string;
  readonly workerId?: string | null;
  readonly home: string;
  readonly actor?: Subject | null;
}

export interface RetryWorkspaceGroupCommand {
  readonly groupId: string;
  readonly home: string;
  readonly actor?: Subject | null;
}

export interface RemoveWorkspaceGroupCommand {
  readonly groupId: string;
  readonly home?: string;
  readonly actor?: Subject | null;
}

const MAX = WORKSPACE_GROUP_MEMBERS_MAX;

/** 组名 = 任务 slug + 4 位短号，撞名概率低且能直接当目录用。 */
function groupName(title: string): string {
  const name = `${branchSlug(title)}-${shortId()}`;
  return WORKSPACE_GROUP_NAME.test(name) ? name : `g-${name}`.slice(0, 41);
}

/** 每个仓库单独一条分支（§4）：同一个组里不同仓库的分支不能一样。 */
function groupBranch(repo: ProjectRepo): string {
  return `agent-hub/${repo.name}-${shortId()}`;
}

/**
 * 某仓库在这台机器上的长期 git 工作空间（clone 出来的）。
 * 没有就先建一个长期空间（复用团队工作空间的 clone 流程）并关联到项目。
 */
async function baseForRepo(
  deps: WorkspaceGroupDeps,
  project: Project,
  repo: ProjectRepo,
  machine: Machine,
  command: { readonly home: string; readonly actor: Subject | null }
): Promise<Result<Workspace, DomainError>> {
  const candidates = (await deps.workspaces.byProject(project.id))
    .filter((workspace) => workspace.kind === 'long_lived' && isUsable(workspace) && workspace.workerId === machine.workerId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const known = candidates.find((workspace) => workspace.repoUrl === repo.url && workspace.isGit === true);
  if (known) return ok(known);
  // 老登记没探测过 isGit：问一下那台机器，别再 clone 一份
  const git = gitOn(deps, machine.route);
  for (const workspace of candidates) {
    if (workspace.repoUrl !== repo.url || workspace.isGit !== null) continue;
    const inspected = await git.inspect(workspace.path);
    if (!inspected.ok || !inspected.value.isGit) continue;
    const updated: Workspace = {
      ...workspace,
      isGit: true,
      branch: inspected.value.branch ?? workspace.branch,
      updatedAt: deps.now()
    };
    await deps.workspaces.save(updated);
    return ok(updated);
  }
  const prepared = await prepareTeamWorkspace(deps, {
    teamId: project.teamId,
    originProjectId: project.id,
    repo: { url: repo.url, branch: repo.defaultBranch ?? null },
    slug: branchSlug(project.name),
    workerId: machine.workerId,
    plan: { mode: 'create' },
    home: command.home,
    actor: command.actor
  });
  if (!prepared.ok) return prepared;
  await deps.workspaces.link({ projectId: project.id, workspaceId: prepared.value.id, linkedBy: actorId(command.actor), linkedAt: deps.now() });
  return prepared;
}

export async function buildWorkspaceGroupUseCase(
  deps: WorkspaceGroupDeps,
  command: BuildWorkspaceGroupCommand
): Promise<Result<WorkspaceGroup, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project || project.deletedAt !== null) return err(notFound('项目不存在'));
  const task = await deps.tasks.byId(asTaskId(command.taskId));
  if (!task || task.projectId !== project.id) return err(notFound('任务不存在'));
  const repos = project.repos;
  if (repos.length === 0) return err(invalid('项目还没有配置仓库'));
  if (repos.length > MAX) return err(invalid(`一个组最多 ${MAX} 个仓库`));
  const store = deps.workspaceGroups;
  if (!store) return err(invalid('组合工作空间还没有启用'));
  const actor = command.actor ?? null;
  const resolved = await resolveMachine(deps, command.workerId ?? null);
  if (!resolved.ok) return resolved;
  const machine = resolved.value;
  const allowed = await authorizeWorker(deps.access, actor, machine.workerId);
  if (!allowed.ok) return allowed;
  const workerId = machine.workerId;
  // 本机 worker 也要走 gateway 通道（node-gateway 的本地 worker 也有 channel）
  const groupGit = workerId ? deps.gateway.groups?.(workerId) : undefined;
  if (!workerId || !groupGit) return err(invalid('这台机器不支持组合工作空间'));

  const groupId = asWorkspaceGroupId(`group_${newId().slice(0, 8)}`);
  const incoming = await groupGit.init({ slug: branchSlug(project.name), name: groupName(task.title), id: groupId });
  if (!incoming.ok) return incoming;
  const root = incoming.value.root;
  const createdAt = deps.now();
  const setup = project.worktree?.setup ?? null;

  const group = (members: readonly WorkspaceGroupMember[], state: WorkspaceGroup['state'], error: string | null): WorkspaceGroup => ({
    id: groupId,
    projectId: project.id,
    workerId,
    root,
    members,
    state,
    ownerTaskId: task.id,
    createdAt,
    error
  });

  const abort = async (
    members: readonly WorkspaceGroupMember[],
    rest: readonly ProjectRepo[],
    error: DomainError
  ): Promise<Result<WorkspaceGroup, DomainError>> => {
    const failed = members.map((member) => ({ ...member, state: 'failed' as const, error: member.error ?? error.message }));
    for (const member of failed) {
      const workspace = await deps.workspaces.byId(member.workspaceId);
      if (!workspace || workspace.state === 'failed' || workspace.state === 'removed') continue;
      await deps.workspaces.save({ ...workspace, state: 'failed', keptReason: '组合工作空间没有建好', updatedAt: deps.now() });
    }
    // 还没轮到的仓库也登记成 failed 成员：重试时才知道还要建哪几个（§12.7 只重试 failed 成员）
    for (const repo of rest) {
      const placeholder = newWorkspace({
        projectId: project.id,
        teamId: project.teamId,
        repoUrl: repo.url,
        workerId: machine.workerId,
        path: `${root}/${repo.name}`,
        kind: 'temporary',
        source: 'worktree',
        ownerTaskId: task.id,
        branch: groupBranch(repo),
        isGit: true,
        state: 'failed',
        groupId,
        now: deps.now()
      });
      if (!placeholder.ok) continue;
      await deps.workspaces.save(placeholder.value);
      failed.push({ workspaceId: placeholder.value.id, repoId: repo.id, name: repo.name, state: 'failed', error: error.message });
    }
    // 容器保留：重试要在原地重建（§12.4）
    await store.save(group(failed, 'failed', error.message));
    return err(error);
  };

  const members: WorkspaceGroupMember[] = [];
  for (let index = 0; index < repos.length; index++) {
    const repo = repos[index];
    if (!repo) continue;
    const base = await baseForRepo(deps, project, repo, machine, { home: command.home, actor });
    if (!base.ok) return abort(members, repos.slice(index), base.error);
    const made = await groupGit.newWorktree({
      repoPath: base.value.path,
      path: `${root}/${repo.name}`,
      branch: groupBranch(repo),
      base: repo.defaultBranch ?? undefined
    });
    if (!made.ok) return abort(members, repos.slice(index), made.error);
    const created = newWorkspace({
      projectId: project.id,
      teamId: project.teamId,
      repoUrl: repo.url,
      workerId: machine.workerId,
      path: made.value.path,
      kind: 'temporary',
      source: 'worktree',
      ownerTaskId: task.id,
      baseWorkspaceId: base.value.id,
      branch: made.value.branch,
      isGit: true,
      state: setup ? 'preparing' : 'ready',
      groupId,
      now: deps.now()
    });
    if (!created.ok) return abort(members, repos.slice(index), created.error);
    await deps.workspaces.save(created.value);
    members.push({ workspaceId: created.value.id, repoId: repo.id, name: repo.name, state: setup ? 'preparing' : 'ready', error: null });
  }

  // 成员先落组行：准备命令跑到一半崩了也能在组列表里看到
  await store.save(group(members, groupState(members), null));
  if (setup) {
    for (let index = 0; index < members.length; index++) {
      const member = members[index];
      if (!member) continue;
      const workspace = await deps.workspaces.byId(member.workspaceId);
      if (!workspace) continue;
      const prepared = await runWorkspaceSetup(deps, machine, workspace, setup);
      const ready = prepared.state === 'ready';
      members[index] = {
        ...member,
        state: ready ? 'ready' : 'failed',
        error: ready ? null : (prepared.setup?.message ?? prepared.keptReason ?? '准备命令失败')
      };
    }
  }
  const state = groupState(members);
  const final = group(members, state, state === 'failed' ? (members.find((member) => member.state === 'failed')?.error ?? '准备命令失败') : null);
  await store.save(final);
  return ok(final);
}

export async function retryWorkspaceGroupUseCase(
  deps: WorkspaceGroupDeps,
  command: RetryWorkspaceGroupCommand
): Promise<Result<WorkspaceGroup, DomainError>> {
  const store = deps.workspaceGroups;
  if (!store) return err(invalid('组合工作空间还没有启用'));
  const groupId = asWorkspaceGroupId(command.groupId);
  const existing = await store.byId(groupId);
  if (!existing) return err(notFound('组合工作空间不存在'));
  if (existing.state !== 'failed') return err(conflict('这组已经准备好了'));
  const project = await deps.projects.byId(existing.projectId);
  if (!project || project.deletedAt !== null) return err(notFound('项目不存在'));
  const actor = command.actor ?? null;
  const resolved = await resolveMachine(deps, existing.workerId);
  if (!resolved.ok) return resolved;
  const machine = resolved.value;
  const allowed = await authorizeWorker(deps.access, actor, machine.workerId);
  if (!allowed.ok) return allowed;
  const groupGit = machine.workerId ? deps.gateway.groups?.(machine.workerId) : undefined;
  if (!groupGit) return err(invalid('这台机器不支持组合工作空间'));
  const setup = project.worktree?.setup ?? null;
  const retried = new Map<string, WorkspaceGroupMember>();
  const retryOne = async (member: WorkspaceGroupMember): Promise<WorkspaceGroupMember> => {
    const repo = project.repos.find((candidate) => candidate.id === member.repoId);
    if (!repo) return { ...member, state: 'failed', error: '仓库已经从项目里移除了' };
    const workspace = await deps.workspaces.byId(member.workspaceId);
    if (!workspace) return { ...member, state: 'failed', error: '成员的工作空间登记不见了' };
    if (workspace.state === 'removed') return { ...member, state: 'failed', error: '成员的工作空间已经删除了' };
    const base = await baseForRepo(deps, project, repo, machine, { home: command.home, actor });
    if (!base.ok) return { ...member, state: 'failed', error: base.error.message };
    const path = groupMemberRoot(existing, member.workspaceId) ?? workspace.path;
    const branch = workspace.branch ?? groupBranch(repo);
    const preparing: Workspace = { ...workspace, state: 'preparing', keptReason: null, updatedAt: deps.now() };
    await deps.workspaces.save(preparing);
    const made = await groupGit.newWorktree({
      repoPath: base.value.path,
      path,
      branch,
      base: repo.defaultBranch ?? undefined
    });
    // 目录已经是同分支的 worktree 就算建成（§12.7），别因为「已经存在」整组失败
    if (!made.ok && !/已存在|exists/i.test(made.error.message)) {
      await deps.workspaces.save({ ...preparing, state: 'failed', keptReason: '工作空间没有建好', updatedAt: deps.now() });
      return { ...member, state: 'failed', error: made.error.message };
    }
    const replaced = await deps.workspaces.byId(member.workspaceId);
    const ready: Workspace = {
      ...(replaced ?? preparing),
      path,
      repoUrl: repo.url,
      baseWorkspaceId: base.value.id,
      branch,
      isGit: true,
      state: setup ? 'preparing' : 'ready',
      keptReason: null,
      updatedAt: deps.now()
    };
    await deps.workspaces.save(ready);
    const prepared = setup ? await runWorkspaceSetup(deps, machine, ready, setup) : ready;
    const readyNow = prepared.state === 'ready';
    return {
      ...member,
      state: readyNow ? 'ready' : 'failed',
      error: readyNow ? null : (prepared.setup?.message ?? prepared.keptReason ?? '准备命令失败')
    };
  };

  for (const member of failedMembers(existing)) retried.set(member.workspaceId, member);
  for (const member of [...retried.values()]) retried.set(member.workspaceId, await retryOne(member));
  const members = existing.members.map((member) => retried.get(member.workspaceId) ?? member);
  const state = groupState(members);
  const next: WorkspaceGroup = {
    ...existing,
    members,
    state,
    error: state === 'failed' ? (members.find((member) => member.state === 'failed')?.error ?? '准备命令失败') : null
  };
  await store.save(next);
  return ok(next);
}

export async function removeWorkspaceGroupUseCase(
  deps: WorkspaceGroupDeps,
  command: RemoveWorkspaceGroupCommand
): Promise<Result<{ readonly id: string; readonly removed: boolean }, DomainError>> {
  const store = deps.workspaceGroups;
  if (!store) return err(invalid('组合工作空间还没有启用'));
  const groupId = asWorkspaceGroupId(command.groupId);
  const group = await store.byId(groupId);
  if (!group) return err(notFound('组合工作空间不存在'));
  const actor = command.actor ?? null;
  const project = await deps.projects.byId(group.projectId);
  if (!(await canManageTeamWorkspaces(deps.access, actor, project?.teamId ?? null))) return err(forbidden('没有删除工作空间的权限'));

  const sessions = await deps.sessions.listByProject(group.projectId);
  if (sessions.some((session) => session.groupId === group.id && session.status === 'running')) {
    return err(conflict('这组还有正在跑的会话'));
  }

  const groupGit = group.workerId ? deps.gateway.groups?.(group.workerId) : undefined;
  if (!groupGit) return err(invalid('这台机器不支持组合工作空间'));
  const dropped = await groupGit.remove({ root: group.root, id: group.id });
  if (!dropped.ok) return dropped;

  const dropCheckpoints = deps.cleanup?.dropCheckpoints;
  for (const member of group.members) {
    const workspace = await deps.workspaces.byId(member.workspaceId);
    if (!workspace || workspace.state === 'removed') continue;
    // 先丢 checkpoint 再删：删完就没地方回放了（§6）
    if (dropCheckpoints) {
      const owned = await deps.sessions.listByWorkspace(workspace.id);
      for (const session of owned) await dropCheckpoints(session.id).catch(() => undefined);
    }
    const removed = markRemoved(workspace, deps.now());
    if (removed.ok) await deps.workspaces.save(removed.value);
  }
  await store.remove(group.id);
  return ok({ id: group.id, removed: true });
}
