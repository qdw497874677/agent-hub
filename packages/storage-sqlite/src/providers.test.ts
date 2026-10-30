import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteProviders } from './providers.ts';

test('密钥加密存放，只有 revealKey 拿得到；用量累加；worker 路由覆盖', async () => {
  const db = new DatabaseSync(':memory:');
  const repo = createSqliteProviders(db, randomBytes(32));
  await repo.save({ id: 'p1', scope: 'hub', ownerId: null, slug: 'gw', name: 'GW', protocol: 'openai-chat', baseUrl: 'https://x/v1', models: [{ id: 'm' }], routing: 'direct', enabled: true, lastCheck: null, createdBy: 'u', createdAt: 1, updatedAt: 1 });
  await repo.setKey('p1', 'sk-plaintext-secret', 2);
  assert.equal((await repo.byId('p1'))?.hasKey, true);
  assert.equal(await repo.revealKey('p1'), 'sk-plaintext-secret');
  const dump = JSON.stringify(db.prepare("SELECT * FROM provider_secrets").all(), (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v));
  assert.ok(!dump.includes('sk-plaintext-secret'));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM model_providers').all()).includes('sk-plaintext'));
  await repo.addUsage('p1', { requests: 1, bytesOut: 10 }, 3);
  await repo.addUsage('p1', { requests: 2, errors: 1 }, 4);
  const usage = await repo.usage('p1');
  assert.equal(usage.requests, 3);
  assert.equal(usage.errors, 1);
  assert.equal(usage.bytesOut, 10);
  await repo.setWorkerRouting('w1', 'hub');
  assert.equal((await repo.workerRouting()).w1, 'hub');
  await repo.setWorkerRouting('w1', null);
  assert.equal((await repo.workerRouting()).w1, undefined);
});
