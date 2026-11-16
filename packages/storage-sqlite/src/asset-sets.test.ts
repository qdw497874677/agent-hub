import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteStore } from './store.ts';
import type { AssetSet } from '@agent-hub/domain';

const set = (patch: Partial<AssetSet> = {}): AssetSet => ({
  id: 'aset_00000001',
  teamId: 't1',
  name: '基础',
  description: '日常',
  items: [{ assetId: 'a1' }, { assetId: 'a2' }],
  createdBy: 'u1',
  createdAt: 10,
  updatedAt: 10,
  ...patch
});

test('资产组合仓库：save/byId/listByTeam/remove + 团队内重名约束', async () => {
  const store = openSqliteStore(':memory:');
  await store.assetSets.save(set());
  assert.deepEqual(await store.assetSets.byId('aset_00000001'), set());

  await store.assetSets.save(set({ id: 'aset_00000002', name: '前端', updatedAt: 20 }));
  await store.assetSets.save(set({ id: 'aset_00000003', teamId: 't2', name: '基础' }));
  assert.deepEqual((await store.assetSets.listByTeam('t1')).map((row) => row.id), ['aset_00000002', 'aset_00000001']);
  assert.equal((await store.assetSets.listByTeam('t2')).length, 1);

  // 同团队重名被唯一索引挡下。
  await assert.rejects(() => store.assetSets.save(set({ id: 'aset_00000004', name: '前端' })));

  await store.assetSets.remove('aset_00000002');
  assert.equal(await store.assetSets.byId('aset_00000002'), null);
  store.close();
});
