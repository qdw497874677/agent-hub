import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelProvider } from '@agent-hub/domain';
import { createGitHubApi } from './github-api.ts';
import { createGitTextWriter } from './git-text-writer.ts';

const TOKEN = 'ghp_supersecrettoken000000001234';

test('GitHub REST：开 PR 带 token 头；合并状态；报错不回显 token', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = createGitHubApi({
    base: 'https://gh.example/',
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.method === 'POST') return Response.json({ number: 12, html_url: 'https://github.com/o/r/pull/12', state: 'open', head: { sha: 'abc', ref: 'feat/x', repo: { full_name: 'o/r' } }, merged_at: null }, { status: 201 });
      if (url.endsWith('/13')) return Response.json({ message: `Bad credentials ${TOKEN}` }, { status: 401 });
      return Response.json({ number: 12, html_url: 'https://github.com/o/r/pull/12', state: 'closed', head: { sha: 'def', ref: 'feat/x', repo: { full_name: 'o/r' } }, merged_at: '2026-11-01T00:00:00Z' });
    }) as typeof fetch
  });
  const created = await api.createPullRequest({ token: TOKEN, repo: 'o/r', base: 'main', head: 'feat/x', title: 'T', body: 'B' });
  assert.deepEqual(created, { ok: true, pr: { number: 12, url: 'https://github.com/o/r/pull/12', state: 'open', headSha: 'abc', mergedAt: null, base: null, repo: 'o/r', headRef: 'feat/x' } });
  assert.equal(calls[0]!.url, 'https://gh.example/repos/o/r/pulls');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['authorization'], `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { title: 'T', body: 'B', head: 'feat/x', base: 'main' });
  const got = await api.getPullRequest({ token: TOKEN, repo: 'o/r', number: 12 });
  assert.ok(got.ok && got.pr.state === 'merged' && got.pr.mergedAt === Date.parse('2026-11-01T00:00:00Z'));
  const bad = await api.getPullRequest({ token: TOKEN, repo: 'o/r', number: 13 });
  assert.ok(!bad.ok);
  assert.match(bad.reason, /401/);
  assert.ok(!bad.reason.includes(TOKEN));
});

test('GitHub REST：按分支列 PR（认领没走会话开的，#262）', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = createGitHubApi({
    base: 'https://gh.example',
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json([
        { number: 21, html_url: 'https://github.com/o/r/pull/21', state: 'open', head: { sha: 'h1', ref: 'feat/x', repo: { full_name: 'o/r' } }, merged_at: null, base: { ref: 'main' } },
        { number: 9, html_url: 'https://github.com/o/r/pull/9', state: 'closed', head: { sha: 'h0', ref: 'feat/x', repo: { full_name: 'someone/r' } }, merged_at: '2026-11-02T00:00:00Z' },
        // 老响应 / 缺头信息：repo 与 headRef 只能是 null，域层会拒绝自动认领
        { number: 30, html_url: 'https://github.com/o/r/pull/30', state: 'open', head: { sha: 'h9' }, merged_at: null, base: { ref: 'main' } }
      ]);
    }) as typeof fetch
  });
  const listed = await api.listPullRequestsByHead({ token: TOKEN, repo: 'o/r', head: 'feat/x' });
  assert.deepEqual(listed, {
    ok: true,
    prs: [
      { number: 21, url: 'https://github.com/o/r/pull/21', state: 'open', headSha: 'h1', mergedAt: null, base: 'main', repo: 'o/r', headRef: 'feat/x' },
      { number: 9, url: 'https://github.com/o/r/pull/9', state: 'merged', headSha: 'h0', mergedAt: Date.parse('2026-11-02T00:00:00Z'), base: null, repo: 'someone/r', headRef: 'feat/x' },
      { number: 30, url: 'https://github.com/o/r/pull/30', state: 'open', headSha: 'h9', mergedAt: null, base: 'main', repo: null, headRef: null }
    ]
  });
  assert.equal(calls[0]!.url, `https://gh.example/repos/o/r/pulls?head=${encodeURIComponent('o:feat/x')}&state=open&sort=created&direction=desc&per_page=20`);
  assert.equal((calls[0]!.init.headers as Record<string, string>)['authorization'], `Bearer ${TOKEN}`);
});

const provider: ModelProvider = {
  id: 'p1', scope: 'hub', ownerId: null, slug: 'acme', name: 'Acme', protocol: 'openai-chat', baseUrl: 'https://llm.example/v1',
  models: [{ id: 'm1' }], routing: 'direct', enabled: true, hasKey: true, lastCheck: null, createdBy: 'u', createdAt: 0, updatedAt: 0
};

function writer(opts: { model?: string | null; reply?: string }) {
  const calls: { url: string; body: string }[] = [];
  const audits: { action: string; detail: string }[] = [];
  const w = createGitTextWriter({
    settings: { distillModel: async () => (opts.model === undefined ? 'hub-acme/m1' : opts.model) },
    providers: { bySlug: async () => provider, revealKey: async () => 'sk-x', addUsage: async () => undefined },
    projectTeam: async () => null,
    audit: { append: async (e) => void audits.push(e as never) },
    now: () => 1,
    log: () => undefined,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return Response.json({ choices: [{ message: { content: opts.reply ?? '' } }] });
    }) as typeof fetch
  });
  return { w, calls, audits };
}
const input = { projectId: 'p', taskTitle: '修登录', files: [{ path: 'a.ts', status: 'M' }], patch: 'diff --git a/a.ts', workLog: '' };

test('提交文案：模型给 JSON 就用；没配模型 null；diff 里有密钥不发出去', async () => {
  const good = writer({ reply: JSON.stringify({ message: 'fix: 登录跳转', title: '修登录跳转', body: '改了 a.ts', branch: 'fix/login-redirect' }) });
  const out = await good.w.write(input);
  assert.deepEqual(out, { message: 'fix: 登录跳转', title: '修登录跳转', body: '改了 a.ts', branch: 'fix/login-redirect' });
  assert.equal(good.audits[0]?.action, 'git.text');

  const none = writer({ model: null });
  assert.equal(await none.w.write(input), null);
  assert.equal(none.calls.length, 0);

  const junk = writer({ reply: '我不会' });
  assert.equal(await junk.w.write(input), null);
  assert.match(junk.audits[0]?.detail ?? '', /失败/);

  const leak = writer({ reply: JSON.stringify({ message: 'm', title: 't', body: 'b', branch: null }) });
  await leak.w.write({ ...input, patch: '+AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE1234 ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
  assert.ok(!leak.calls[0]!.body.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
});
