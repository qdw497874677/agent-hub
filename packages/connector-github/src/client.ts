import type { GhIssueEvent, Reaction } from './rules.ts';

/** 连接器用到的 GitHub REST 子集。测试注入假的；生产用 createGithubClient。 */
export interface GhIssue { readonly number: number; readonly title: string; readonly body: string | null; readonly html_url: string; readonly pull_request?: unknown; readonly user?: { readonly login: string } | null }
export interface GhComment { readonly id: number; readonly body: string; readonly html_url: string; readonly issue_url: string; readonly created_at: string; readonly user?: { readonly login: string } | null }

export interface GithubClient {
  viewer(token: string): Promise<string>;
  labeledIssues(token: string, repo: string, label: string): Promise<GhIssue[]>;
  issueEvents(token: string, repo: string, n: number): Promise<GhIssueEvent[]>;
  permission(token: string, repo: string, login: string): Promise<string | null>;
  commentsSince(token: string, repo: string, sinceIso: string): Promise<GhComment[]>;
  pullState(token: string, repo: string, n: number): Promise<'open' | 'closed' | 'merged'>;
  comment(token: string, repo: string, n: number, body: string): Promise<{ id: number; url: string }>;
  react(token: string, repo: string, n: number, content: Reaction): Promise<void>;
  reactComment(token: string, repo: string, commentId: number, content: Reaction): Promise<void>;
}

export class GithubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** base 默认 https://api.github.com（HUB_GITHUB_API 可改，e2e 用假服务）。错误里绝不带 token。 */
export function createGithubClient(options: { base?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): GithubClient {
  const base = (options.base ?? 'https://api.github.com').replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const call = async <T>(token: string, method: string, path: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', 'user-agent': 'agent-hub' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
      });
    } catch (e) {
      throw new GithubError(0, `连不上 GitHub：${e instanceof Error ? e.message : String(e)}`.slice(0, 200).replaceAll(token, '***'));
    }
    const text = await response.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!response.ok) {
      const msg = json && typeof (json as { message?: unknown }).message === 'string' ? (json as { message: string }).message : '';
      throw new GithubError(response.status, `GitHub ${response.status}${msg ? `：${msg}` : ''}`.slice(0, 300).replaceAll(token, '***'));
    }
    return json as T;
  };
  const enc = (repo: string) => repo.split('/').map(encodeURIComponent).join('/');
  return {
    viewer: async (t) => (await call<{ login: string }>(t, 'GET', '/user')).login,
    labeledIssues: async (t, repo, label) =>
      (await call<GhIssue[]>(t, 'GET', `/repos/${enc(repo)}/issues?state=open&labels=${encodeURIComponent(label)}&sort=created&direction=asc&per_page=30`)).filter((i) => !i.pull_request),
    issueEvents: (t, repo, n) => call<GhIssueEvent[]>(t, 'GET', `/repos/${enc(repo)}/issues/${n}/events?per_page=100`),
    permission: async (t, repo, login) => {
      try { return (await call<{ permission?: string }>(t, 'GET', `/repos/${enc(repo)}/collaborators/${encodeURIComponent(login)}/permission`)).permission ?? null; }
      catch (e) { if (e instanceof GithubError && (e.status === 404 || e.status === 403)) return null; throw e; }
    },
    commentsSince: (t, repo, since) => call<GhComment[]>(t, 'GET', `/repos/${enc(repo)}/issues/comments?since=${encodeURIComponent(since)}&sort=created&direction=asc&per_page=50`),
    pullState: async (t, repo, n) => {
      const p = await call<{ state: string; merged_at?: string | null }>(t, 'GET', `/repos/${enc(repo)}/pulls/${n}`);
      return p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open';
    },
    comment: async (t, repo, n, body) => {
      const c = await call<{ id: number; html_url: string }>(t, 'POST', `/repos/${enc(repo)}/issues/${n}/comments`, { body });
      return { id: c.id, url: c.html_url };
    },
    react: async (t, repo, n, content) => { await call(t, 'POST', `/repos/${enc(repo)}/issues/${n}/reactions`, { content }); },
    reactComment: async (t, repo, id, content) => { await call(t, 'POST', `/repos/${enc(repo)}/issues/comments/${id}/reactions`, { content }); }
  };
}
