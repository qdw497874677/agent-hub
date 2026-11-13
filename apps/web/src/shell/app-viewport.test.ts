import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleViewport } from './app-viewport.ts';

test('visibleViewport：不认识 visualViewport 时退回布局视口（等同旧的 100dvh）', () => {
  assert.deepEqual(visibleViewport(null, 844), { height: 844, offsetTop: 0 });
});

test('visibleViewport：键盘把可视区压矮，shell 跟着变矮', () => {
  // Android Chrome：布局视口还是 844，看得见的只剩 420
  assert.deepEqual(visibleViewport({ height: 420, offsetTop: 0, scale: 1 }, 844), {
    height: 420,
    offsetTop: 0
  });
});

test('visibleViewport：浏览器把文档顶上去时把 offsetTop 带出来', () => {
  assert.deepEqual(visibleViewport({ height: 420, offsetTop: 48, scale: 1 }, 844), {
    height: 420,
    offsetTop: 48
  });
  // 负数没有意义：夹到 0
  assert.deepEqual(visibleViewport({ height: 300, offsetTop: -12, scale: 1 }, 844), {
    height: 300,
    offsetTop: 0
  });
});

test('visibleViewport：双指放大不跟着缩，退回布局高度', () => {
  assert.deepEqual(visibleViewport({ height: 200, offsetTop: 60, scale: 2.4 }, 844), {
    height: 844,
    offsetTop: 0
  });
  // 1.0 附近的舍入不算放大
  assert.deepEqual(visibleViewport({ height: 840, offsetTop: 0, scale: 1.004 }, 844), {
    height: 840,
    offsetTop: 0
  });
});

test('visibleViewport：高度读不到（0 / NaN）时不把整页压没', () => {
  assert.deepEqual(visibleViewport({ height: 0 }, 844), { height: 844, offsetTop: 0 });
  assert.deepEqual(visibleViewport({ height: Number.NaN }, 844), { height: 844, offsetTop: 0 });
  assert.deepEqual(visibleViewport({ height: 420 }, Number.NaN), { height: 420, offsetTop: 0 });
  assert.deepEqual(visibleViewport({ height: 420 }, 0), { height: 420, offsetTop: 0 });
});

test('visibleViewport：只往小里收，缩小页面时不超过布局视口', () => {
  // 缩小到 0.8 倍时 visualViewport 比布局视口还「高」，照着排会排到文档外面
  assert.deepEqual(visibleViewport({ height: 1050, scale: 0.8 }, 844), { height: 844, offsetTop: 0 });
  // 1px 的取整误差也不该把 shell 撑出视口
  assert.deepEqual(visibleViewport({ height: 845, scale: 1 }, 844), { height: 844, offsetTop: 0 });
});
