import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange, FRAME, findOverlaps, frameRect, landsInForeignFrame, LAYOUT, placeMissing, shiftFrame, type LayoutInput, type Size } from './layout.ts';

const sizes: Record<string, Size> = {
  t1: { width: 220, height: 140 },
  t2: { width: 220, height: 140 },
  a: { width: 440, height: 600 }, // 拖大过的卡
  b: { width: 320, height: 480 },
  f: { width: 320, height: 480 }
};
const sizeOf = (id: string): Size => sizes[id] ?? { width: 320, height: 480 };
const input: LayoutInput = {
  tasks: [{ id: 't1' }, { id: 't2' }],
  sessions: [
    { id: 'a', taskId: 't1', origin: { kind: 'derive' } },
    { id: 'b', taskId: 't1', origin: { kind: 'derive' } },
    { id: 'f', taskId: 't1', origin: { kind: 'fork', fromSessionId: 'a' } },
    { id: 'c', taskId: 't2', origin: { kind: 'derive' } }
  ]
};
const rects = (points: Record<string, { x: number; y: number }>) =>
  Object.fromEntries(Object.entries(points).map(([id, p]) => [id, { ...p, ...sizeOf(id) }]));

test('arrange：派生挂在任务右边，分叉挂在来源右边，按真实尺寸不重叠', () => {
  const placed = arrange(input, sizeOf);
  assert.equal(placed['a']?.x, LAYOUT.originX + 220 + LAYOUT.gapX + FRAME.pad);
  assert.equal(placed['f']?.x, (placed['a']?.x ?? 0) + 440 + LAYOUT.gapX);
  assert.equal(placed['f']?.y, placed['a']?.y);
  assert.ok((placed['b']?.y ?? 0) >= (placed['a']?.y ?? 0) + 600);
  assert.deepEqual(findOverlaps(rects(placed)), []);
});

test('placeMissing：新节点压到已有的卡就往下挪，已有位置不动', () => {
  const current = { t1: { x: 80, y: 80 }, a: { x: 396, y: 80 } };
  const next = placeMissing(current, { ...current, b: { x: 396, y: 100 } }, sizeOf);
  assert.deepEqual(next['a'], { x: 396, y: 80 });
  assert.deepEqual(findOverlaps(rects(next)), []);
});

test('placeMissing：没有新节点时返回同一个对象', () => {
  const current = { a: { x: 1, y: 1 } };
  assert.equal(placeMissing(current, { a: { x: 0, y: 0 } }, sizeOf), current);
});

test('arrange：分叉成环或来源缺失也不会死循环', () => {
  const placed = arrange(
    { tasks: [], sessions: [{ id: 'x', taskId: 'gone', origin: { kind: 'fork', fromSessionId: 'missing' } }] },
    sizeOf
  );
  assert.ok(placed['x']);
});

test('arrange：同一台 worker 的会话排在一个框里，框和框、框和任务都不重叠', () => {
  const multi: LayoutInput = {
    tasks: [{ id: 't1' }, { id: 't2' }],
    sessions: [
      { id: 'a', taskId: 't1', origin: { kind: 'derive' }, workerId: 'w1' },
      { id: 'b', taskId: 't1', origin: { kind: 'derive' }, workerId: 'w2' },
      { id: 'f', taskId: 't1', origin: { kind: 'fork', fromSessionId: 'a' }, workerId: 'w1' },
      { id: 'c', taskId: 't2', origin: { kind: 'derive' }, workerId: 'w1' },
      { id: 'g', taskId: 't2', origin: { kind: 'fork', fromSessionId: 'c' }, workerId: 'w2' }
    ]
  };
  const placed = arrange(multi, sizeOf);
  const w1 = frameRect(['a', 'f', 'c'], placed, sizeOf)!;
  const w2 = frameRect(['b', 'g'], placed, sizeOf)!;
  assert.deepEqual(findOverlaps({ w1, w2, t1: { ...placed['t1']!, ...sizeOf('t1') }, t2: { ...placed['t2']!, ...sizeOf('t2') } }), []);
  assert.deepEqual(findOverlaps(rects(placed)), []);
  // 框里的卡都在框里，别人的卡不在
  for (const id of ['b', 'g']) assert.equal(landsInForeignFrame({ ...placed[id]!, ...sizeOf(id) }, [w1]), false);
  assert.equal(landsInForeignFrame({ ...placed['b']!, ...sizeOf('b') }, [w2]), true);
  // 同框的分叉挂在来源右边；跨框的分叉自己当根
  assert.equal(placed['f']?.y, placed['a']?.y);
  assert.equal(placed['g']?.x, placed['b']?.x);
});

test('shiftFrame：拖框时组里的卡一起平移，别的不动', () => {
  const next = shiftFrame({ a: { x: 0, y: 0 }, b: { x: 10, y: 10 }, t: { x: 5, y: 5 } }, ['a', 'b'], { x: 3, y: -2 });
  assert.deepEqual(next, { a: { x: 3, y: -2 }, b: { x: 13, y: 8 }, t: { x: 5, y: 5 } });
});
