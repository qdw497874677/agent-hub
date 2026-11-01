import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteContextSettings } from './context-settings.ts';

test('上下文策略设置：存取、覆盖、删除（回到继承）', async () => {
  const store = createSqliteContextSettings(new DatabaseSync(':memory:'));
  assert.equal(await store.get('project:p'), null);
  await store.set('project:p', { strategy: 'compaction', enabled: ['compaction'], updatedAt: 1, updatedBy: 'u' });
  assert.deepEqual(await store.get('project:p'), { strategy: 'compaction', enabled: ['compaction'], updatedAt: 1, updatedBy: 'u' });
  await store.set('project:p', { strategy: 'compaction', params: { k: 3 }, updatedAt: 2, updatedBy: 'v' });
  assert.deepEqual(await store.get('project:p'), { strategy: 'compaction', params: { k: 3 }, updatedAt: 2, updatedBy: 'v' });
  await store.set('project:p', null);
  assert.equal(await store.get('project:p'), null);
});

test('上下文策略设置：按前缀列出（角色层）', async () => {
  const store = createSqliteContextSettings(new DatabaseSync(':memory:'));
  await store.set('role:p:coder', { strategy: 'compaction', updatedAt: 1, updatedBy: 'u' });
  await store.set('role:p:review', { strategy: 'compaction', updatedAt: 1, updatedBy: 'u' });
  await store.set('role:q:coder', { strategy: 'compaction', updatedAt: 1, updatedBy: 'u' });
  await store.set('project:p', { strategy: 'compaction', updatedAt: 1, updatedBy: 'u' });
  assert.deepEqual((await store.list('role:p:')).map((r) => r.key), ['role:p:coder', 'role:p:review']);
});
