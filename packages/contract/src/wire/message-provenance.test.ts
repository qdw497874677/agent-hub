import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { id } from './common.ts';
import { promptPartSchema, sessionEventSchema } from './entities.ts';
import { serverToWorkerSchema, startAttemptIdSchema } from './worker.ts';

const origin = { kind: 'agent_message', messageId: 'm', messageKind: 'ask', initiator: 'account', sender: 'session', sourceSessionId: 'private' } as const;

test('wire validates provenance and projects safe journal source', () => {
  const frame = { kind: 'prompt', sessionId: 's', text: 'wrapped', parts: [], deliveryId: 'd', messageOrigin: origin };
  assert.deepEqual(serverToWorkerSchema.parse(frame), frame);
  assert.equal(serverToWorkerSchema.safeParse({ ...frame, messageOrigin: { ...origin, initiator: 'secret' } }).success, false);
  assert.equal(serverToWorkerSchema.safeParse({ ...frame, messageOrigin: { ...origin, messageId: '' } }).success, false);
  const event = sessionEventSchema.parse({ kind: 'prompt', text: 'body', messageSource: origin });
  assert.equal(event.kind, 'prompt');
  assert.ok(event.kind === 'prompt');
  assert.equal('sourceSessionId' in event.messageSource!, false);
  assert.equal(sessionEventSchema.safeParse({ kind: 'prompt', text: 'body', messageSource: { ...origin, sender: 'secret' } }).success, false);
});

test('pre-provenance prompt schema strips additive origin without changing delivery fields', () => {
  // Exact prompt branch from protocol 7 before provenance (da9ec6db).
  const oldPrompt = z.object({ kind: z.literal('prompt'), sessionId: id, text: z.string(), parts: z.array(promptPartSchema).default([]), deliveryId: z.string().max(128).optional(), startAttemptId: startAttemptIdSchema.optional() });
  const parts = [{ kind: 'mention', name: 'a', path: '/a' }];
  const frame = { kind: 'prompt', sessionId: 's', text: 'wrapper\n', parts, deliveryId: 'd', startAttemptId: 'a', messageOrigin: origin };
  assert.deepEqual(oldPrompt.parse(frame), { kind: 'prompt', sessionId: 's', text: frame.text, parts, deliveryId: 'd', startAttemptId: 'a' });
});
