import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type AgentProfile } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

const profile = (id: string, ownerId: string | null, name: string): AgentProfile => ({
  id,
  ownerId,
  name,
  ref: { runtime: 'opencode', model: 'my-codex/go-glm-5.3', options: { mode: 'build', effort: 'high' } },
  notes: 'notes',
  createdAt: 10,
  updatedAt: 10
});

test('Agent 配置存储：按 owner 查、保存覆盖、删除', async () => {
  const store = openSqliteStore(':memory:');
  await store.agentProfiles.save(profile('p1', 'u1', '探索'));
  await store.agentProfiles.save(profile('p2', 'u1', '构建'));
  await store.agentProfiles.save(profile('p3', 'u2', '别人的'));

  assert.deepEqual((await store.agentProfiles.listByOwner('u1')).map((row) => row.name), ['构建', '探索']);
  assert.equal((await store.agentProfiles.listByOwner('u2')).length, 1);
  assert.equal((await store.agentProfiles.listByOwner(null)).length, 0);

  const found = await store.agentProfiles.byId('p1');
  assert.equal(found?.ref.options.mode, 'build');

  await store.agentProfiles.save({ ...profile('p1', 'u1', '探索 v2'), updatedAt: 20 });
  assert.equal((await store.agentProfiles.byId('p1'))?.name, '探索 v2');

  await store.agentProfiles.removeByOwner('u1');
  assert.equal((await store.agentProfiles.listByOwner('u1')).length, 0);
  assert.equal((await store.agentProfiles.byId('p3'))?.name, '别人的');
  store.close();
});
