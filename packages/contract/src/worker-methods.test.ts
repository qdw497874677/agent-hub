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
