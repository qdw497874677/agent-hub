import type { Subject } from '../access.ts';
import type { DomainError } from '../errors.ts';
import { conflict, forbidden, invalid, notFound } from '../errors.ts';
import { asProjectId, asTaskId, asWorkspaceGroupId, newId, newSessionId } from '../ids.ts';
import type { Project, ProjectRepo } from '../project.ts';
import { designatedPrimaryRepo, recurseSubmodules } from '../project.ts';
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
import { branchSlug, originBranchRef, runWorkspaceSetup, sessionBranchSuffix, shortId } from './temporary-workspaces.ts';
import { unsavedReason } from './workspace-cleanup.ts';
import { actorId, prepareTeamWorkspace } from './workspaces.ts';

/**
 * 组合工作空间（docs/design/multi-repo.md §4–§6）：
 * 一个组 = 同一台机器上一个容器目录 + 每个仓库一个 worktree 成员。
 *
 * - 建组：必须先指定主仓库。amp 布局下主仓库在 `<root>/<name>`（也是 cwd），附加仓在 `<root>/repos/<name>`；
 * - 可只选一部分仓库（主仓库始终在内），之后还能往已有组里加仓；
 * - 准备命令只在主仓库跑；
 * - 重试：只重试 failed 成员（已建成的成员不动）；
 * - 删组：先确认成员都干净，再整组删掉。
 *
 * TODO(groupId): `Workspace.groupId` 的持久化列由另一条线补；成员表（workspace_group_members）
 * 已经记着归属，所以即便 sqlite 读回来少了 groupId，组的语义仍然完整。
 */

export type WorkspaceGroupDeps = Pick<
  Deps,
  'fs' | 'git' | 'gateway' | 'now' | 'projects' | 'sessions' | 'tasks' | 'workspaces' | 'access' | 'repoAuth'
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
  /** 预分配的会话 id，写入成员分支名。不给就在建组时生成。 */
  readonly sessionId?: string | null;
  /** 要进组的仓库 id。省略 = 项目里全部；主仓库总会被带上。 */
  readonly repoIds?: readonly string[];
  /**
   * 按已有分支建组（验证交接）：成员检出这些分支（远端有同名分支时跟踪 origin/<branch>）。
   * 未点名的仓库仍用默认的 `agent-hub/<repo>-<sessionId>`。
   */
  readonly branches?: readonly { readonly repoId: string; readonly branch: string }[];
  /** 从已有组合组拷贝各成员当前分支（再被 branches 覆盖）。目标 worker 用 workerId 指定。 */
  readonly fromGroupId?: string | null;
}

export interface AddWorkspaceGroupMemberCommand {
  readonly groupId: string;
  readonly repoId: string;
  readonly home: string;
  readonly actor?: Subject | null;
}

export interface RetryWorkspaceGroupCommand {
  readonly groupId: string;
  readonly home: string;
  readonly actor?: Subject | null;
  /** 预分配的会话 id，写入成员分支名。不给就在建组时生成。 */
  readonly sessionId?: string | null;
  /** 要进组的仓库 id。省略 = 项目里全部；主仓库总会被带上。 */
  readonly repoIds?: readonly string[];
}

export interface AddWorkspaceGroupMemberCommand {
  readonly groupId: string;
  readonly repoId: string;
  readonly home: string;
  readonly actor?: Subject | null;
}

export interface RemoveWorkspaceGroupCommand {
  readonly groupId: string;
  readonly home?: string;
  readonly actor?: Subject | null;
}

const MAX = WORKSPACE_GROUP_MEMBERS_MAX;

/** amp 布局的成员目录：主仓库在容器根下，附加仓在 repos/ 下。 */
export function memberWorktreePath(root: string, repo: Pick<ProjectRepo, 'id' | 'name'>, primaryRepoId: string): string {
  return repo.id === primaryRepoId ? `${root}/${repo.name}` : `${root}/repos/${repo.name}`;
}

