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

test('打开画布：放得下就居中适配，放不下就左上对齐、不偏出屏幕', async () => {
  const { openingViewport } = await import('./viewport.ts');
  const limits = { padding: 0.12, minZoom: 0.55, maxZoom: 1 };
  const small = openingViewport({ x: 0, y: 0, width: 300, height: 200 }, { width: 1280, height: 800 }, limits);
  assert.equal(small.zoom, 1);
  assert.equal(small.x, 640 - 150);
  const wide = openingViewport({ x: 100, y: 50, width: 2300, height: 600 }, { width: 390, height: 780 }, limits);
  assert.equal(wide.zoom, 0.55);
  assert.equal(wide.x + 100 * 0.55, 24, '树的左边落在屏幕左边距上');
  assert.equal(wide.y + 50 * 0.55, 24);
});
