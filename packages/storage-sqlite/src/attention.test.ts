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
