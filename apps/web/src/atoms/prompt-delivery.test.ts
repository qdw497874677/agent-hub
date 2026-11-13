import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACK_GRACE_MS,
  heldPromptSeqs,
  nextAckDelay,
  pendingBubbles,
  splitTimeline
} from './prompt-delivery.ts';
import { ACK_TIMEOUT_MS, type PendingPrompt } from './pending-prompt.ts';

type Item = { readonly kind: string; readonly seq: number; readonly text?: string };

const deliveries = (entries: readonly (readonly [number, string])[]): ReadonlyMap<number, { state: string }> =>
  new Map(entries.map(([seq, state]) => [seq, { state }]));

test('排队中的 seq：queued / sending / undelivered 都算，送达或撤回的不算', () => {
  const held = heldPromptSeqs(
    deliveries([
      [4, 'queued'],
      [5, 'sending'],
      [6, 'undelivered'],
      [7, 'delivered'],
      [8, 'cancelled']
    ])
  );
  assert.deepEqual([...held].sort((a, b) => a - b), [4, 5, 6]);
});

test('没有送达状态时是空集合，不误伤任何一条', () => {
  assert.equal(heldPromptSeqs(new Map()).size, 0);
});

test('拆分时间线：只把排队中的 prompt 拿走，其余顺序原样', () => {
  const blocks: Item[] = [
    { kind: 'prompt', seq: 1 },
    { kind: 'text', seq: 2 },
    { kind: 'prompt', seq: 3 },
    { kind: 'tool', seq: 4 },
    { kind: 'prompt', seq: 5 }
  ];
  const { timeline, queued } = splitTimeline(blocks, new Set([3, 5]));
  assert.deepEqual(timeline.map((block) => block.seq), [1, 2, 4]);
  assert.deepEqual(queued.map((block) => block.seq), [3, 5]);
});

test('同一个 seq 上的非 prompt 块永远留在时间线里', () => {
  const blocks: Item[] = [{ kind: 'text', seq: 3 }];
  const { timeline, queued } = splitTimeline(blocks, new Set([3]));
  assert.equal(queued.length, 0);
  assert.equal(timeline.length, 1);
});

test('没东西可拆时返回原数组（下游 memo 不用重算）', () => {
  const blocks: Item[] = [{ kind: 'prompt', seq: 1 }];
  const result = splitTimeline(blocks, new Set());
  assert.equal(result.timeline, blocks);
  assert.equal(result.queued.length, 0);
  // 有 held 但没有一条命中：也还是原数组。
  const other = splitTimeline(blocks, new Set([9]));
  assert.equal(other.timeline, blocks);
  assert.equal(other.queued.length, 0);
});

const pending = (id: string, sentAt = 1_000, state: PendingPrompt['state'] = 'sending'): PendingPrompt => ({
  id,
  text: `话 ${id}`,
  attachments: [],
  state,
  sentAt
});

test('pending 气泡的临时 seq：负数、互不相撞，越早发的越靠前', () => {
  const bubbles = pendingBubbles([pending('a'), pending('b')]);
  assert.deepEqual(bubbles.map((bubble) => bubble.seq), [-1, -2]);
  assert.deepEqual(bubbles.map((bubble) => bubble.prompt.id), ['a', 'b']);
});

test('下次超时取最近的一条；已回执 / 已未送达的不再计时', () => {
  const list = [pending('a', 1_000), pending('b', 3_000), pending('c', 500, 'queued'), pending('d', 500, 'unknown')];
  assert.equal(nextAckDelay(list, 1_000), ACK_TIMEOUT_MS);
  // 全都过了超时点：立刻（0），不是负数。
  assert.equal(nextAckDelay(list, 10_000), 0);
  assert.equal(nextAckDelay([], 1_000), null);
  assert.equal(nextAckDelay([pending('c', 500, 'queued')], 1_000), null);
  // 自定义阈值。
  assert.equal(nextAckDelay([pending('a', 1_000)], 1_200, 500), 300);
});

test('宽限是正的：定时器不会比超时点更早醒', () => {
  assert.ok(ACK_GRACE_MS > 0);
});
