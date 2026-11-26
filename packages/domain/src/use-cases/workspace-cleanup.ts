import { markKept, markRemoved, platformOwnsDirectory, type Workspace } from '../workspace.ts';
import type { GitStatus } from '../ports/workspace-git.ts';
import { asProjectId, asWorkspaceId, newId } from '../ids.ts';
import { DEFAULT_CLEANUP_POLICY, IDLE_DAYS_MAX, withPolicyDefaults, type CleanupPolicy, type SweepItem } from '../ports/workspace-sweeps.ts';
import { archiveSessionsQuietly, comboReadyToArchive } from './session-archive.ts';
import type { WorkspaceGroup } from '../workspace-group.ts';
import type { Session } from '../session.ts';
import type { PullRequestLink } from '../ports/pull-requests.ts';
import type { DomainError } from '../errors.ts';
import { conflict, invalid, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';
import { gitFor } from './machine-dirs.ts';
import { groupMemberRoot } from '../workspace-group.ts';
import { fenceWorkspace, finishFence, finishSettledFailure, workdirTarget } from './workdir-safety.ts';

type CleanupDeps = Pick<Deps, 'git' | 'gateway' | 'now' | 'sessions' | 'tasks' | 'workspaces'> & Partial<Pick<Deps, 'projects' | 'cleanup' | 'workspaceGroups' | 'workdirSafety'>>;

/** 删了会丢什么，说人话；都没有返回 null（§5 第 3 条）。 */
export function unsavedReason(status: GitStatus): string | null {
  // 不是 git 仓库：平台分不清哪些文件要紧，只要目录里还有东西就留着（空目录才删）
  if (status.dirty === null) {
    if (status.files === undefined || status.files === null) return null; // 老 Worker 不报：删的时候 Worker 自己会再查
    return status.files > 0 ? nonGitReason(status.files) : null;
  }
  const parts: string[] = [];
  if (status.dirty) parts.push('有未提交的改动');
  if (status.untracked > 0) parts.push(`有 ${status.untracked} 个未跟踪的文件`);
  if (status.unpushed > 0) parts.push(`有 ${status.unpushed} 个提交还没推送或合并`);
  return parts.length > 0 ? parts.join('，') : null;
}

export const nonGitReason = (files: number) => `不是 git 仓库，目录里还有 ${files >= 10_000 ? '10000+' : files} 个文件，平台分不清哪些要紧，先留着`;

const FINISHED = new Set(['done', 'abandoned']);
const DAY_MS = 24 * 60 * 60 * 1000;

async function busy(deps: Pick<Deps, 'sessions'> & Partial<Pick<Deps, 'cleanup'>>, workspace: Workspace): Promise<boolean> {
  // ADR 0026：长期工作空间被多个项目共用，所有项目的会话都算
  const sessions = await deps.sessions.listByWorkspace(workspace.id);
  if (sessions.some((session) => session.status === 'running')) return true;
  // 会话可能已经 done，但终端还开着：删目录会把正在用的 shell 抽掉。
  const live = deps.cleanup?.liveSessions?.() ?? [];
  if (live.length === 0) return false;
  const open = new Set(live);
  return sessions.some((session) => open.has(session.id));
}

const removeKind = (workspace: Workspace) => (workspace.source === 'worktree' ? 'worktree' : 'directory');

export interface SweepReport {
  readonly removed: readonly string[];
  readonly kept: readonly string[];
  /** 有会话在跑、机器离线……下次再查。 */
  readonly skipped: readonly string[];
  readonly failed?: readonly string[];
  readonly runId?: string | null;
  /**
   * 这一轮没有可清的东西时给人看的说明。
   * 常见原因：干净的临时 worktree 已在 session_settle 时拆除。
   */
  readonly message?: string;
  /** 项目里已经是 removed 状态的临时 worktree（多半是收起时拆掉的）。 */
  readonly alreadyRemoved?: readonly string[];
}

/** 项目规则 → 团队默认 → 内置默认（D6）。 */
export async function cleanupPolicyFor(deps: Partial<Pick<Deps, 'projects' | 'cleanup'>>, projectId: string | null): Promise<CleanupPolicy> {
  const store = deps.cleanup?.sweeps;
  if (!store || !projectId) return DEFAULT_CLEANUP_POLICY;
  const own = await store.policy('project', projectId);
  if (own) return withPolicyDefaults(own);
  const project = deps.projects ? await deps.projects.byId(asProjectId(projectId)) : null;
  const team = project?.teamId ? await store.policy('team', project.teamId) : null;
  return withPolicyDefaults(team ?? DEFAULT_CLEANUP_POLICY);
}

export function normalizePolicy(input: Partial<CleanupPolicy>, base: CleanupPolicy = DEFAULT_CLEANUP_POLICY): Result<CleanupPolicy, DomainError> {
  const idle = input.idleDays === undefined ? base.idleDays : input.idleDays;
  if (idle !== null && (!Number.isInteger(idle) || idle < 1 || idle > IDLE_DAYS_MAX)) return err(invalid(`闲置天数要在 1–${IDLE_DAYS_MAX} 之间`));
  return ok({
    prMerged: input.prMerged ?? base.prMerged,
    taskEndedClean: input.taskEndedClean ?? base.taskEndedClean,
    idleDays: idle,
    deleteWorktreeOnSessionDelete: input.deleteWorktreeOnSessionDelete ?? base.deleteWorktreeOnSessionDelete
  });
}

/** 合并了的 PR（同一工作空间，或同任务同分支）。 */
async function mergedPullRequest(deps: Pick<Deps, 'cleanup'>, workspace: Workspace): Promise<PullRequestLink | null> {
  const prs = deps.cleanup?.pullRequests;
  if (!prs) return null;
  const mine = [
    ...(await prs.byWorkspace(workspace.id)),
    ...(workspace.ownerTaskId ? (await prs.byTask(workspace.ownerTaskId)).filter((pr) => pr.branch === workspace.branch) : [])
  ];
  return mine.find((pr) => pr.state === 'merged') ?? null;
}

async function lastActivity(deps: Pick<Deps, 'sessions'>, workspace: Workspace): Promise<number> {
  const sessions = await deps.sessions.listByWorkspace(workspace.id);
  return Math.max(workspace.updatedAt, ...sessions.map((session) => session.updatedAt));
}

/**
 * squash / rebase 合并：本地提交在远端「看不到」，但 HEAD 就是 PR 最后的 head_sha → 这些提交已经进了默认分支（以 PR 为准）。
 * 未提交 / 未跟踪的照样保护（D7）。
 */
export function protectedReason(status: GitStatus, mergedHead: string | null): string | null {
  const squashed = mergedHead !== null && status.head != null && status.head === mergedHead;
  return unsavedReason(squashed ? { ...status, unpushed: 0 } : status);
}

/**
 * 清理临时工作空间（§5 + ADR 0027 §3）。规则（按项目，可组合）：
 * - 任务 done / abandoned（taskEndedClean，默认开）；
 * - 挂在任务上的 PR 已合并（prMerged，默认开；squash 以 HEAD == PR head_sha 判定）；
 * - 闲置 N 天（idleDays，默认关）。
 * 命中任一条且没有会丢的东西（已跟踪改动 + 未跟踪文件 + 没进别处的提交，D7）才删；只删 checkout，分支 / 检查点 / 会话历史保留，
 * 任务再开始时按分支重建。有会话在跑、机器离线 → 跳过；每次删 / 新保留 / 失败都写进清理记录。
 */
export function sweepTemporaryWorkspacesUseCase(
  deps: CleanupDeps,
  scope: { readonly taskId?: string; readonly projectId?: string; readonly trigger?: string } = {}
): Promise<SweepReport> {
  // 同一个进程里一次只跑一轮：任务结束触发的、每小时的、人点的不会抢着删同一个目录
  const previous = sweeping.get(deps.workspaces) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => sweepOnce(deps, scope));
  sweeping.set(deps.workspaces, next);
  return next;
}
const sweeping = new WeakMap<object, Promise<unknown>>();

