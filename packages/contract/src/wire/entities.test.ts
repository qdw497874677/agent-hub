import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journalEntrySchema, lineageEdgeSchema, sessionEventSchema, sessionOriginSchema } from './entities.ts';
import { forkSessionRequest } from './http.ts';
import { serverToWorkerSchema } from './worker.ts';

test('ended uncertainty is additive and only literal true is accepted', () => {
  for (const event of [
    { kind: 'ended', outcome: 'interrupted', reason: 'outcome_unknown' },
    { kind: 'ended', outcome: 'interrupted', outcomeUnknown: true },
    { kind: 'ended', outcome: 'done', deliveryId: 'd', outcomeUnknown: true }
  ]) {
    assert.deepEqual(sessionEventSchema.parse(event), event);
    assert.deepEqual(journalEntrySchema.parse({ seq: 1, at: 2, event }).event, event);
  }
  for (const outcomeUnknown of [false, null, 1, 'true']) {
    assert.equal(sessionEventSchema.safeParse({ kind: 'ended', outcome: 'interrupted', outcomeUnknown }).success, false);
  }
});

test('first-prompt fork sequence zero is accepted as origin and lineage, but not a requested fork', () => {
  const start = { kind: 'start_session', sessionId: 'child', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', resume: null, options: {} };
  for (const atSeq of [0, 1, 42]) {
    const origin = { kind: 'fork', fromSessionId: 'parent', atSeq };
    const edge = { kind: 'fork', fromSessionId: 'parent', toSessionId: 'child', atSeq };
    assert.deepEqual(sessionOriginSchema.parse(origin), origin);
    assert.deepEqual(lineageEdgeSchema.parse(edge), edge);
    const frame = serverToWorkerSchema.parse({ ...start, origin });
    assert.equal(frame.kind, 'start_session');
    if (frame.kind === 'start_session') assert.deepEqual(frame.origin, origin);
  }
  for (const atSeq of [-1, 0.5]) {
    const origin = { kind: 'fork', fromSessionId: 'parent', atSeq };
    assert.equal(sessionOriginSchema.safeParse(origin).success, false);
    assert.equal(lineageEdgeSchema.safeParse({ ...origin, toSessionId: 'child' }).success, false);
    assert.equal(serverToWorkerSchema.safeParse({ ...start, origin }).success, false);
  }
  const request = { sessionId: 'parent', agentId: 'echo', model: '' };
  assert.equal(forkSessionRequest.safeParse({ ...request, atSeq: 0 }).success, false);
  assert.equal(forkSessionRequest.safeParse({ ...request, atSeq: 1 }).success, true);
});

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

test('text provenance is optional, constrained, and retained through wire parsing', () => {
  for (const textOrigin of ['main_assistant', 'other'] as const) {
    const event = { kind: 'text', delta: 'hello', textOrigin };
    assert.deepEqual(sessionEventSchema.parse(event), event);
    assert.deepEqual(journalEntrySchema.parse({ seq: 1, at: 2, event }).event, event);
  }
  assert.deepEqual(sessionEventSchema.parse({ kind: 'text', delta: 'legacy', role: 'assistant' }), { kind: 'text', delta: 'legacy' });
  for (const textOrigin of ['assistant', '', null, 1]) {
    assert.equal(sessionEventSchema.safeParse({ kind: 'text', delta: 'hello', textOrigin }).success, false);
  }
});
