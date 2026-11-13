import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNearBottom } from './stick-to-bottom.ts';

test('贴底判定：在底部附近才跟着滚，往上翻了就不打扰', () => {
  assert.equal(isNearBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }), true, '正好在底部');
  assert.equal(isNearBottom({ scrollTop: 540, scrollHeight: 1000, clientHeight: 400 }), true, '差 60px 仍算底部');
  assert.equal(isNearBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 }), false, '翻上去看历史');
  assert.equal(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 }), true, '内容不满一屏');
});
