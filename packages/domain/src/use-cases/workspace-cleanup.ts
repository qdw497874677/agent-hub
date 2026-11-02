import { markKept, markRemoved, platformOwnsDirectory, type Workspace } from '../workspace.ts';
import type { GitStatus } from '../ports/workspace-git.ts';
import { asProjectId, asWorkspaceId, newId } from '../ids.ts';
import { DEFAULT_CLEANUP_POLICY, IDLE_DAYS_MAX, type CleanupPolicy, type SweepItem } from '../ports/workspace-sweeps.ts';
import type { PullRequestLink } from '../ports/pull-requests.ts';
import type { DomainError } from '../errors.ts';
import { conflict, invalid, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';
import { gitFor } from './machine-dirs.ts';

type CleanupDeps = Pick<Deps, 'git' | 'gateway' | 'now' | 'sessions' | 'tasks' | 'workspaces'> & Partial<Pick<Deps, 'projects' | 'cleanup'>>;

/** 删了会丢什么，说人话；都没有返回 null（§5 第 3 条）。 */
export function unsavedReason(status: GitStatus): string | null {
  const parts: string[] = [];
  if (status.dirty) parts.push('有未提交的改动');
  if (status.untracked > 0) parts.push(`有 ${status.untracked} 个未跟踪的文件`);
  if (status.unpushed > 0) parts.push(`有 ${status.unpushed} 个提交还没推送或合并`);
  return parts.length > 0 ? parts.join('，') : null;
}

const FINISHED = new Set(['done', 'abandoned']);
const DAY_MS = 24 * 60 * 60 * 1000;

async function busy(deps: Pick<Deps, 'sessions'>, workspace: Workspace): Promise<boolean> {
  // ADR 0026：长期工作空间被多个项目共用，所有项目的会话都算
  return (await deps.sessions.listByWorkspace(workspace.id)).some((session) => session.status === 'running');
}

const removeKind = (workspace: Workspace) => (workspace.source === 'worktree' ? 'worktree' : 'directory');

export interface SweepReport {
  readonly removed: readonly string[];
  readonly kept: readonly string[];
  /** 有会话在跑、机器离线……下次再查。 */
  readonly skipped: readonly string[];
  readonly failed?: readonly string[];
  readonly runId?: string | null;
}

/** 项目规则 → 团队默认 → 内置默认（D6）。 */
export async function cleanupPolicyFor(deps: Partial<Pick<Deps, 'projects' | 'cleanup'>>, projectId: string | null): Promise<CleanupPolicy> {
  const store = deps.cleanup?.sweeps;
  if (!store || !projectId) return DEFAULT_CLEANUP_POLICY;
  const own = await store.policy('project', projectId);
  if (own) return own;
  const project = deps.projects ? await deps.projects.byId(asProjectId(projectId)) : null;
  const team = project?.teamId ? await store.policy('team', project.teamId) : null;
  return team ?? DEFAULT_CLEANUP_POLICY;
}

export function normalizePolicy(input: Partial<CleanupPolicy>, base: CleanupPolicy = DEFAULT_CLEANUP_POLICY): Result<CleanupPolicy, DomainError> {
  const idle = input.idleDays === undefined ? base.idleDays : input.idleDays;
  if (idle !== null && (!Number.isInteger(idle) || idle < 1 || idle > IDLE_DAYS_MAX)) return err(invalid(`闲置天数要在 1–${IDLE_DAYS_MAX} 之间`));
  return ok({ prMerged: input.prMerged ?? base.prMerged, taskEndedClean: input.taskEndedClean ?? base.taskEndedClean, idleDays: idle });
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
  for (const workspace of candidates) {
    const key = workspace.projectId ?? '';
    if (!policies.has(key)) policies.set(key, await cleanupPolicyFor(deps, workspace.projectId));
    const policy = policies.get(key) ?? DEFAULT_CLEANUP_POLICY;
    const task = workspace.ownerTaskId ? await deps.tasks.byId(workspace.ownerTaskId) : null;
    const ended = !task || FINISHED.has(task.status);
    const merged = policy.prMerged ? await mergedPullRequest(deps, workspace) : null;
    const triggers: string[] = [];
    if (policy.taskEndedClean && ended) triggers.push(task ? `任务已${task.status === 'done' ? '完成' : '放弃'}` : '任务已不存在');
    if (merged) triggers.push(`PR #${merged.number} 已合并`);
    if (policy.idleDays !== null && deps.now() - (await lastActivity(deps, workspace)) > policy.idleDays * DAY_MS) triggers.push(`闲置超过 ${policy.idleDays} 天`);
    if (triggers.length === 0) continue; // 任务还在做（或被重新打开）：继续用
    if (await busy(deps, workspace)) {
      skipped.push(workspace.id);
      continue;
    }
    const git = await gitFor(deps, workspace.workerId);
    const status = await git.status(workspace.path);
    if (!status.ok) {
      skipped.push(workspace.id); // 多半是机器离线：上线后再查
      continue;
    }
    const mergedHead = merged?.headSha ?? null;
    const reason = protectedReason(status.value, mergedHead);
    if (reason) {
      if (workspace.state !== 'kept' || workspace.keptReason !== reason) {
        await deps.workspaces.save(markKept(workspace, reason, deps.now()));
        record(workspace, 'kept', reason, status.value.sizeBytes);
      }
      kept.push(workspace.id);
      continue;
    }
    // Worker 那边删之前还会再查一次（hub 以为干净但其实不干净时以它为准）
    const squashed = mergedHead !== null && status.value.head === mergedHead && status.value.unpushed > 0;
    // 检查点 ref 在仓库公共目录里，目录删了就够不着了：先删（D1，删工作空间时一起删）
    if (deps.cleanup?.dropCheckpoints) {
      for (const session of await deps.sessions.listByWorkspace(workspace.id)) await deps.cleanup.dropCheckpoints(session.id).catch(() => undefined);
    }
    const outcome = await git.remove(workspace.path, removeKind(workspace), squashed && mergedHead ? { mergedHead } : {});
    if (!outcome.ok) {
      failed.push(workspace.id);
      record(workspace, 'failed', outcome.error.message, status.value.sizeBytes);
      continue;
    }
    if (outcome.value.removed) {
      const gone = markRemoved(workspace, deps.now());
      if (gone.ok) await deps.workspaces.save(gone.value);
      removed.push(workspace.id);
      record(workspace, 'removed', triggers.join('；'), status.value.sizeBytes);
    } else {
      await deps.workspaces.save(markKept(workspace, outcome.value.reason, deps.now()));
      kept.push(workspace.id);
      record(workspace, 'kept', outcome.value.reason, status.value.sizeBytes);
    }
  }
  const store = deps.cleanup?.sweeps;
  const manual = scope.trigger === 'manual';
  if (store && (items.length > 0 || manual)) {
    await store.saveRun(
      { id: runId, trigger: scope.trigger ?? (scope.taskId ? 'task' : 'hourly'), startedAt: deps.now(), removed: removed.length, kept: items.filter((i) => i.action === 'kept').length, failed: failed.length },
      items
    );
  }
  return { removed, kept, skipped, failed, runId: store && (items.length > 0 || manual) ? runId : null };
}

/** 删之前给人看的：会丢什么（「强制删除」的二次确认里列出来）。 */
export async function workspaceChangesUseCase(
  deps: Pick<Deps, 'git' | 'gateway' | 'workspaces'>,
  workspaceId: string
): Promise<Result<{ readonly status: GitStatus; readonly reason: string | null }, DomainError>> {
  const workspace = await deps.workspaces.byId(asWorkspaceId(workspaceId));
  if (!workspace || workspace.state === 'removed') return err(notFound('工作空间不存在'));
  const status = await (await gitFor(deps, workspace.workerId)).status(workspace.path);
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
    await dropCheckpoints(deps, workspace);
    const outcome = await git.remove(workspace.path, removeKind(workspace), { force: command.force === true });
    if (!outcome.ok) return outcome;
    if (!outcome.value.removed) {
      const keptOne = workspace.kind === 'temporary' ? markKept(workspace, outcome.value.reason, deps.now()) : workspace;
      if (keptOne !== workspace) await deps.workspaces.save(keptOne);
      return err(conflict(`没有删：${outcome.value.reason}`));
    }
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
