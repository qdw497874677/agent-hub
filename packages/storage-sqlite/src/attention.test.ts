import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteAttention } from './attention.ts';

test('attention_ack：重复看只记一条，按账号隔开', async () => {
  const store = createSqliteAttention(new DatabaseSync(':memory:'));
  const now = Date.now();
  await store.ack('u1', { sessionId: 's', phase: 'needs_answer', since: 1 }, now);
  await store.ack('u1', { sessionId: 's', phase: 'needs_answer', since: 1 }, now);
  await store.ack('u1', { sessionId: 's', phase: 'needs_review', since: 2 }, now);
  assert.equal((await store.acks('u1')).length, 2);
  assert.equal((await store.acks('u2')).length, 0);
});

test('attention_ack：重新装配（刷新）还读得回；撤销只删本账号的精确那一条', async () => {
  const db = new DatabaseSync(':memory:');
  const now = Date.now();
  const store = createSqliteAttention(db);
  await store.ack('u1', { sessionId: 's', phase: 'needs_answer', since: 1 }, now);
  await store.ack('u1', { sessionId: 's', phase: 'needs_review', since: 2 }, now);
  await store.ack('u2', { sessionId: 's', phase: 'needs_answer', since: 1 }, now);

  const reopened = createSqliteAttention(db);
  assert.deepEqual(
    (await reopened.acks('u1')).map((a) => `${a.phase}|${a.since}`),
    ['needs_answer|1', 'needs_review|2']
  );

  // 阶段 / 进入时刻对不上 → 不删
  assert.equal(await reopened.unack('u1', { sessionId: 's', phase: 'needs_review', since: 3 }), false);
  // 别的账号的撤销不动 u1 的那条
  assert.equal(await reopened.unack('u2', { sessionId: 's', phase: 'needs_answer', since: 1 }), true);
  assert.equal((await reopened.acks('u1')).length, 2);
  assert.equal((await reopened.acks('u2')).length, 0);
});

test('attention_ack：撤销幂等；迟到的撤销（收据对不上）删不掉后来的重看', async () => {
  const store = createSqliteAttention(new DatabaseSync(':memory:'));
  const now = Date.now();
  const tuple = { sessionId: 's', phase: 'needs_answer' as const, since: 1 };
  const receipt = await store.ack('u1', tuple, now);
  assert.equal(receipt, now);
  // 重复记不刷新收据
  assert.equal(await store.ack('u1', tuple, now + 1), now);

  assert.equal(await store.unack('u1', tuple, receipt + 1), false, '收据对不上');
  assert.equal((await store.acks('u1')).length, 1);
  assert.equal(await store.unack('u1', tuple, receipt), true);
  assert.equal(await store.unack('u1', tuple, receipt), false, '重复撤销是幂等的');
  assert.equal((await store.acks('u1')).length, 0);

  // 撤销后重新记下 → 新收据；迟到的旧收据不能把新的删掉
  const again = await store.ack('u1', tuple, now + 5);
  assert.equal(again, now + 5);
  assert.equal(await store.unack('u1', tuple, receipt), false);
  assert.equal((await store.acks('u1')).length, 1);
  // 不带收据的撤销（按精确元组）仍然可用
  assert.equal(await store.unack('u1', tuple), true);
  assert.equal((await store.acks('u1')).length, 0);
});
