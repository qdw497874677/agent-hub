import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY, closeWindow, focusWindow, focused, keepOnly, layoutWindows, minimizeWindow, minimized, moveWindow, openWindow,
  parseWindowSet, restoreWindow, retile, tileCapacity, tileWindows, toggleMaximize, type Rect
} from './canvas-windows.ts';

const wide: Rect = { x: 0, y: 0, width: 1400, height: 800 };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (r: Rect, area: Rect) => r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height;

test('tileWindows：1–4 个互不重叠、都在区域内、不小于最小尺寸', () => {
  for (let n = 1; n <= 4; n++) {
    const rects = tileWindows(wide, n);
    assert.equal(rects.length, n);
    for (const r of rects) {
      assert.ok(inside(r, wide), `${n} 个时出界`);
      assert.ok(r.width >= 360 && r.height >= 320, `${n} 个时太小`);
    }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) assert.ok(!overlaps(rects[i]!, rects[j]!), `${n} 个时 ${i}/${j} 重叠`);
  }
});

test('tileWindows：一个靠右、宽 min(720, 55%)，左边留给画布', () => {
  const [one] = tileWindows(wide, 1);
  assert.equal(one!.width, 720);
  assert.equal(one!.x + one!.width, 1400);
  const [narrow] = tileWindows({ x: 10, y: 20, width: 1000, height: 600 }, 1);
  assert.equal(narrow!.width, 550);
  assert.equal(narrow!.x, 10 + 1000 - 550);
});

test('tileWindows：2 个左右两列，3 个左一大右两小，4 个 2×2', () => {
  const two = tileWindows(wide, 2);
  assert.equal(two[0]!.height, 800);
  assert.equal(two[0]!.y, two[1]!.y);
  const three = tileWindows(wide, 3);
  assert.equal(three[0]!.height, 800);
  assert.equal(three[1]!.x, three[2]!.x);
  const four = tileWindows(wide, 4);
  assert.equal(new Set(four.map((r) => r.x)).size, 2);
  assert.equal(new Set(four.map((r) => r.y)).size, 2);
});

test('tileWindows：区域小就少放；超过 4 个只放 4 个', () => {
  assert.equal(tileWindows(wide, 9).length, 4);
  assert.equal(tileCapacity({ width: 700, height: 800 }), 2); // 一列两行
  const stacked = tileWindows({ x: 0, y: 0, width: 700, height: 800 }, 3);
  assert.equal(stacked.length, 2);
  assert.ok(!overlaps(stacked[0]!, stacked[1]!));
  assert.equal(tileCapacity({ width: 390, height: 500 }), 1);
  assert.equal(tileWindows({ x: 0, y: 0, width: 390, height: 500 }, 3).length, 1);
  assert.deepEqual(tileWindows(wide, 0), []);
});

test('打开：同一会话不重复开，再开 = 聚焦；超过容量最久没聚焦的最小化', () => {
  let set = EMPTY;
  for (const id of ['a', 'b', 'c', 'd', 'e']) set = openWindow(set, id, 4);
  assert.equal(set.windows.length, 5);
  assert.deepEqual(minimized(set).map((w) => w.sessionId), ['a']);
  set = openWindow(set, 'b', 4);
  assert.equal(set.windows.length, 5);
  assert.equal(focused(set)!.sessionId, 'b');
  set = openWindow(set, 'a', 4); // 恢复 a，挤掉最久没聚焦的 c
  assert.deepEqual(minimized(set).map((w) => w.sessionId), ['c']);
  assert.equal(focused(set)!.sessionId, 'a');
});

test('聚焦、最小化、恢复、关闭、最大化', () => {
  let set = openWindow(openWindow(EMPTY, 'a', 4), 'b', 4);
  set = focusWindow(set, 'a');
  assert.equal(focused(set)!.sessionId, 'a');
  set = minimizeWindow(set, 'a');
  assert.equal(focused(set)!.sessionId, 'b');
  set = restoreWindow(set, 'a', 4);
  assert.equal(set.windows.find((w) => w.sessionId === 'a')!.mode, 'tiled');
  set = toggleMaximize(set, 'b', 4);
  assert.deepEqual(layoutWindows(set, wide).get('b'), wide);
  set = toggleMaximize(set, 'b', 4);
  assert.equal(set.windows.find((w) => w.sessionId === 'b')!.mode, 'tiled');
  set = closeWindow(set, 'a');
  assert.deepEqual(set.windows.map((w) => w.sessionId), ['b']);
});

test('拖过变自由：按比例存，区域变了等比还原并夹回区域；重新平铺恢复', () => {
  let set = openWindow(openWindow(EMPTY, 'a', 4), 'b', 4);
  set = moveWindow(set, 'a', { x: 100, y: 100, width: 500, height: 400 }, wide);
  assert.equal(set.windows.find((w) => w.sessionId === 'a')!.mode, 'free');
  assert.deepEqual(layoutWindows(set, wide).get('a'), { x: 100, y: 100, width: 500, height: 400 });
  const half: Rect = { x: 0, y: 0, width: 700, height: 400 };
  assert.deepEqual(layoutWindows(set, half).get('a'), { x: 50, y: 50, width: 360, height: 240 });
  // 只剩 b 参与平铺：一个靠右
  assert.equal(layoutWindows(set, wide).get('b')!.width, 720);
  set = minimizeWindow(set, 'a');
  set = restoreWindow(set, 'a', 4);
  assert.equal(set.windows.find((w) => w.sessionId === 'a')!.mode, 'free', '自由窗口最小化后恢复回自由');
  set = retile(set, 4);
  assert.ok(set.windows.every((w) => w.mode === 'tiled'));
  const rects = [...layoutWindows(set, wide).values()];
  assert.equal(rects.length, 2);
  assert.ok(!overlaps(rects[0]!, rects[1]!));
});

test('平铺按打开顺序分格，聚焦不让窗口换位置', () => {
  let set = openWindow(openWindow(EMPTY, 'a', 4), 'b', 4);
  const before = layoutWindows(set, wide);
  set = focusWindow(set, 'a');
  assert.deepEqual(layoutWindows(set, wide), before);
});

test('会话没了就丢掉；坏存档当没有', () => {
  const set = openWindow(openWindow(EMPTY, 'a', 4), 'b', 4);
  assert.deepEqual(keepOnly(set, (id) => id === 'b').windows.map((w) => w.sessionId), ['b']);
  assert.equal(keepOnly(set, () => true), set);
  assert.deepEqual(parseWindowSet(JSON.stringify(set)), set);
  assert.deepEqual(parseWindowSet('{oops'), EMPTY);
  assert.deepEqual(parseWindowSet(null), EMPTY);
  assert.deepEqual(parseWindowSet(JSON.stringify({ windows: [{ sessionId: 'x', mode: 'free', z: 1 }, { sessionId: 'x', mode: 'min', z: 2 }, { mode: 'tiled' }] })).windows, [
    { sessionId: 'x', mode: 'tiled', z: 1 }
  ]);
});