async function sweepOnce(
  deps: CleanupDeps,
  scope: { readonly taskId?: string; readonly projectId?: string; readonly trigger?: string }
): Promise<SweepReport> {
  const removed: string[] = [];
  const kept: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const runId = newId();
  const items: SweepItem[] = [];
  const record = (workspace: Workspace, action: SweepItem['action'], reason: string, sizeBytes: number | null | undefined) =>
    items.push({ runId, projectId: workspace.projectId, workspaceId: workspace.id, path: workspace.path, branch: workspace.branch, action, reason, sizeBytes: sizeBytes ?? null, at: deps.now() });
  const candidates = (await deps.workspaces.temporaries()).filter(
    (workspace) =>
      (workspace.state === 'ready' || workspace.state === 'kept') &&
      (!scope.taskId || workspace.ownerTaskId === scope.taskId) &&
      (!scope.projectId || workspace.projectId === scope.projectId)
  );
  const policies = new Map<string, CleanupPolicy>();
  const policyOf = async (workspace: Workspace): Promise<CleanupPolicy> => {
    const key = workspace.projectId ?? '';
    if (!policies.has(key)) policies.set(key, await cleanupPolicyFor(deps, workspace.projectId));
    return policies.get(key) ?? DEFAULT_CLEANUP_POLICY;
  };

  const seenGroups = new Set<string>();
  const solos: Workspace[] = [];
  for (const workspace of candidates) {
    if (workspace.groupId) {
      if (seenGroups.has(workspace.groupId)) continue;
      seenGroups.add(workspace.groupId);
      await sweepGroup(deps, workspace.groupId, { record, removed, kept, skipped, failed, policyOf });
    } else {
      solos.push(workspace);
    }
  }
  for (const workspace of solos) {
    await sweepSolo(deps, workspace, { record, removed, kept, skipped, failed, policyOf });
  }

  const store = deps.cleanup?.sweeps;
  const manual = scope.trigger === 'manual';
  if (store && (items.length > 0 || manual)) {
    await store.saveRun(
      { id: runId, trigger: scope.trigger ?? (scope.taskId ? 'task' : 'hourly'), startedAt: deps.now(), removed: removed.length, kept: items.filter((i) => i.action === 'kept').length, failed: failed.length },
      items
    );
  }
  const run = store && (items.length > 0 || manual) ? runId : null;
  let alreadyRemoved: string[] = [];
  if (scope.projectId && deps.workspaces.byProject) {
    alreadyRemoved = (await deps.workspaces.byProject(asProjectId(scope.projectId)))
      .filter((workspace) => workspace.kind === 'temporary' && workspace.state === 'removed')
      .map((workspace) => workspace.id);
  }
  const empty = removed.length === 0 && kept.length === 0 && skipped.length === 0 && failed.length === 0;
  const message = empty
    ? alreadyRemoved.length > 0
      ? `没有待清理的工作空间。已有 ${alreadyRemoved.length} 个临时 worktree 在收起时拆除。`
      : '没有待清理的工作空间。若刚刚收起过会话，干净的临时 worktree 可能已在收起时拆除。'
    : undefined;
  return { removed, kept, skipped, failed, runId: run, ...(message ? { message } : {}), ...(alreadyRemoved.length ? { alreadyRemoved } : {}) };
}

