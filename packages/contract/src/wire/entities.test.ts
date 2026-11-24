import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journalEntrySchema, sessionEventSchema } from './entities.ts';

test('text first-output delivery id survives wire decoding with ended delivery bounds', () => {
  const event = { kind: 'text', delta: 'hello', firstOutputDeliveryId: 'd'.repeat(128) };
  assert.deepEqual(sessionEventSchema.parse(event), event);
  assert.deepEqual(journalEntrySchema.parse({ seq: 1, at: 2, event }), { seq: 1, at: 2, event });
  assert.deepEqual(sessionEventSchema.parse({ kind: 'text', delta: 'old' }), { kind: 'text', delta: 'old' });
  for (const id of ['', 'd'.repeat(129)]) {
    assert.equal(sessionEventSchema.safeParse({ kind: 'text', delta: 'hello', firstOutputDeliveryId: id }).success, false);
    assert.equal(sessionEventSchema.safeParse({ kind: 'ended', outcome: 'done', deliveryId: id }).success, false);
  }
});
