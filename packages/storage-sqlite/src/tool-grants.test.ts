import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asSessionId, asTaskId } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

test('工具授权往返：按 hash 查、按会话作废；调用审计倒序', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-tools-'));
  try {
    const store = openSqliteStore(join(dir, 'hub.db'));
    const base = { taskId: asTaskId('t'), sessionId: asSessionId('s'), workerId: 'w', scopes: ['task:read' as const], createdAt: 1, expiresAt: 99, revokedAt: null };
    await store.toolGrants.save({ ...base, id: 'g1', tokenHash: 'h1' });
    await store.toolGrants.save({ ...base, id: 'g2', tokenHash: 'h2', sessionId: asSessionId('other') });
    assert.deepEqual((await store.toolGrants.byTokenHash('h1'))?.scopes, ['task:read']);
    assert.equal(await store.toolGrants.byTokenHash('nope'), null);
    assert.equal(await store.toolGrants.revokeSession(asSessionId('s'), 5), 1);
    assert.equal((await store.toolGrants.byTokenHash('h1'))?.revokedAt, 5);
    assert.equal((await store.toolGrants.byTokenHash('h2'))?.revokedAt, null);
    await store.toolGrants.save({ ...base, id: 'g3', tokenHash: 'h3', sessionId: asSessionId('running') });
    assert.equal(await store.toolGrants.revokeAllExcept([asSessionId('running')], 7), 1, '只作废 other（s 已作废）');
    assert.equal((await store.toolGrants.byTokenHash('h2'))?.revokedAt, 7);
    assert.equal((await store.toolGrants.byTokenHash('h3'))?.revokedAt, null);
    assert.equal(await store.toolGrants.revokeAllExcept([], 8), 1);
    // 续期写回 expires_at
    await store.toolGrants.save({ ...base, id: 'g1', tokenHash: 'h1', expiresAt: 500, revokedAt: 5 });
    assert.equal((await store.toolGrants.byTokenHash('h1'))?.expiresAt, 500);
    const call = { grantId: 'g1', taskId: asTaskId('t'), sessionId: asSessionId('s'), tool: 'task.get', version: 1, detail: '', latencyMs: 2 };
    await store.toolGrants.recordCall({ ...call, id: 'c1', ok: true, at: 10 });
    await store.toolGrants.recordCall({ ...call, id: 'c2', ok: false, at: 20 });
    const recent = await store.toolGrants.recentCalls(10, asSessionId('s'));
    assert.deepEqual(recent.map((row) => [row.id, row.ok]), [['c2', false], ['c1', true]]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('授权带上身份快照：actor 往返；续期写入不把 actor 抹掉（#221 步骤 3）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-tools-actor-'));
  try {
    const store = openSqliteStore(join(dir, 'hub.db'));
    const base = { taskId: asTaskId('t'), sessionId: asSessionId('s'), workerId: 'w', scopes: ['task:read' as const], createdAt: 1, expiresAt: 99, revokedAt: null };
    await store.toolGrants.save({ ...base, id: 'g1', tokenHash: 'h1', actor: { userId: 'u1', via: 'group' } });
    assert.deepEqual((await store.toolGrants.byTokenHash('h1'))?.actor, { userId: 'u1', via: 'group' });
    // 续期写回（同一个 grant 对象但没带 actor）不能把已冻结的身份清掉
    const { actor: _actor, ...withoutActor } = { ...base, id: 'g1', tokenHash: 'h1', expiresAt: 500, actor: undefined };
    await store.toolGrants.save(withoutActor);
    const kept = await store.toolGrants.byTokenHash('h1');
    assert.equal(kept?.expiresAt, 500);
    assert.deepEqual(kept?.actor, { userId: 'u1', via: 'group' });
    // 旧授权没有 actor：读出来是 undefined，调用方回落到按会话推导
    await store.toolGrants.save({ ...base, id: 'g2', tokenHash: 'h2', sessionId: asSessionId('old') });
    assert.equal((await store.toolGrants.byTokenHash('h2'))?.actor, undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
