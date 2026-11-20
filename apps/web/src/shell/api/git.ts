import { call, post, sq, withMember } from './http.ts';

/** 提交 / 推送 / PR（ADR 0027 阶段 2）。 */
export interface PullRequestDto { id: string; taskId: string; sessionId: string | null; via: 'token' | 'gh'; repo: string; number: number; url: string; branch: string; base: string; state: 'open' | 'closed' | 'merged'; mergedAt: number | null; createdAt: number; lastSyncedAt: number }
export interface GitStateDto {
  isGit: boolean; branch: string | null; defaultBranch: string | null; hasOrigin: boolean; repo: string | null;
  files: { path: string; status: string }[]; ahead: number; upstream: string | null;
  canPush: boolean; prBlocked: string | null; prVia: 'token' | 'gh'; pullRequests: PullRequestDto[];
  sizeBytes?: number | null;
}
export interface GitTextDto { message: string; title: string; body: string; branch: string | null; source: 'model' | 'template' }
export interface GitRunDto { sha: string | null; committed: boolean; pushed: boolean; branch: string | null; pullRequest: PullRequestDto | null; compareUrl: string | null; notes: string[] }
export interface GitHostTokenDto { configured: boolean; last4: string | null; updatedAt: number | null }
export const gitApi = {
  state: (id: string, member?: string | null) => call<GitStateDto>(withMember(`${sq(id)}/git/state`, member)),
  draft: (id: string, member?: string | null) => post<GitTextDto>(withMember(`${sq(id)}/git/draft`, member), {}),
  run: (id: string, body: { action: 'commit' | 'push' | 'pr'; message: string; title?: string; body?: string }, member?: string | null) => post<GitRunDto>(withMember(`${sq(id)}/git/run`, member), body),
  taskPullRequests: (taskId: string) => call<{ pullRequests: PullRequestDto[] }>(`/api/tasks/${encodeURIComponent(taskId)}/pull-requests`).then((r) => r.pullRequests),
  token: () => call<GitHostTokenDto>('/api/git-host/token'),
  setToken: (token: string) => call<GitHostTokenDto>('/api/git-host/token', { method: 'PUT', body: JSON.stringify({ token }) }),
  removeToken: () => call<GitHostTokenDto>('/api/git-host/token', { method: 'DELETE' })
};
