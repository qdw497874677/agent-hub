import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncQueue } from './async-queue.ts';

test('先推后取、先取后推都按顺序交付，close 后结束迭代', async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  const seen: number[] = [];
  const done = (async () => {
    for await (const item of queue) seen.push(item);
  })();
  await Promise.resolve();
  queue.push(2);
  queue.close();
  queue.push(3);
  await done;
  assert.deepEqual(seen, [1, 2]);
});
