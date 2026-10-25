import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOptionWaiters } from './option-waiters.ts';

test('agent 回报了就立刻放行', async () => {
  const waiters = createOptionWaiters(10_000);
  const waiting = waiters.wait('s1');
  waiters.resolve('s1');
  await waiting;
});

test('agent 不回也不挂住请求：超时后放行', async () => {
  const waiters = createOptionWaiters(5);
  const started = Date.now();
  await waiters.wait('s1');
  assert.ok(Date.now() - started >= 4);
});
