import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wsGh } from './worker-methods.ts';

test('ws.gh：PR 带 head 仓库与分支名（#269 认领要 repo + headRef 证据）', () => {
  const pr = { number: 21, url: 'https://github.com/o/r/pull/21', state: 'open', headSha: 'h1', mergedAt: null, base: 'main', repo: 'o/r', headRef: 'feat/x' };
  const parsed = wsGh.result.parse({ ok: true, prs: [pr] });
  assert.deepEqual(parsed, { ok: true, prs: [pr] });
});

test('ws.gh：老 Worker 的响应没有 repo / headRef / base 也应能解出来（由调用方决定跳不跳）', () => {
  const legacy = { number: 9, url: 'https://github.com/o/r/pull/9', state: 'open', headSha: 'h0', mergedAt: null };
  const parsed = wsGh.result.parse({ ok: true, pr: legacy });
  assert.deepEqual(parsed, { ok: true, pr: legacy });
});

test('ws.gh：list 带 origin repo 绑定（#269），老请求不带 repo 仍兼容', () => {
  const modern = wsGh.params.parse({ path: '/p', request: { action: 'list', head: 'feat/x', repo: 'o/r' } });
  assert.deepEqual(modern.request, { action: 'list', head: 'feat/x', repo: 'o/r' });
  assert.equal(wsGh.params.safeParse({ path: '/p', request: { action: 'list', head: 'feat/x' } }).success, true);
});

test('ws.gh：repo / headRef 类型不对直接拒绝', () => {
  const base = { number: 1, url: 'https://github.com/o/r/pull/1', state: 'open', headSha: 'h0', mergedAt: null };
  assert.equal(wsGh.result.safeParse({ ok: true, pr: { ...base, repo: 5 } }).success, false);
  assert.equal(wsGh.result.safeParse({ ok: true, pr: { ...base, headRef: 5 } }).success, false);
});

test('ws.publish_ref：只接受 40 位小写 SHA 与显式 expectedUrl / baseBranch', async () => {
  const { wsPublishRef } = await import('./worker-methods.ts');
  assert.equal(wsPublishRef.name, 'ws.publish_ref');
  const base = {
    path: '/repo',
    branch: 'agent-hub/fix-1a2b',
    sha: '0123456789abcdef0123456789abcdef01234567',
    expectedUrl: 'https://github.com/o/r.git',
    baseBranch: 'main'
  };
  assert.equal(wsPublishRef.params.safeParse(base).success, true);
  assert.equal(wsPublishRef.params.safeParse({ ...base, sha: '0123456789ABCDEF0123456789abcdef01234567' }).success, false);
  assert.equal(wsPublishRef.params.safeParse({ ...base, sha: '0123456' }).success, false);
  assert.equal(wsPublishRef.params.safeParse({ ...base, verifyOnly: true }).success, true);
  // 目的地/base 都必须显式给出：Worker 不猜
  assert.equal(wsPublishRef.params.safeParse({ ...base, expectedUrl: undefined }).success, false);
  assert.equal(wsPublishRef.params.safeParse({ ...base, baseBranch: undefined }).success, false);
  const outcome = { sha: base.sha, branch: base.branch, published: true, pushed: true, baseBranch: 'main', baseSha: 'a'.repeat(40), defaultBranch: 'main', remoteSha: null, uncertain: false, reason: null };
  assert.deepEqual(wsPublishRef.result.parse(outcome), outcome);
});

test('ws.gh result 接受 draft / baseRepo（新 Worker 才带，老响应仍兼容）', async () => {
  const { wsGh } = await import('./worker-methods.ts');
  const base = { number: 3, url: 'https://github.com/o/r/pull/3', state: 'open', headSha: 'h', mergedAt: null };
  const modern = { ...base, draft: true, baseRepo: 'o/r' };
  assert.deepEqual(wsGh.result.parse({ ok: true, pr: modern }), { ok: true, pr: modern });
  assert.equal(wsGh.result.safeParse({ ok: true, pr: { ...base, draft: 'yes' } }).success, false);
});

test('ws.prepare_delegation_worktree：显式 repo/base/目的地与 40 位小写 baseSha', async () => {
  const { wsPrepareDelegationWorktree } = await import('./worker-methods.ts');
  assert.equal(wsPrepareDelegationWorktree.name, 'ws.prepare_delegation_worktree');
  assert.equal(wsPrepareDelegationWorktree.capability, 'git.remote');
  const base = {
    repoPath: '/repo',
    path: '/repo/../trees/a',
    branch: 'agent-hub/delegation-1a2b',
    baseBranch: 'main',
    expectedUrl: 'https://github.com/o/r.git'
  };
  assert.equal(wsPrepareDelegationWorktree.params.safeParse(base).success, true);
  assert.equal(wsPrepareDelegationWorktree.params.safeParse({ ...base, auth: { header: 'Authorization: Basic x', url: base.expectedUrl } }).success, true);
  assert.equal(wsPrepareDelegationWorktree.params.safeParse({ ...base, baseBranch: undefined }).success, false);
  assert.equal(wsPrepareDelegationWorktree.params.safeParse({ ...base, expectedUrl: '' }).success, false);
  assert.equal(wsPrepareDelegationWorktree.params.safeParse({ ...base, repoPath: '' }).success, false);
  const outcome = { path: '/trees/a', branch: base.branch, baseSha: 'a'.repeat(40) };
  assert.deepEqual(wsPrepareDelegationWorktree.result.parse(outcome), outcome);
  assert.equal(wsPrepareDelegationWorktree.result.safeParse({ ...outcome, baseSha: 'A'.repeat(40) }).success, false);
});

