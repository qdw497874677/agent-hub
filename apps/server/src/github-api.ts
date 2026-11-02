import type { GitHostApi, RemotePullRequest } from '@agent-hub/domain';

/**
 * GitHub REST（ADR 0027 D3 的 token 路径）。base 默认 https://api.github.com，HUB_GITHUB_API 可改（e2e 用假服务）。
 * 报错只带状态码和 GitHub 的 message，绝不回显 token。
 */
export function createGitHubApi(options: { base?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): GitHostApi {
  const base = (options.base ?? 'https://api.github.com').replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const call = async (token: string, method: string, path: string, body?: unknown): Promise<{ ok: true; pr: RemotePullRequest } | { ok: false; reason: string }> => {
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
          return JSON.parse(text) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      if (!response.ok) {
        const message = typeof json['message'] === 'string' ? json['message'] : '';
        const detail = Array.isArray(json['errors']) ? (json['errors'] as { message?: string }[]).map((e) => e.message ?? '').filter(Boolean).join('；') : '';
        return { ok: false, reason: `GitHub ${response.status}${message ? `：${message}` : ''}${detail ? `（${detail}）` : ''}`.slice(0, 300).replaceAll(token, '***') };
      }
      return { ok: true, pr: toPr(json) };
    } catch (error) {
      return { ok: false, reason: `连不上 GitHub：${error instanceof Error ? error.message : String(error)}`.slice(0, 200) };
    }
  };
  return {
    createPullRequest: ({ token, repo, base: into, head, title, body }) => call(token, 'POST', `/repos/${repo}/pulls`, { title, body, head, base: into }),
    getPullRequest: ({ token, repo, number }) => call(token, 'GET', `/repos/${repo}/pulls/${number}`)
  };
}

function toPr(json: Record<string, unknown>): RemotePullRequest {
  const merged = typeof json['merged_at'] === 'string' ? Date.parse(json['merged_at']) : null;
  const head = json['head'] as { sha?: string } | undefined;
  return {
    number: Number(json['number']),
    url: String(json['html_url'] ?? ''),
    state: merged ? 'merged' : json['state'] === 'closed' ? 'closed' : 'open',
    headSha: head?.sha ?? null,
    mergedAt: merged
  };
}
