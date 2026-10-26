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
