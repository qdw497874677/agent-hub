import { test } from 'node:test';
import assert from 'node:assert/strict';
import { growField } from './composer-grow.ts';

const FLOOR = 44;
const MAX = 200;

test('内容比一行还矮：撑到下限，不滚', () => {
  assert.deepEqual(growField({ scrollHeight: 28, floor: FLOOR, max: MAX }), { height: FLOOR, overflowY: 'hidden' });
});

test('内容在下限和上限之间：正好是内容高度，不滚', () => {
  assert.deepEqual(growField({ scrollHeight: 96, floor: FLOOR, max: MAX }), { height: 96, overflowY: 'hidden' });
});

test('内容刚好等于上限：还是不长滚动条', () => {
  assert.deepEqual(growField({ scrollHeight: MAX, floor: FLOOR, max: MAX }), { height: MAX, overflowY: 'hidden' });
});

test('内容超过上限：高度夹住，自己滚', () => {
  assert.deepEqual(growField({ scrollHeight: 316, floor: FLOOR, max: MAX }), { height: MAX, overflowY: 'auto' });
});

test('超过上限多少都一样高：上限是硬的', () => {
  const a = growField({ scrollHeight: 201, floor: FLOOR, max: MAX });
  const b = growField({ scrollHeight: 4_000, floor: FLOOR, max: MAX });

  assert.equal(a.height, b.height);
  assert.equal(a.height, MAX);
});

test('scrollHeight 已经含 padding：不减免，换一行就多一行的量', () => {
  // 三行 = 三行的高度，而不是「三行减两次 padding」。
  const oneLine = growField({ scrollHeight: 44, floor: FLOOR, max: MAX });
  const twoLines = growField({ scrollHeight: 66, floor: FLOOR, max: MAX });

  assert.equal(twoLines.height - oneLine.height, 22);
});
