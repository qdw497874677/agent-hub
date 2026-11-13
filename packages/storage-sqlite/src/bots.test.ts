import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asProjectId, type Bot } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

const bot = (id: string, projectId: string, name: string, createdAt = 10): Bot => ({
  id,
  projectId: asProjectId(projectId),
  name,
  displayName: `${name} 的显示名`,
  color: 'sage',
  description: `${name} 的职责`,
  ref: { runtime: 'opencode', model: 'my-codex/go-glm-5.3', options: { mode: 'build', effort: 'high' } },
  reuse: 'per-trace',
  createdAt,
  updatedAt: createdAt
});

test('bot 存储：往返、byName、按项目列、覆盖保存', async () => {
  const store = openSqliteStore(':memory:');
  await store.bots.save(bot('bot_a', 'p1', 'qa', 20));
  await store.bots.save(bot('bot_b', 'p1', 'coder', 10));
  await store.bots.save(bot('bot_c', 'p2', 'qa', 5));

  const found = await store.bots.byId('bot_a');
  assert.deepEqual(found, bot('bot_a', 'p1', 'qa', 20));

  assert.equal((await store.bots.byName(asProjectId('p1'), 'qa'))?.id, 'bot_a');
  assert.equal((await store.bots.byName(asProjectId('p1'), 'nope')), null);
  assert.equal((await store.bots.byName(asProjectId('p2'), 'qa'))?.id, 'bot_c');

  // created_at 再按 name
  assert.deepEqual((await store.bots.list(asProjectId('p1'))).map((row) => row.name), ['coder', 'qa']);

  await store.bots.save({ ...bot('bot_a', 'p1', 'qa', 20), displayName: '质检', updatedAt: 30 });
  const updated = await store.bots.byId('bot_a');
  assert.equal(updated?.displayName, '质检');
  assert.equal(updated?.updatedAt, 30);
  assert.equal((await store.bots.list(asProjectId('p1'))).length, 2);
  store.close();
});

test('bot 存储：(project, name) 唯一，删掉才能复用', async () => {
  const store = openSqliteStore(':memory:');
  await store.bots.save(bot('bot_a', 'p1', 'qa'));
  await assert.rejects(store.bots.save(bot('bot_b', 'p1', 'qa')));
  await store.bots.remove('bot_a');
  await store.bots.save(bot('bot_b', 'p1', 'qa'));
  assert.equal((await store.bots.byName(asProjectId('p1'), 'qa'))?.id, 'bot_b');
  assert.equal(await store.bots.byId('bot_a'), null);
  store.close();
});
