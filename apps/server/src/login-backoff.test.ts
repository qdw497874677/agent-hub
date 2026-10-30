import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoginBackoff, delayAfter, MAX_DELAY_MS } from './login-backoff.ts';

test('前 4 次失败不用等；第 5 次起 1s 翻倍，封顶 15 分钟', () => {
  assert.deepEqual([1, 2, 3, 4].map(delayAfter), [0, 0, 0, 0]);
  assert.equal(delayAfter(5), 1000);
  assert.equal(delayAfter(6), 2000);
  assert.equal(delayAfter(7), 4000);
  assert.equal(delayAfter(40), MAX_DELAY_MS);
});

test('退避按 key 记、到点放行、成功清零，从不永久锁', () => {
  let clock = 0;
  const backoff = createLoginBackoff(() => clock);
  for (let i = 0; i < 5; i++) backoff.fail('a@x');
  assert.equal(backoff.wait('a@x'), 1000);
  assert.equal(backoff.wait('b@x'), 0);
  clock += 1000;
  assert.equal(backoff.wait('a@x'), 0);
  for (let i = 0; i < 30; i++) backoff.fail('a@x');
  assert.equal(backoff.wait('a@x'), MAX_DELAY_MS);
  clock += MAX_DELAY_MS;
  assert.equal(backoff.wait('a@x'), 0);
  backoff.succeed('a@x');
  backoff.fail('a@x');
  assert.equal(backoff.wait('a@x'), 0);
});
