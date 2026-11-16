import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTopmost, trapTarget } from './focus-trap.ts';

test('Tab 在框里循环：末尾回到开头，开头 Shift+Tab 去末尾', () => {
  assert.equal(trapTarget(3, 2, false), 0);
  assert.equal(trapTarget(3, 0, true), 2);
  assert.equal(trapTarget(3, 1, false), null);
  assert.equal(trapTarget(3, 1, true), null);
});

test('焦点在面板本身或框外：Tab 进第一个，Shift+Tab 进最后一个', () => {
  assert.equal(trapTarget(4, -1, false), 0);
  assert.equal(trapTarget(4, -1, true), 3);
});

test('框里没有能聚焦的：留在面板本身', () => {
  assert.equal(trapTarget(0, -1, false), -1);
  assert.equal(trapTarget(0, -1, true), -1);
});

test('只有一个控件：Tab 和 Shift+Tab 都停在它身上', () => {
  assert.equal(trapTarget(1, 0, false), 0);
  assert.equal(trapTarget(1, 0, true), 0);
});

test('只有最上面那层管按键', () => {
  const a = Symbol('a');
  const b = Symbol('b');
  assert.equal(isTopmost(a, [a, b]), false);
  assert.equal(isTopmost(b, [a, b]), true);
  assert.equal(isTopmost(a, []), false);
});