test('ws.import_commit：只接受 refs/agent-hub/imports/<id>/<sha> 且末尾 SHA 必须等于 sha', async () => {
  const { wsImportCommit } = await import('./worker-methods.ts');
  assert.equal(wsImportCommit.name, 'ws.import_commit');
  assert.equal(wsImportCommit.capability, 'git');
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const base = {
    sourcePath: '/src',
    targetPath: '/dst',
    sourceBranch: 'feat/x',
    sha,
    ref: `refs/agent-hub/imports/delegation-1/${sha}`,
    expectedUrl: 'https://github.com/o/r.git'
  };
  assert.equal(wsImportCommit.params.safeParse(base).success, true);
  for (const ref of ['refs/agent-hub/imported/' + sha, 'refs/heads/imported', 'refs/agent-hub/imports/a/b/' + sha, 'refs/tags/' + sha]) {
    assert.equal(wsImportCommit.params.safeParse({ ...base, ref }).success, false, ref);
  }
  const mismatched = wsImportCommit.params.safeParse({ ...base, ref: `refs/agent-hub/imports/delegation-1/${'a'.repeat(40)}` });
  assert.equal(mismatched.success, false);
  assert.equal(wsImportCommit.params.safeParse({ ...base, sha: sha.toUpperCase() }).success, false);
  assert.equal(wsImportCommit.params.safeParse({ ...base, expectedUrl: '' }).success, false);
  assert.equal(wsImportCommit.params.safeParse({ ...base, sourceBranch: undefined }).success, false);
  const outcome = { ref: base.ref, sha, alreadyPresent: false };
  assert.deepEqual(wsImportCommit.result.parse(outcome), outcome);
  assert.equal(wsImportCommit.result.safeParse({ ...outcome, alreadyPresent: 'no' }).success, false);
});

test('ws.import_project_git_bundle：固定 8 MiB 上限、strict 字段、ref 绑定 tipSha', async () => {
  const { wsImportProjectGitBundle, PROJECT_GIT_BUNDLE_MAX_BASE64_BYTES } = await import('./worker-methods.ts');
  assert.equal(wsImportProjectGitBundle.name, 'ws.import_project_git_bundle');
  assert.equal(wsImportProjectGitBundle.capability, 'git');
  assert.equal(PROJECT_GIT_BUNDLE_MAX_BASE64_BYTES, 11_184_812, '8 MiB 原始对象的 base64 长度');
  const tipSha = '0123456789abcdef0123456789abcdef01234567';
  const base = {
    path: '/work/repo',
    expectedUrl: 'https://github.com/o/r.git',
    bundleBase64: 'aGVsbG8=',
    bundleSha256: 'a'.repeat(64),
    tipSha,
    ref: `refs/agent-hub/fetch/project-1/${tipSha}`
  };
  assert.equal(wsImportProjectGitBundle.params.safeParse(base).success, true);
  // ref 命名空间固定，末尾 SHA 必须等于 tipSha
  assert.equal(wsImportProjectGitBundle.params.safeParse({ ...base, tipSha: 'b'.repeat(40) }).success, false);
  assert.equal(wsImportProjectGitBundle.params.safeParse({ ...base, ref: `refs/heads/${tipSha}` }).success, false);
  assert.equal(wsImportProjectGitBundle.params.safeParse({ ...base, ref: `refs/agent-hub/fetch/p/${'b'.repeat(40)}` }).success, false);
  // strict：凭据 / 调用方自带上限 / 其它字段一律拒绝
  assert.equal(wsImportProjectGitBundle.params.safeParse({ ...base, maxBundleBytes: 1024 }).success, false);
  assert.equal(wsImportProjectGitBundle.params.safeParse({ ...base, auth: { header: 'Authorization: Basic x' } }).success, false);
  // SHA 必须小写
  assert.equal(wsImportProjectGitBundle.params.safeParse({ ...base, tipSha: tipSha.toUpperCase() }).success, false);
  assert.equal(wsImportProjectGitBundle.params.safeParse({ ...base, bundleSha256: 'A'.repeat(64) }).success, false);
  // 硬上限：正好 11,184,812 字节可接受，多一个字节直接拒绝
  assert.equal(wsImportProjectGitBundle.params.safeParse({ ...base, bundleBase64: 'A'.repeat(PROJECT_GIT_BUNDLE_MAX_BASE64_BYTES) }).success, true);
  assert.equal(wsImportProjectGitBundle.params.safeParse({ ...base, bundleBase64: 'A'.repeat(PROJECT_GIT_BUNDLE_MAX_BASE64_BYTES + 1) }).success, false);
  const outcome = { ref: base.ref, tipSha, alreadyPresent: false };
  assert.deepEqual(wsImportProjectGitBundle.result.parse(outcome), outcome);
});
