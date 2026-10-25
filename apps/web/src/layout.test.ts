import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillMissing } from './layout.ts';

test('fillMissing 给新节点补默认位置', () => {
  const current = { a: { x: 5, y: 5 } };
  const next = fillMissing(current, {
    a: { x: 0, y: 0 },
    b: { x: 400, y: 80 }
  });
  assert.deepEqual(next, { a: { x: 5, y: 5 }, b: { x: 400, y: 80 } });
});

test('fillMissing 不覆盖用户拖过的位置', () => {
  const next = fillMissing({ a: { x: 7, y: 9 } }, { a: { x: 0, y: 0 } });
  assert.deepEqual(next.a, { x: 7, y: 9 });
});

test('fillMissing 没有新节点时返回同一个对象', () => {
  const current = { a: { x: 1, y: 1 } };
  assert.equal(fillMissing(current, { a: { x: 0, y: 0 } }), current);
});
