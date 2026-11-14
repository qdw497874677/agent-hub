import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACK_GRACE_MS,
  heldPromptSeqs,
  markQueued,
  nextAckDelay,
  pendingBubbles
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

test('排队只打标，不改变顺序：块还在原来的位置，只是多了 queued', () => {
  const blocks: Item[] = [
    { kind: 'prompt', seq: 1 },
    { kind: 'text', seq: 2 },
    { kind: 'prompt', seq: 3 },
    { kind: 'tool', seq: 4 },
    { kind: 'prompt', seq: 5 }
  ];
  const marked = markQueued(blocks, new Set([3, 5]));
  // 一条都不许挪位置：以前排队中的消息会被抽到输入框上方，来回跳三次。
  assert.deepEqual(marked.map((block) => block.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(marked.map((block) => block.kind), ['prompt', 'text', 'prompt', 'tool', 'prompt']);
  assert.deepEqual(marked.map((block) => block.queued === true), [false, false, true, false, true]);
  // 打了标的块只多一个字段，正文照旧。
  assert.equal(marked[2]!.text, blocks[2]!.text);
});

test('同一个 seq 上的非 prompt 块不打标', () => {
  const blocks: Item[] = [{ kind: 'text', seq: 3 }, { kind: 'prompt', seq: 3 }];
  const marked = markQueued(blocks, new Set([3]));
  assert.equal(marked[0]!.queued, undefined);
  assert.equal(marked[1]!.queued, true);
});

test('没东西可标时返回原数组（下游 memo 不用重算）', () => {
  const blocks: Item[] = [{ kind: 'prompt', seq: 1 }];
  assert.equal(markQueued(blocks, new Set()), blocks);
  // 有 held 但没有一条命中：也还是原数组。
  assert.equal(markQueued(blocks, new Set([9])), blocks);
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
