import type { RemotePullRequest } from './workspace-git.ts';

/** 挂在任务上的 PR（ADR 0027 §2，表 task_pull_requests）。 */
export interface PullRequestLink {
  readonly id: string;
  readonly taskId: string;
  readonly workspaceId: string | null;
  readonly sessionId: string | null;
  /** 'github'；建它用的是 hub token 还是 Worker 的 gh。 */
  readonly provider: 'github';
  readonly via: 'token' | 'gh';
  /** owner/name */
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly branch: string;
  readonly base: string;
  readonly state: RemotePullRequest['state'];
  readonly headSha: string | null;
  readonly mergedAt: number | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly lastSyncedAt: number;
}

export interface PullRequestRepository {
  save(link: PullRequestLink): Promise<void>;
  byTask(taskId: string): Promise<readonly PullRequestLink[]>;
  byWorkspace(workspaceId: string): Promise<readonly PullRequestLink[]>;
  /** 还开着、上次同步早于 before 的（同步巡检用）。 */
  openSyncedBefore(before: number, limit: number): Promise<readonly PullRequestLink[]>;
}

/** 团队级代码托管 token（ADR 0027 D3）：加密落盘，只回「有没有 / 末 4 位」。 */
export interface GitHostTokenStore {
  status(teamId: string): Promise<{ readonly configured: boolean; readonly last4: string | null; readonly updatedAt: number | null }>;
  put(teamId: string, token: string, at: number): Promise<void>;
  remove(teamId: string): Promise<boolean>;
  /** 明文只给 hub 调 GitHub API 那一刻用。 */
  reveal(teamId: string): Promise<string | null>;
}

/** hub 直调托管平台 REST（token 路径）。 */
export interface GitHostApi {
  createPullRequest(input: { readonly token: string; readonly repo: string; readonly base: string; readonly head: string; readonly title: string; readonly body: string }): Promise<{ ok: true; pr: RemotePullRequest } | { ok: false; reason: string }>;
  getPullRequest(input: { readonly token: string; readonly repo: string; readonly number: number }): Promise<{ ok: true; pr: RemotePullRequest } | { ok: false; reason: string }>;
}

/** 写提交说明 / PR 标题和描述 / 分支名（ADR 0027 D4）：项目提炼模型，失败 = null（调用方用模板）。 */
export interface GitTextInput {
  readonly projectId: string;
  readonly taskTitle: string;
  readonly files: readonly { readonly path: string; readonly status: string }[];
  readonly patch: string;
  readonly workLog: string;
}
export interface GitText {
  readonly message: string;
  readonly title: string;
  readonly body: string;
  readonly branch: string | null;
}
export interface GitTextWriter {
  write(input: GitTextInput): Promise<GitText | null>;
}