type SweepSink = {
  readonly record: (workspace: Workspace, action: SweepItem['action'], reason: string, sizeBytes: number | null | undefined) => void;
  readonly removed: string[];
  readonly kept: string[];
  readonly skipped: string[];
  readonly failed: string[];
  readonly policyOf: (workspace: Workspace) => Promise<CleanupPolicy>;
};

async function groupSessions(deps: CleanupDeps, group: WorkspaceGroup): Promise<Session[]> {
  return (await deps.sessions.listByProject(group.projectId)).filter((session) => session.groupId === group.id);
}

async function workspaceSessions(deps: CleanupDeps, workspace: Workspace): Promise<Session[]> {
  return deps.sessions.listByWorkspace(workspace.id);
}

/** 收起本轮刚发生时，这一轮只收起、不拆目录：下一轮清理再删干净的 worktree。 */
async function archiveIfNeeded(deps: CleanupDeps, sessions: readonly Session[], should: boolean): Promise<boolean> {
  if (!should) return false;
  return (await archiveSessionsQuietly(deps, sessions)) > 0;
}

async function triggersOf(
  deps: CleanupDeps,
  policy: CleanupPolicy,
  workspace: Workspace,
  merged: { number: number } | null,
  sessions: readonly Session[]
): Promise<string[]> {
  const task = workspace.ownerTaskId ? await deps.tasks.byId(workspace.ownerTaskId) : null;
  const ended = !task || FINISHED.has(task.status);
  const triggers: string[] = [];
  if (policy.taskEndedClean && ended) triggers.push(task ? `任务已${task.status === 'done' ? '完成' : '放弃'}` : '任务已不存在');
  if (merged) triggers.push(`PR #${merged.number} 已合并`);
  if (policy.idleDays !== null && deps.now() - (await lastActivity(deps, workspace)) > policy.idleDays * DAY_MS) {
    triggers.push(`闲置超过 ${policy.idleDays} 天`);
  }
  if (sessions.length > 0 && sessions.every((session) => session.settledAt != null)) triggers.push('会话已收起');
  return triggers;
}

