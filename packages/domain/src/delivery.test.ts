import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterFailure, retryDelay, DELIVERY_MAX_ATTEMPTS, type Delivery } from './delivery.ts';

test('退避：2s 起倍增，封顶 60s，抖动 ±10%', () => {
  const mid = () => 0.5;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 10].map((a) => retryDelay(a, mid)), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(retryDelay(1, () => 0), 1800);
  assert.equal(retryDelay(6, () => 1), 66000);
});

test('失败 10 次后停在「未送达」，之前都排下一次', () => {
  let d: Delivery = { id: 'd', sessionId: 's', seq: 1, kind: 'prompt', payload: {}, state: 'sending', attempt: 0, nextAt: 0, lastError: null, createdAt: 0, updatedAt: 0 };
  for (let i = 1; i < DELIVERY_MAX_ATTEMPTS; i++) {
    d = afterFailure(d, 'offline', 100, () => 0.5);
    assert.equal(d.state, 'queued');
    assert.ok((d.nextAt ?? 0) > 100);
  }
  d = afterFailure(d, 'offline', 100);
  assert.equal(d.state, 'undelivered');
  assert.equal(d.attempt, 10);
  assert.equal(d.nextAt, null);
});