/** 选进组的仓库：主仓库永远在第一位；省略 repoIds 就是项目全部。 */
export function selectedGroupRepos(project: Project, repoIds?: readonly string[]): Result<ProjectRepo[], DomainError> {
  const primary = designatedPrimaryRepo(project);
  if (!primary) return err(invalid('要开组合会话，先在项目里指定主仓库'));
  if (project.repos.length === 0) return err(invalid('项目还没有配置仓库'));
  const wanted = repoIds === undefined ? project.repos.map((repo) => repo.id) : [...new Set(repoIds)];
  if (!wanted.includes(primary.id)) wanted.unshift(primary.id);
  const repos: ProjectRepo[] = [];
  const seen = new Set<string>();
  for (const id of [primary.id, ...wanted.filter((id) => id !== primary.id)]) {
    if (seen.has(id)) continue;
    const repo = project.repos.find((candidate) => candidate.id === id);
    if (!repo) return err(invalid('有仓库不在这个项目里'));
    seen.add(id);
    repos.push(repo);
  }
  if (repos.length === 0) return err(invalid('至少选一个仓库'));
  if (repos.length > MAX) return err(invalid(`一个组最多 ${MAX} 个仓库`));
  return ok(repos);
}

/** 组名 = 任务 slug + 4 位短号，撞名概率低且能直接当目录用。 */
function groupName(title: string): string {
  const name = `${branchSlug(title)}-${shortId()}`;
  return WORKSPACE_GROUP_NAME.test(name) ? name : `g-${name}`.slice(0, 41);
}

