import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEqualOrDescendantPath, isStrictDescendantPath } from './path-boundary.ts';

// 网关与 Worker 共用这一份实现：这些用例锁住路径段语义。
test('网关路径边界：相等 / 子孙 / 兄弟前缀 / 尾部分隔符 / root', () => {
  assert.equal(isEqualOrDescendantPath('/home/u', '/home/u'), true);
  assert.equal(isEqualOrDescendantPath('/home/u/', '/home/u/a'), true);
  assert.equal(isEqualOrDescendantPath('/home/u', '/home/user2'), false);
  assert.equal(isEqualOrDescendantPath('/home/u', '/home/u/../evil'), false);
  assert.equal(isEqualOrDescendantPath('/', '/anything'), true);
  assert.equal(isEqualOrDescendantPath('/', '/'), true);
  assert.equal(isEqualOrDescendantPath('/home/u', 'a'), false);
  assert.equal(isStrictDescendantPath('/home/u', '/home/u'), false);
  assert.equal(isStrictDescendantPath('/home/u', '/home/u/a'), true);
  assert.equal(isStrictDescendantPath('/', '/'), false);
  assert.equal(isStrictDescendantPath('/', '/a'), true);
});
