import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UserId } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

test('接入码只能兑换一次；凭据按哈希 / workerId 查；吊销留痕且跨重开保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-enroll-'));
  try {
    const path = join(dir, 'hub.db');
    const store = openSqliteStore(path);
    const by = 'u1' as UserId;
    await store.enrollment.savePairing({ hash: 'p1', createdBy: by, createdAt: 1, expiresAt: 100, usedAt: null, workerId: null });
    assert.equal((await store.enrollment.pairingByHash('p1'))?.expiresAt, 100);
    const results = await Promise.all([
      store.enrollment.consumePairing('p1', 'w1', 5),
      store.enrollment.consumePairing('p1', 'w2', 5)
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(await store.enrollment.consumePairing('nope', 'w3', 5), false);
    assert.equal((await store.enrollment.pairingByHash('p1'))?.usedAt, 5);

    await store.enrollment.saveCredential({ workerId: 'w1', tokenHash: 'c1', enrolledBy: by, label: '书房', createdAt: 5, revokedAt: null });
    assert.equal((await store.enrollment.credentialByHash('c1'))?.workerId, 'w1');
    assert.equal((await store.enrollment.credentialFor('w1'))?.label, '书房');
    await store.enrollment.revoke('w1', 9);
    store.close?.();

    const reopened = openSqliteStore(path);
    assert.equal((await reopened.enrollment.credentialFor('w1'))?.revokedAt, 9);
    assert.equal((await reopened.enrollment.listCredentials()).length, 1);
    reopened.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ADR 0030 D3：凭据记下连接来历和能力；老库补列不丢数据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-enroll-'));
  try {
    const path = join(dir, 'hub.db');
    const { DatabaseSync } = await import('node:sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE worker_credentials (worker_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, enrolled_by TEXT NOT NULL,
      label TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
      INSERT INTO worker_credentials VALUES ('old', 'h-old', 'u1', '老机器', 1, NULL);`);
    old.close();
    const store = openSqliteStore(path);
    const legacy = await store.enrollment.credentialFor('old');
    assert.equal(legacy?.label, '老机器');
    assert.equal(legacy?.capabilities, null);
    await store.enrollment.recordConnection('old', { at: 42, address: '1.2.3.4', userAgent: 'abc1234' });
    await store.enrollment.setCapabilities('old', ['files.read']);
    const after = await store.enrollment.credentialFor('old');
    assert.equal(after?.lastConnectedAt, 42);
    assert.equal(after?.lastAddress, '1.2.3.4');
    assert.equal(after?.lastUserAgent, 'abc1234');
    assert.deepEqual(after?.capabilities, ['files.read']);
    store.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
