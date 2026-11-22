import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubApi } from './github-api.ts';

test('draft PR sends the branch and preserves the returned commit and repository identities', async () => {
  const sha = 'a'.repeat(40);
  const api = createGitHubApi({ fetch: async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/team/repo/pulls');
    assert.equal(options?.method, 'POST');
    assert.deepEqual(JSON.parse(String(options?.body)), { title: 'Change', body: 'Summary', head: 'agent-hub/work', base: 'stable', draft: true });
    return Response.json({ number: 12, html_url: 'https://github.com/team/repo/pull/12', state: 'open', draft: true,
      head: { sha, ref: 'agent-hub/work', repo: { full_name: 'team/repo' } }, base: { ref: 'stable', repo: { full_name: 'team/repo' } } });
  } });
  assert.deepEqual(await api.createPullRequest({ token: 'test', repo: 'team/repo', base: 'stable', head: 'agent-hub/work', title: 'Change', body: 'Summary', draft: true }), {
    ok: true, pr: { number: 12, url: 'https://github.com/team/repo/pull/12', state: 'open', headSha: sha, mergedAt: null,
      base: 'stable', baseRepo: 'team/repo', draft: true, repo: 'team/repo', headRef: 'agent-hub/work' }
  });
});
