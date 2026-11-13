import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteStore } from './store.ts';

const alias = (id: string) => ({ id, label: `${id} 的显示名`, command: id, args: ['--acp'], models: ['m1'], defaultModel: 'm1' });

test('worker 别名存储：往返、覆盖、没配过回 null', async () => {
  const store = openSqliteStore(':memory:');
  assert.equal(await store.workerAgents.get('w1'), null);

  await store.workerAgents.save('w1', [alias('a'), alias('b')]);
  assert.deepEqual(await store.workerAgents.get('w1'), [alias('a'), alias('b')]);

  await store.workerAgents.save('w1', [alias('c')]);
  assert.deepEqual(await store.workerAgents.get('w1'), [alias('c')]);
  store.close();
});

test('worker 别名存储：空数组删行，回到「没配过」', async () => {
  const store = openSqliteStore(':memory:');
  await store.workerAgents.save('w1', [alias('a')]);
  assert.equal((await store.workerAgents.get('w1'))?.length, 1);

  await store.workerAgents.save('w1', []);
  assert.equal(await store.workerAgents.get('w1'), null);
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM worker_agents').get() as unknown as { n: number };
  assert.equal(row.n, 0);
  store.close();
});

test('worker 别名存储：坏 doc 按「没配过」处理（回 null，不抛）', async () => {
  const store = openSqliteStore(':memory:');
  store.db.prepare('INSERT INTO worker_agents(worker_id, doc, updated_at) VALUES (?, ?, ?)').run('w1', '{not json', 1);
  assert.equal(await store.workerAgents.get('w1'), null);
  store.db.prepare('INSERT INTO worker_agents(worker_id, doc, updated_at) VALUES (?, ?, ?)').run('w2', JSON.stringify([{ id: 'pi', label: 'x', command: 'x', args: [] }]), 1);
  assert.equal(await store.workerAgents.get('w2'), null);
  store.close();
});
