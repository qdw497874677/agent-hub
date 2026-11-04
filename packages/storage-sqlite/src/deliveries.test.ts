import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { Delivery } from '@agent-hub/domain';
import { createSqliteDeliveries } from './deliveries.ts';

const row = (id: string, sessionId: string, createdAt: number, over: Partial<Delivery> = {}): Delivery => ({
  id, sessionId, seq: createdAt, kind: 'prompt', payload: { text: id, parts: [] }, state: 'queued', attempt: 0, nextAt: null, lastError: null, createdAt, updatedAt: createdAt, ...over
});

test('送达队列：每个会话只出队首；未送达挡住后面的；重启把 sending 退回 queued；held 能取回', async () => {
  const db = new DatabaseSync(':memory:');
  const q = createSqliteDeliveries(db);
  await q.save(row('a1', 'A', 1, { nextAt: 5 }));
  await q.save(row('a2', 'A', 2));
  await q.save(row('b1', 'B', 3, { state: 'undelivered' }));
  await q.save(row('b2', 'B', 4));
  await q.save(row('c1', 'C', 5, { state: 'sending' }));
  assert.deepEqual((await q.due(4)).map((d) => d.id), []);
  assert.deepEqual((await q.due(5)).map((d) => d.id), ['a1']);
  assert.deepEqual((await q.pendingFor('B')).map((d) => d.id), ['b1', 'b2']);
  assert.equal(await q.recoverSending(10), 1);
  assert.deepEqual((await q.due(10)).map((d) => d.id).sort(), ['a1', 'c1']);
  await q.save(row('a1', 'A', 1, { state: 'delivered' }));
  assert.deepEqual((await q.due(10)).map((d) => d.id).sort(), ['a2', 'c1']);
  await q.save(row('a2', 'A', 2, { nextAt: 999 }));
  assert.equal(await q.wakeAll(20), 1);
  assert.equal((await q.byId('a2'))!.nextAt, 20);
  await q.save(row('h', 'A', 7, { kind: 'handoff_brief', state: 'held', payload: { text: 'brief' } }));
  assert.deepEqual((await q.held('A', 'handoff_brief'))!.payload, { text: 'brief' });
  assert.equal((await q.pendingFor('A')).some((d) => d.id === 'h'), false);
});