async function sweepSolo(deps: CleanupDeps, workspace: Workspace, sink: SweepSink): Promise<void> {
  const policy = await sink.policyOf(workspace);
  const sessions = await workspaceSessions(deps, workspace);
  const merged = policy.prMerged ? await mergedPullRequest(deps, workspace) : null;
  // 有仍在活跃列表的会话、且因 PR 合并刚命中：先收起，这一轮不拆目录。
  if (merged && (await archiveIfNeeded(deps, sessions, true))) return;
  const triggers = await triggersOf(deps, policy, workspace, merged, sessions);
  if (triggers.length === 0) return;
  if (await busy(deps, workspace)) {
    sink.skipped.push(workspace.id);
    return;
  }
  const git = await gitFor(deps, workspace.workerId);
  const status = await git.status(workspace.path);
  if (!status.ok) {
    sink.skipped.push(workspace.id);
    return;
  }
  const mergedHead = merged?.headSha ?? null;
  const reason = protectedReason(status.value, mergedHead);
  if (reason) {
    if (workspace.state !== 'kept' || workspace.keptReason !== reason) {
      await deps.workspaces.save(markKept(workspace, reason, deps.now()));
      sink.record(workspace, 'kept', reason, status.value.sizeBytes);
    }
    sink.kept.push(workspace.id);
    return;
  }
  const squashed = mergedHead !== null && status.value.head === mergedHead && status.value.unpushed > 0;
  let fence: string | null;
  try { fence = await fenceWorkspace(deps, workspace); } catch { sink.skipped.push(workspace.id); return; }
  if (deps.cleanup?.dropCheckpoints) {
    for (const session of await deps.sessions.listByWorkspace(workspace.id)) await deps.cleanup.dropCheckpoints(session.id).catch(() => undefined);
  }
  const outcome = await git.remove(workspace.path, removeKind(workspace), squashed && mergedHead ? { mergedHead } : {});
  if (!outcome.ok) {
    await finishSettledFailure(deps, fence, outcome.error);
    sink.failed.push(workspace.id);
    sink.record(workspace, 'failed', outcome.error.message, status.value.sizeBytes);
    return;
  }
  if (outcome.value.removed) {
    const gone = markRemoved(workspace, deps.now());
    if (!gone.ok) { if (deps.workdirSafety) return; }
    else if ((await deps.workspaces.save(gone.value)).status !== 'saved' && deps.workdirSafety) return;
    sink.removed.push(workspace.id);
    sink.record(workspace, 'removed', triggers.join('；'), status.value.sizeBytes);
  } else {
    await deps.workspaces.save(markKept(workspace, outcome.value.reason, deps.now()));
    sink.kept.push(workspace.id);
    sink.record(workspace, 'kept', outcome.value.reason, status.value.sizeBytes);
  }
  await finishFence(deps, fence);
}

