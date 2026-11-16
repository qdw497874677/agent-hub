import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assetNote,
  assetSelectionKey,
  includedAssetIds,
  selectionFor,
  submitAssetIds,
  toggleAsset,
  type DeriveAssetEntry,
  type AssetSelection
} from './derive-assets.ts';

const entry = (over: Partial<DeriveAssetEntry>): DeriveAssetEntry => ({
  assetId: 'a1',
  kind: 'skill',
  name: '代码审查',
  digest: 'd1',
  scope: 'project',
  ...over
});

const entries: DeriveAssetEntry[] = [
  entry({ assetId: 'a1', kind: 'skill', name: '代码审查' }),
  entry({ assetId: 'a2', kind: 'instruction', name: '提交规范', scope: 'team' }),
  entry({ assetId: 'a3', kind: 'mcp', name: 'playwright', scope: 'global' })
];

const fresh = (): AssetSelection => selectionFor(null, assetSelectionKey('p1', 'w1'));

test('默认全选：一项都没取消时不传 assetIds', () => {
  assert.equal(submitAssetIds(entries, fresh()), undefined);
});

test('取消一项：只发剩下的;取消全部：发空数组', () => {
  const off = toggleAsset(fresh(), 'a2', false);
  assert.deepEqual(submitAssetIds(entries, off), ['a1', 'a3']);
  assert.deepEqual(includedAssetIds(entries, off), ['a1', 'a3']);

  const none = toggleAsset(toggleAsset(off, 'a1', false), 'a3', false);
  assert.deepEqual(submitAssetIds(entries, none), []);
});

test('勾回来就回到不传（和全选完全一样）', () => {
  const back = toggleAsset(toggleAsset(fresh(), 'a2', false), 'a2', true);
  assert.deepEqual(back.excluded, []);
  assert.equal(submitAssetIds(entries, back), undefined);
});

test('换机器 / 换项目都重新全选，同一台机器保留勾选', () => {
  const off = toggleAsset(fresh(), 'a2', false);
  assert.equal(selectionFor(off, assetSelectionKey('p1', 'w1')), off);
  assert.deepEqual(selectionFor(off, assetSelectionKey('p1', 'w2')).excluded, []);
  assert.deepEqual(selectionFor(off, assetSelectionKey('p2', 'w1')).excluded, []);
});

test('一行说明：项目级不标作用域', () => {
  assert.equal(assetNote(entries[0]!), '技能');
  assert.equal(assetNote(entries[1]!), '指令 · 团队');
  assert.equal(assetNote(entries[2]!), 'MCP · 全局');
});
