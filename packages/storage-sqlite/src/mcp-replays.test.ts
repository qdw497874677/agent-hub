import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createMcpReplays } from './mcp-replays.ts';

test('mcp_replays：put / get，占位期间不回放结果', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createMcpReplays(db);

  assert.equal(await store.get('k'), null);
  assert.equal(await store.claim!('k', 1_000, -29_000, -86_399_000), true);
  assert.equal(await store.get('k'), null, 'pending 不能当结果回放');
  assert.equal(await store.claim!('k', 1_001, -28_999, -86_398_999), false, '同一 key 只能有一个占位');

  await store.put('k', 'result', 1_002);
  assert.equal(await store.get('k', 1_002), 'result');
  assert.equal(await store.claim!('k', 1_003, -28_997, -86_398_997), false, '已完成的结果不能被新请求覆盖');
});

test('mcp_replays：结果按 created_at + ttl 过期，过期后可重新占位', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createMcpReplays(db);
  await store.claim!('k', 10_000, -20_000, -86_390_000);
  await store.put('k', 'old', 10_000);

  assert.equal(await store.get('k', 10_000 + 999, 1_000), 'old');
  assert.equal(await store.get('k', 10_000 + 1_001, 1_000), null);
  assert.equal(await store.claim!('k', 11_001, 11_001 - 30_000, 11_001 - 1_000), true, '过期结果可以覆盖');
  assert.equal(await store.get('k', 11_001, 1_000), null);
});

test('mcp_replays：占位超时可被接管，release 立刻放行', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createMcpReplays(db);
  assert.equal(await store.claim!('k', 1_000, -29_000, -86_399_000), true);

  assert.equal(await store.claim!('k', 1_000 + 29_999, 1_000 + 29_999 - 30_000, 1_000 + 29_999 - 86_400_000), false);
  assert.equal(await store.claim!('k', 1_000 + 30_001, 1_000 + 30_001 - 30_000, 1_000 + 30_001 - 86_400_000), true);

  await store.release!('k');
  assert.equal(await store.get('k'), null);
  assert.equal(await store.claim!('k', 2_000, -28_000, -86_398_000), true);
});

test('mcp_replays：commit 只在占位还是自己那次时落档，release 带归属不删别人的占位', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createMcpReplays(db);

  assert.equal(await store.claim!('k', 1_000, -29_000, -86_399_000), true);
  // created_at 不是自己占位那次：视为被别人接管，不能写。
  assert.equal(await store.commit!('k', 'stale', 1_001, 999), false);
  assert.equal(await store.get('k', 1_001), null);
  assert.equal(await store.commit!('k', 'mine', 1_002, 1_000), true);
  assert.equal(await store.get('k', 1_002), 'mine');

  // 接管场景：老请求的 commit / release 都不能动新占位或新结果。
  const other = createMcpReplays(new DatabaseSync(':memory:'));
  assert.equal(await other.claim!('k', 1_000, -29_000, -86_399_000), true);
  assert.equal(await other.claim!('k', 40_000, 40_000 - 30_000, 40_000 - 86_400_000), true, '占位超时可被接管');
  assert.equal(await other.commit!('k', 'newer', 40_001, 40_000), true);
  assert.equal(await other.commit!('k', 'stale', 40_002, 1_000), false);
  await other.release!('k', 1_000);
  assert.equal(await other.get('k', 40_002), 'newer', '老请求不能删掉新结果');

  assert.equal(await other.claim!('k2', 50_000, 20_000, -36_400_000), true);
  await other.release!('k2', 50_000);
  assert.equal(await other.get('k2', 50_000), null, '归属对得上时能放行');
});

test('mcp_replays：老库没有 status 列时自动补列', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE mcp_replays (key TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL)');
  db.prepare('INSERT INTO mcp_replays (key, body, created_at) VALUES (?, ?, ?)').run('old', 'result', 5_000);

  const store = createMcpReplays(db);
  assert.equal(await store.get('old', 5_000), 'result');
});