/**
 * 组合组整组处理：从不单独拆掉一个成员。
 * 只有每个成员的 PR 已合并（或这个仓库没有改动）、全部干净、且没有会话在跑，才拆整组。
 */
async function sweepGroup(deps: CleanupDeps, groupId: string, sink: SweepSink): Promise<void> {
  const group = deps.workspaceGroups ? await deps.workspaceGroups.byId(groupId as never) : null;
  if (!group) return;
  const members: Workspace[] = [];
  for (const member of group.members) {
    const workspace = await deps.workspaces.byId(member.workspaceId);
    if (workspace && (workspace.state === 'ready' || workspace.state === 'kept')) members.push(workspace);
  }
  if (members.length === 0) return;

  const policy = await sink.policyOf(members[0]!);
  const sessions = await groupSessions(deps, group);
  if (sessions.some((session) => session.status === 'running') || (await Promise.all(members.map((workspace) => busy(deps, workspace)))).some(Boolean)) {
    for (const workspace of members) sink.skipped.push(workspace.id);
    return;
  }

  const rows: { workspace: Workspace; name: string; merged: Awaited<ReturnType<typeof mergedPullRequest>>; status: GitStatus; reason: string | null }[] = [];
  for (const workspace of members) {
    const member = group.members.find((item) => item.workspaceId === workspace.id);
    const git = await gitFor(deps, workspace.workerId);
    const status = await git.status(workspace.path);
    if (!status.ok) {
      for (const item of members) sink.skipped.push(item.id);
      return;
    }
    const merged = policy.prMerged ? await mergedPullRequest(deps, workspace) : null;
    rows.push({
      workspace,
      name: member?.name ?? workspace.path,
      merged,
      status: status.value,
      reason: protectedReason(status.value, merged?.headSha ?? null)
    });
  }

  const allClean = rows.every((row) => row.reason === null);
  const allResolved = await comboReadyToArchive(deps, group);
  if (allResolved && (await archiveIfNeeded(deps, sessions, true))) return;

  const mergedTrigger = allResolved ? '各仓库 PR 已合并或无改动' : null;
  const sample = members[0]!;
  const triggers = await triggersOf(deps, policy, sample, null, sessions);
  if (mergedTrigger) triggers.push(mergedTrigger);
  if (triggers.length === 0) return;

  if (!allClean || !allResolved) {
    const reason =
      rows
        .filter((row) => row.reason)
        .map((row) => `${row.name}：${row.reason}`)
        .join('；') || '还有仓库的改动未合并';
    for (const row of rows) {
      if (row.workspace.state !== 'kept' || row.workspace.keptReason !== reason) {
        await deps.workspaces.save(markKept(row.workspace, reason, deps.now()));
        sink.record(row.workspace, 'kept', reason, row.status.sizeBytes);
      }
      sink.kept.push(row.workspace.id);
    }
    return;
  }

  // 整组拆除：先每个成员 worktree remove，再删容器和组行。
  for (const row of rows) {
    const mergedHead = row.merged?.headSha ?? null;
    const squashed = mergedHead !== null && row.status.head === mergedHead && row.status.unpushed > 0;
    const git = await gitFor(deps, row.workspace.workerId);
    let fence: string | null;
    try { fence = await fenceWorkspace(deps, row.workspace); } catch { sink.skipped.push(row.workspace.id); return; }
    if (deps.cleanup?.dropCheckpoints) {
      for (const session of await deps.sessions.listByWorkspace(row.workspace.id)) {
        await deps.cleanup.dropCheckpoints(session.id).catch(() => undefined);
      }
    }
    const outcome = await git.remove(row.workspace.path, 'worktree', squashed && mergedHead ? { mergedHead } : {});
    if (!outcome.ok) {
      await finishSettledFailure(deps, fence, outcome.error);
      sink.failed.push(row.workspace.id);
      sink.record(row.workspace, 'failed', outcome.error.message, row.status.sizeBytes);
      return;
    }
    if (!outcome.value.removed) {
      const reason = outcome.value.reason;
      await deps.workspaces.save(markKept(row.workspace, reason, deps.now()));
      // 原子性：有一个拆不掉，余下也整组留下
      for (const other of rows) {
        if (other.workspace.id === row.workspace.id) continue;
        if (other.workspace.state !== 'kept' || other.workspace.keptReason !== reason) {
          await deps.workspaces.save(markKept(other.workspace, reason, deps.now()));
          sink.record(other.workspace, 'kept', reason, other.status.sizeBytes);
        }
        sink.kept.push(other.workspace.id);
      }
      sink.kept.push(row.workspace.id);
      sink.record(row.workspace, 'kept', reason, row.status.sizeBytes);
      await finishFence(deps, fence);
      return;
    }
    const gone = markRemoved(row.workspace, deps.now());
    if (!gone.ok) { if (deps.workdirSafety) return; }
    else if ((await deps.workspaces.save(gone.value)).status !== 'saved' && deps.workdirSafety) return;
    await finishFence(deps, fence);
    sink.removed.push(row.workspace.id);
    sink.record(row.workspace, 'removed', triggers.join('；'), row.status.sizeBytes);
  }

  // 有会话还挂着这个组时保留组行和容器：拆掉的是 worktree，重新打开时按原分支加回来。
  const leftover = await groupSessions(deps, group);
  const groupGit = group.workerId ? deps.gateway.groups?.(group.workerId) : undefined;
  if (groupGit && deps.workspaceGroups && leftover.length === 0) {
    let fence: string | null = null;
    if (deps.workdirSafety) {
      try {
        fence = await deps.workdirSafety.runExclusive(async () => {
          const current = await deps.workspaceGroups!.byId(group.id);
          if (!current || current.root !== group.root || current.workerId !== group.workerId || JSON.stringify(current.members) !== JSON.stringify(group.members)) throw new Error('group changed');
          return deps.workdirSafety!.beginRemoval({ workspaceId: group.id, workerId: group.workerId, cwd: group.root });
        });
      } catch { return; }
    }
    const result = await groupGit.remove({ root: group.root, id: group.id }).catch(() => null);
    if (deps.workdirSafety && (!result || !result.ok)) {
      if (result && !result.ok) await finishSettledFailure(deps, fence, result.error);
      return;
    }
    if (deps.workdirSafety && result?.ok && !result.value.removed) { await finishFence(deps, fence); return; }
    await deps.workspaceGroups.remove(group.id);
    await finishFence(deps, fence);
  }
}