/** 每个仓库单独一条分支：仓库名 + 会话 id 后缀，避免两个会话检出同一分支。 */
function groupBranch(repo: ProjectRepo, sessionId: string): string {
  return `agent-hub/${repo.name}-${sessionBranchSuffix(sessionId)}`;
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
    // 本机的老登记 workerId 可能是 null，而 resolveMachine 给的是本机 worker 的记账 id。
    .filter(
      (workspace) =>
        workspace.kind === 'long_lived' &&
        isUsable(workspace) &&
        (workspace.workerId === machine.workerId || (machine.route === null && workspace.workerId === null))
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const known = candidates.find((workspace) => workspace.repoUrl === repo.url && workspace.isGit === true);
  if (known) return ok(known);
  // 老登记没探测过 isGit / repoUrl 是空的（本机 link 进来的目录）：问一下那台机器，认 origin 再采纳，别再 clone 一份
  const git = gitOn(deps, machine.route);
  for (const workspace of candidates) {
    if (workspace.repoUrl !== null && workspace.repoUrl !== repo.url) continue;
    if (workspace.repoUrl === repo.url && workspace.isGit === true) continue;
    const inspected = await git.inspect(workspace.path);
    if (!inspected.ok || !inspected.value.isGit) continue;
    if (inspected.value.remoteUrl !== repo.url) continue;
    const updated: Workspace = {
      ...workspace,
      repoUrl: repo.url,
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


async function resolveMemberBranches(
  deps: WorkspaceGroupDeps,
  command: BuildWorkspaceGroupCommand,
  repos: readonly ProjectRepo[],
  sessionId: string
): Promise<Result<ReadonlyMap<string, string>, DomainError>> {
  const map = new Map<string, string>();
  if (command.fromGroupId) {
    const source = await deps.workspaceGroups?.byId(asWorkspaceGroupId(command.fromGroupId));
    if (!source) return err(notFound('源组合工作空间不存在'));
    for (const member of source.members) {
      const workspace = await deps.workspaces.byId(member.workspaceId);
      const branch = workspace?.branch?.trim();
      if (branch) map.set(member.repoId, branch);
    }
  }
  for (const item of command.branches ?? []) {
    if (!repos.some((repo) => repo.id === item.repoId)) return err(invalid('branches 里有仓库不在这次建组的清单里'));
    const branch = item.branch.trim();
    if (branch === '') return err(invalid('分支名不能为空'));
    map.set(item.repoId, branch);
  }
  for (const repo of repos) {
    if (!map.has(repo.id)) map.set(repo.id, groupBranch(repo, sessionId));
  }
  return ok(map);
}

export async function buildWorkspaceGroupUseCase(
  deps: WorkspaceGroupDeps,
  command: BuildWorkspaceGroupCommand
): Promise<Result<WorkspaceGroup, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project || project.deletedAt !== null) return err(notFound('项目不存在'));
  const task = await deps.tasks.byId(asTaskId(command.taskId));
  if (!task || task.projectId !== project.id) return err(notFound('任务不存在'));
  const picked = selectedGroupRepos(project, command.repoIds);
  if (!picked.ok) return picked;
  const repos = picked.value;
  const primaryRepoId = repos[0]!.id;
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
  const sessionId = command.sessionId?.trim() || newSessionId();
  const branches = await resolveMemberBranches(deps, command, repos, sessionId);
  if (!branches.ok) return branches;
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
    layout: 'amp',
    primaryRepoId,
    ownerTaskId: task.id,
    sessionId,
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
        path: memberWorktreePath(root, repo, primaryRepoId),
        kind: 'temporary',
        source: 'worktree',
        ownerTaskId: task.id,
        branch: groupBranch(repo, sessionId),
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
  const baseRef = originBranchRef(task.baseBranch);
  for (let index = 0; index < repos.length; index++) {
    const repo = repos[index];
    if (!repo) continue;
    const base = await baseForRepo(deps, project, repo, machine, { home: command.home, actor });
    if (!base.ok) return abort(members, repos.slice(index), base.error);
    const auth = (await deps.repoAuth?.forUrl(machine.workerId, repo.url, project.id)) ?? undefined;
    const branch = branches.value.get(repo.id) ?? groupBranch(repo, sessionId);
    const follow = (command.fromGroupId || command.branches?.length) && branch !== groupBranch(repo, sessionId);
    const made = await groupGit.newWorktree({
      repoPath: base.value.path,
      path: memberWorktreePath(root, repo, primaryRepoId),
      branch,
      base: follow ? branch : (baseRef ?? originBranchRef(repo.defaultBranch) ?? undefined),
      ...(auth ? { auth } : {}),
      ...(recurseSubmodules(project) ? { recurseSubmodules: true } : {})
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
      state: setup && repo.id === primaryRepoId ? 'preparing' : 'ready',
      groupId,
      now: deps.now()
    });
    if (!created.ok) return abort(members, repos.slice(index), created.error);
    await deps.workspaces.save(created.value);
    members.push({ workspaceId: created.value.id, repoId: repo.id, name: repo.name, state: setup && repo.id === primaryRepoId ? 'preparing' : 'ready', error: null });
  }

  // 成员先落组行：准备命令跑到一半崩了也能在组列表里看到
  await store.save(group(members, groupState(members), null));
  if (setup) {
    for (let index = 0; index < members.length; index++) {
      const member = members[index];
      if (!member || member.repoId !== primaryRepoId) continue;
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
  const ownerTask = existing.ownerTaskId ? await deps.tasks.byId(existing.ownerTaskId) : null;
  const baseRef = originBranchRef(ownerTask?.baseBranch ?? null);
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
    const branch = workspace.branch ?? groupBranch(repo, existing.sessionId ?? workspace.id);
    const preparing: Workspace = { ...workspace, state: 'preparing', keptReason: null, updatedAt: deps.now() };
    await deps.workspaces.save(preparing);
    const auth = (await deps.repoAuth?.forUrl(machine.workerId, repo.url, project.id)) ?? undefined;
    const made = await groupGit.newWorktree({
      repoPath: base.value.path,
      path,
      branch,
      base: baseRef ?? originBranchRef(repo.defaultBranch) ?? undefined,
      ...(auth ? { auth } : {}),
      ...(recurseSubmodules(project) ? { recurseSubmodules: true } : {})
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
    const runSetup = Boolean(setup) && (existing.layout !== 'amp' || repo.id === existing.primaryRepoId);
    const prepared = runSetup ? await runWorkspaceSetup(deps, machine, ready, setup!) : { ...ready, state: 'ready' as const };
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

  const git = gitOn(deps, group.workerId);
  for (const member of group.members) {
    const workspace = await deps.workspaces.byId(member.workspaceId);
    if (!workspace || workspace.state === 'removed') continue;
    const status = await git.status(workspace.path);
    if (!status.ok) return err(conflict(`没有删：无法检查 ${member.name} 的改动`));
    const reason = unsavedReason(status.value);
    if (reason) return err(conflict(`没有删：${member.name} ${reason}`));
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

export async function addWorkspaceGroupMemberUseCase(
  deps: WorkspaceGroupDeps,
  command: AddWorkspaceGroupMemberCommand
): Promise<Result<WorkspaceGroup, DomainError>> {
  const store = deps.workspaceGroups;
  if (!store) return err(invalid('组合工作空间还没有启用'));
  const groupId = asWorkspaceGroupId(command.groupId);
  const group = await store.byId(groupId);
  if (!group) return err(notFound('组合工作空间不存在'));
  if (group.members.some((member) => member.repoId === command.repoId)) return err(conflict('这个仓库已经在组里了'));
  if (group.members.length >= MAX) return err(invalid(`一个组最多 ${MAX} 个仓库`));
  const project = await deps.projects.byId(group.projectId);
  if (!project || project.deletedAt !== null) return err(notFound('项目不存在'));
  const repo = project.repos.find((candidate) => candidate.id === command.repoId);
  if (!repo) return err(invalid('仓库不在这个项目里'));
  const actor = command.actor ?? null;
  const resolved = await resolveMachine(deps, group.workerId);
  if (!resolved.ok) return resolved;
  const machine = resolved.value;
  const allowed = await authorizeWorker(deps.access, actor, machine.workerId);
  if (!allowed.ok) return allowed;
  const groupGit = machine.workerId ? deps.gateway.groups?.(machine.workerId) : undefined;
  if (!groupGit) return err(invalid('这台机器不支持组合工作空间'));
  if (!WORKSPACE_GROUP_NAME.test(repo.name)) return err(invalid(`仓库名只能是小写字母、数字和短横线：${repo.name}`));
  if (group.members.some((member) => member.name === repo.name)) return err(conflict('组里已经有同名仓库'));

  const primaryRepoId = group.primaryRepoId ?? designatedPrimaryRepo(project)?.id ?? null;
  const path = group.layout === 'amp' && primaryRepoId
    ? memberWorktreePath(group.root, repo, primaryRepoId)
    : `${group.root}/${repo.name}`;
  const sessionId = group.sessionId ?? group.id;
  const ownerTask = group.ownerTaskId ? await deps.tasks.byId(group.ownerTaskId) : null;
  const baseRef = originBranchRef(ownerTask?.baseBranch ?? null);
  const base = await baseForRepo(deps, project, repo, machine, { home: command.home, actor });
  if (!base.ok) return base;
  const auth = (await deps.repoAuth?.forUrl(machine.workerId, repo.url, project.id)) ?? undefined;
  const made = await groupGit.newWorktree({
    repoPath: base.value.path,
    path,
    branch: groupBranch(repo, sessionId),
    base: baseRef ?? originBranchRef(repo.defaultBranch) ?? undefined,
    ...(auth ? { auth } : {}),
    ...(recurseSubmodules(project) ? { recurseSubmodules: true } : {})
  });
  if (!made.ok) return made;
  const created = newWorkspace({
    projectId: project.id,
    teamId: project.teamId,
    repoUrl: repo.url,
    workerId: machine.workerId,
    path: made.value.path,
    kind: 'temporary',
    source: 'worktree',
    ownerTaskId: group.ownerTaskId,
    baseWorkspaceId: base.value.id,
    branch: made.value.branch,
    isGit: true,
    state: 'ready',
    groupId,
    now: deps.now()
  });
  if (!created.ok) return created;
  await deps.workspaces.save(created.value);
  const member: WorkspaceGroupMember = {
    workspaceId: created.value.id,
    repoId: repo.id,
    name: repo.name,
    state: 'ready',
    error: null
  };
  const members = [...group.members, member];
  const next: WorkspaceGroup = {
    ...group,
    members,
    state: groupState(members),
    pendingBriefing: true,
    error: null
  };
  await store.save(next);
  return ok(next);
}
