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