/** 删之前给人看的：会丢什么（「强制删除」的二次确认里列出来）。 */
export async function workspaceChangesUseCase(
  deps: Pick<Deps, 'git' | 'gateway' | 'workspaces'> & Partial<Pick<Deps, 'workspaceGroups'>>,
  workspaceId: string,
  member?: string
): Promise<Result<{ readonly status: GitStatus; readonly reason: string | null }, DomainError>> {
  const workspace = await deps.workspaces.byId(asWorkspaceId(workspaceId));
  if (!workspace || workspace.state === 'removed') return err(notFound('工作空间不存在'));
  let path = workspace.path;
  // 组合工作空间：容器根不是 git 仓库，按成员仓库查（§12.5）。
  if (workspace.groupId) {
    if (!member) return err(invalid('请选择要查看改动的仓库'));
    const group = deps.workspaceGroups ? await deps.workspaceGroups.byId(workspace.groupId) : null;
    const target = group?.members.find((item) => item.workspaceId === member) ?? null;
    if (!group || !target) return err(invalid('这颗仓库不属于这个组合工作空间'));
    const root = groupMemberRoot(group, target.workspaceId);
    if (root === null) return err(invalid('这颗仓库还没有准备好'));
    path = root;
  }
  const status = await (await gitFor(deps, workspace.workerId)).status(path);
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
  command: RemoveWorkspaceCommand,
  validateOwner?: (workspace: Workspace) => Promise<boolean>
): Promise<Result<Workspace, DomainError>> {
  if (deps.workdirSafety && !command.deleteDirectory) {
    const initial = await deps.workspaces.byId(asWorkspaceId(command.workspaceId));
    if (!initial || initial.state === 'removed') return err(notFound('工作空间不存在'));
    if (await busy(deps, initial)) return err(conflict('有会话正在这个工作空间里运行，先停掉它'));
    const result = await deps.workdirSafety.runExclusive(async () => {
      const current = await deps.workspaces.byId(asWorkspaceId(command.workspaceId));
      if (current) {
        try { deps.workdirSafety!.assertUnoccupied(workdirTarget(current)); }
        catch { return err(conflict('工作目录有终端或待确认的删除')); }
        if (validateOwner && !(await validateOwner(current))) return err(conflict('工作空间归属或权限已变，请刷新后重试'));
      }
      return removeWorkspaceUseCase({ ...deps, workdirSafety: undefined, cleanup: deps.cleanup ? { ...deps.cleanup, dropCheckpoints: undefined } : undefined }, command);
    });
    if (result.ok) await dropCheckpoints(deps, initial);
    return result;
  }
  const workspace = await deps.workspaces.byId(asWorkspaceId(command.workspaceId));
  if (!workspace || workspace.state === 'removed') return err(notFound('工作空间不存在'));
  if (await busy(deps, workspace)) return err(conflict('有会话正在这个工作空间里运行，先停掉它'));
  if (command.deleteDirectory) {
    if (!platformOwnsDirectory(workspace)) return err(invalid('这是你自己选的目录，平台不会删它；只能移除登记'));
    if (workspace.kind === 'long_lived') {
      const children = (await deps.workspaces.temporaries()).filter((other) => other.baseWorkspaceId === workspace.id);
      if (children.length > 0) return err(conflict(`还有 ${children.length} 个临时工作空间是从它开出来的，先处理它们`));
    }
    const git = await gitFor(deps, workspace.workerId);
    if (command.force !== true) {
      // 先看一眼会不会被拒：被拒就别把检查点删了
      const status = await git.status(workspace.path);
      const reason = status.ok ? unsavedReason(status.value) : null;
      if (reason) {
        if (workspace.kind === 'temporary') await deps.workspaces.save(markKept(workspace, reason, deps.now()));
        return err(conflict(`没有删：${reason}`));
      }
    }
    let fence: string | null;
    try { fence = await fenceWorkspace(deps, workspace, validateOwner); } catch { return err(conflict('工作目录有终端、待确认的删除或归属已变')); }
    await dropCheckpoints(deps, workspace);
    const outcome = await git.remove(workspace.path, removeKind(workspace), { force: command.force === true });
    if (!outcome.ok) { await finishSettledFailure(deps, fence, outcome.error); return outcome; }
    if (!outcome.value.removed) {
      const keptOne = workspace.kind === 'temporary' ? markKept(workspace, outcome.value.reason, deps.now()) : workspace;
      if (keptOne !== workspace) await deps.workspaces.save(keptOne);
      await finishFence(deps, fence);
      return err(conflict(`没有删：${outcome.value.reason}`));
    }
    const gone = markRemoved(workspace, deps.now());
    if (!gone.ok) return gone;
    const saved = await deps.workspaces.save(gone.value);
    if (saved.status !== 'saved' && deps.workdirSafety) return err(conflict('目录已删除但登记未能更新，删除待确认'));
    await finishFence(deps, fence);
    return ok(gone.value);
  } else {
    await dropCheckpoints(deps, workspace);
  }
  const gone = markRemoved(workspace, deps.now());
  if (!gone.ok) return gone;
  await deps.workspaces.save(gone.value);
  return ok(gone.value);
}

/** 人删的工作空间（不是自动清理）：它会话的检查点 ref 一起删（ADR 0027 §3）；自动清理只删 checkout，检查点留着。 */
async function dropCheckpoints(deps: CleanupDeps, workspace: Workspace): Promise<void> {
  const drop = deps.cleanup?.dropCheckpoints;
  if (!drop) return;
  for (const session of await deps.sessions.listByWorkspace(workspace.id)) await drop(session.id).catch(() => undefined);
}
