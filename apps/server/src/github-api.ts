import type { GitHostApi, RemotePullRequest } from '@agent-hub/domain';

/**
 * GitHub REST（ADR 0027 D3 的 token 路径）。base 默认 https://api.github.com，HUB_GITHUB_API 可改（e2e 用假服务）。
 * 报错只带状态码和 GitHub 的 message，绝不回显 token。
 */
export function createGitHubApi(options: { base?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): GitHostApi {
  const base = (options.base ?? 'https://api.github.com').replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const request = async (token: string, method: string, path: string, body?: unknown): Promise<{ ok: true; json: unknown } | { ok: false; reason: string }> => {
    try {
      const response = await doFetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', 'user-agent': 'agent-hub' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
      });
      const text = await response.text();
      const json = (() => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return {};
        }
      })();
      if (!response.ok) {
        const object = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
        const message = typeof object['message'] === 'string' ? object['message'] : '';
        const detail = Array.isArray(object['errors']) ? (object['errors'] as { message?: string }[]).map((e) => e.message ?? '').filter(Boolean).join('；') : '';
        return { ok: false, reason: `GitHub ${response.status}${message ? `：${message}` : ''}${detail ? `（${detail}）` : ''}`.slice(0, 300).replaceAll(token, '***') };
      }
      return { ok: true, json };
    } catch (error) {
      return { ok: false, reason: `连不上 GitHub：${error instanceof Error ? error.message : String(error)}`.slice(0, 200) };
    }
  };
  const call = async (token: string, method: string, path: string, body?: unknown): Promise<{ ok: true; pr: RemotePullRequest } | { ok: false; reason: string }> => {
    const result = await request(token, method, path, body);
    return result.ok ? { ok: true, pr: toPr(result.json as Record<string, unknown>) } : result;
  };
  return {
    createPullRequest: ({ token, repo, base: into, head, title, body }) => call(token, 'POST', `/repos/${repo}/pulls`, { title, body, head, base: into }),
    getPullRequest: ({ token, repo, number }) => call(token, 'GET', `/repos/${repo}/pulls/${number}`),
    listPullRequestsByHead: async ({ token, repo, head }) => {
      const owner = repo.split('/')[0] ?? '';
      const result = await request(token, 'GET', `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=all&sort=created&direction=desc&per_page=20`);
      if (!result.ok) return result;
      const items = Array.isArray(result.json) ? (result.json as Record<string, unknown>[]) : [];
      return { ok: true, prs: items.map(toPr) };
    }
  };
}

function toPr(json: Record<string, unknown>): RemotePullRequest {
  const merged = typeof json['merged_at'] === 'string' ? Date.parse(json['merged_at']) : null;
  const head = json['head'] as { sha?: string } | undefined;
  const base = json['base'] as { ref?: string } | undefined;
  return {
    number: Number(json['number']),
    url: String(json['html_url'] ?? ''),
    state: merged ? 'merged' : json['state'] === 'closed' ? 'closed' : 'open',
    headSha: head?.sha ?? null,
    mergedAt: merged,
    base: typeof base?.ref === 'string' && base.ref ? base.ref : null
  };
}
