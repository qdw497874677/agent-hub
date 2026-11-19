import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_FADE, FOLLOW_SLACK, edgeMask, hiddenBelow, riseFrom } from './thinking-window.ts';

test('还没有藏起来的内容：两侧都不渐隐，算出的是两条贴边的硬边', () => {
  assert.equal(edgeMask(0, 0), 'linear-gradient(to bottom, rgb(0 0 0 / 0) 0, black 0px, black calc(100% - 0px), rgb(0 0 0 / 0) 100%)');
});

test('渐隐随隐藏量张开，到 FADE 就不再多', () => {
  assert.match(edgeMask(14, 0), /black 14px, black calc\(100% - 0px\)/);
  assert.match(edgeMask(0, 21), /black 0px, black calc\(100% - 21px\)/);
  assert.match(edgeMask(500, 500), new RegExp(`black ${EDGE_FADE}px, black calc\\(100% - ${EDGE_FADE}px\\)`));
});

test('两侧各自独立：上面翻回去了，下面那一侧照样渐隐', () => {
  const mask = edgeMask(6, 28);

  assert.match(mask, /black 6px/);
  assert.match(mask, /calc\(100% - 28px\)/);
});

test('负数隐藏量当 0：滚过头的亚像素不该算出反向渐变', () => {
  assert.equal(edgeMask(-4, -2), edgeMask(0, 0));
});

test('窗口底下还藏着多少', () => {
  assert.equal(hiddenBelow(500, 208, 0), 292);
  assert.equal(hiddenBelow(500, 208, 200), 92);
  // 已经到底（滚过头）不返回负数。
  assert.equal(hiddenBelow(500, 208, 999), 0);
  assert.equal(FOLLOW_SLACK, 8);
});

test('这一滑接着上一滑的位移走：快流是连续滑行，不是每行顿一下', () => {
  assert.equal(riseFrom(0, 22), 22);
  assert.equal(riseFrom(12, 22), 34);
});
