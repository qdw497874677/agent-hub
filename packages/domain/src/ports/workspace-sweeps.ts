/**
 * 临时工作空间清理规则与清理记录（ADR 0027 §3，D6/D7）。
 * 规则按项目设置，没设过用团队默认，团队也没设用 DEFAULT_CLEANUP_POLICY。
 */
export interface CleanupPolicy {
  /** PR 已合并（含 squash：HEAD == PR 最后的 head_sha）就清理。默认开。 */
  readonly prMerged: boolean;
  /** 任务 done / abandoned 且干净就清理（原规则）。默认开。 */
  readonly taskEndedClean: boolean;
  /** 闲置 N 天（最近一次会话活动超过 N 天、没在跑）就清理；null = 关。默认关。 */
  readonly idleDays: number | null;
}

export const DEFAULT_CLEANUP_POLICY: CleanupPolicy = { prMerged: true, taskEndedClean: true, idleDays: null };
export const IDLE_DAYS_MAX = 365;

export type SweepAction = 'removed' | 'kept' | 'failed';

export interface SweepItem {
  readonly runId: string;
  readonly projectId: string | null;
  readonly workspaceId: string;
  readonly path: string;
  readonly branch: string | null;
  readonly action: SweepAction;
  /** removed：因为哪条规则删的；kept：为什么没删（会丢什么）；failed：错误。 */
  readonly reason: string;
  readonly sizeBytes: number | null;
  readonly at: number;
}

export interface SweepRun {
  readonly id: string;
  /** 'hourly' | 'startup' | 'task' | 'manual' */
  readonly trigger: string;
  readonly startedAt: number;
  readonly removed: number;
  readonly kept: number;
  readonly failed: number;
}

export interface WorkspaceSweepStore {
  policy(scope: 'project' | 'team', id: string): Promise<CleanupPolicy | null>;
  savePolicy(scope: 'project' | 'team', id: string, policy: CleanupPolicy, at: number): Promise<void>;
  saveRun(run: SweepRun, items: readonly SweepItem[]): Promise<void>;
  /** 这个项目最近的记录（新的在前）。 */
  itemsOfProject(projectId: string, limit: number): Promise<readonly SweepItem[]>;
}
