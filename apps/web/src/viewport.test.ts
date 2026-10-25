import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panIntoView } from './viewport.ts';

const screen = { width: 800, height: 600 };

test('panIntoView：完全可见时不动', () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  assert.equal(panIntoView(viewport, { x: 100, y: 100, width: 320, height: 300 }, screen), viewport);
});

test('panIntoView：右边被右栏盖住时左移，刚好露出右下角', () => {
  const next = panIntoView({ x: 0, y: 0, zoom: 1 }, { x: 600, y: 100, width: 320, height: 300 }, screen);
  assert.deepEqual(next, { x: -144, y: 0, zoom: 1 });
});

test('panIntoView：按缩放换算；比屏幕还大就让左上角对齐', () => {
  const next = panIntoView({ x: 0, y: 0, zoom: 0.5 }, { x: 1400, y: 1000, width: 320, height: 200 }, screen);
  assert.deepEqual(next, { x: -(700 + 160 - 776), y: -(500 + 100 - 576), zoom: 0.5 });
  const huge = panIntoView({ x: 0, y: 0, zoom: 1 }, { x: 50, y: 0, width: 2000, height: 100 }, screen);
  assert.equal(huge.x, -26);
});
