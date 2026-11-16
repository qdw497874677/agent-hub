import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ASSET_SETS,
  assetSetChoiceKey,
  itemCountText,
  mergeSetAssets,
  moveSetId,
  referenceText,
  setChoiceFor,
  setDescriptionProblem,
  setLimitProblem,
  setNameProblem,
  submitAssetSetIds,
  toggleSetChoice,
  toggleSetId
} from './asset-sets.ts';

const sets = [
  { id: 's1', assetIds: ['a1', 'a2'] },
  { id: 's2', assetIds: ['a2', 'a3'] },
  { id: 's3', assetIds: ['a4'] }
];

test('组合按顺序叠加：同一个资产只留第一次出现的位置', () => {
  assert.deepEqual(mergeSetAssets(sets, ['s2', 's1']), ['a2', 'a3', 'a1']);
  assert.deepEqual(mergeSetAssets(sets, ['s1', 's3']), ['a1', 'a2', 'a4']);
  // 不认识 / 重复的组合 id 直接跳过，不让它影响顺序
  assert.deepEqual(mergeSetAssets(sets, ['s3', 'nope', 's3']), ['a4']);
  assert.deepEqual(mergeSetAssets(sets, []), []);
});

test('勾选保持顺序、不重复；到上限就不再加', () => {
  assert.deepEqual(toggleSetId(['s1'], 's2', true), ['s1', 's2']);
  assert.deepEqual(toggleSetId(['s1', 's2'], 's1', false), ['s2']);
  // 取消再勾回来落在末尾，不回到原来的位置
  assert.deepEqual(toggleSetId(toggleSetId(['s1', 's2'], 's1', false), 's1', true), ['s2', 's1']);
  const full = Array.from({ length: MAX_ASSET_SETS }, (_, index) => `s${index}`);
  assert.equal(toggleSetId(full, 'extra', true).length, MAX_ASSET_SETS);
  assert.deepEqual(moveSetId(full, 'extra', -1), full);
});

test('换顺序只动相邻两位，越界原样返回', () => {
  assert.deepEqual(moveSetId(['s1', 's2', 's3'], 's1', 1), ['s2', 's1', 's3']);
  assert.deepEqual(moveSetId(['s1', 's2', 's3'], 's3', -1), ['s1', 's3', 's2']);
  assert.deepEqual(moveSetId(['s1', 's2'], 's1', -1), ['s1', 's2']);
  assert.deepEqual(moveSetId(['s1', 's2'], 's2', 1), ['s1', 's2']);
  assert.deepEqual(moveSetId(['s1'], 'missing', 1), ['s1']);
});

test('派生提交规则：没动过不传，动过传选中的（可能为空），改回默认又不传', () => {
  const fresh = setChoiceFor(null, ['s1', 's2']);
  assert.equal(fresh.key, assetSetChoiceKey(['s1', 's2']));
  assert.equal(submitAssetSetIds(fresh), undefined);
  // 同一份默认组合：原样返回同一份引用（不重置用户的选择）
  assert.equal(setChoiceFor(fresh, ['s1', 's2']), fresh);

  const off = toggleSetChoice(fresh, 's2', false);
  assert.deepEqual(submitAssetSetIds(off), ['s1']);

  const none = toggleSetChoice(off, 's1', false);
  assert.deepEqual(submitAssetSetIds(none), []);

  const other = toggleSetChoice(fresh, 's3', true);
  assert.deepEqual(submitAssetSetIds(other), ['s1', 's2', 's3']);

  // 勾回和默认一模一样：算没动过，不传
  const back = toggleSetChoice(off, 's2', true);
  assert.equal(back.touched, false);
  assert.equal(submitAssetSetIds(back), undefined);

  // 项目默认组合变了（别人改了设置）：重新来一份
  const changed = setChoiceFor(other, ['s3']);
  assert.deepEqual(changed.ids, ['s3']);
  assert.equal(changed.touched, false);
});

test('文案与校验：项数、引用提示、名字 / 说明 / 上限', () => {
  assert.equal(itemCountText(0), '0 项');
  assert.equal(itemCountText(4), '4 项');
  assert.equal(referenceText(null), null);
  assert.equal(referenceText(0), '没有被项目引用');
  assert.equal(referenceText(2), '被 2 个项目引用');

  assert.equal(setNameProblem(''), '给组合起个名字');
  assert.equal(setNameProblem('   '), '给组合起个名字');
  assert.equal(setNameProblem('常用'), null);
  assert.equal(setNameProblem('长'.repeat(61)), '名字最多 60 个字');
  assert.equal(setNameProblem('长'.repeat(60)), null);

  assert.equal(setDescriptionProblem(''), null);
  assert.equal(setDescriptionProblem('长'.repeat(301)), '说明最多 300 个字');
  assert.equal(setDescriptionProblem('长'.repeat(300)), null);

  assert.equal(setLimitProblem(['s1', 's1', 's2']), null);
  assert.equal(
    setLimitProblem(Array.from({ length: MAX_ASSET_SETS + 1 }, (_, index) => `s${index}`)),
    '最多 8 个组合'
  );
});
