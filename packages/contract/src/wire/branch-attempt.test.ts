import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverToWorkerSchema, workerToServerSchema } from './worker.ts';

test('keyed branch frames retain bounded attempt ids and reject unsupported outcomes or reason data', () => {
  const start = { kind: 'start_session', sessionId: 's1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' }, resume: null, options: {}, branch: { fromAgentSessionRef: 'parent', turnRef: null, previousTurnRef: null } };
  const keyed = { ...start, branchAttemptId: 'a'.repeat(128) };
  assert.deepEqual(serverToWorkerSchema.parse(keyed), keyed);
  assert.equal(serverToWorkerSchema.safeParse(start).success, true);
  for (const attemptId of ['', 'a'.repeat(129)]) {
    assert.equal(serverToWorkerSchema.safeParse({ ...start, branchAttemptId: attemptId }).success, false);
    assert.equal(workerToServerSchema.safeParse({ type: 'branch_attempt_result', sessionId: 's1', attemptId, outcome: 'native' }).success, false);
  }
  for (const outcome of ['native', 'plain', 'both_failed']) {
    const frame = { type: 'branch_attempt_result', sessionId: 's1', attemptId: 'a', outcome, ...(outcome === 'both_failed' ? {} : { agentSessionRef: 'native-ref' }) };
    assert.deepEqual(workerToServerSchema.parse(frame), frame);
    assert.equal(workerToServerSchema.safeParse({ ...frame, reason: 'private' }).success, false);
  }
  for (const agentSessionRef of ['', '  ', 'pending', ' PENDING ', '界'.repeat(171)]) {
    assert.equal(workerToServerSchema.safeParse({ type: 'branch_attempt_result', sessionId: 's1', attemptId: 'a', outcome: 'native', agentSessionRef }).success, false);
  }
  assert.equal(workerToServerSchema.safeParse({ type: 'branch_attempt_result', sessionId: 's1', attemptId: 'a', outcome: 'plain' }).success, false);
  assert.equal(workerToServerSchema.safeParse({ type: 'branch_attempt_result', sessionId: 's1', attemptId: 'a', outcome: 'both_failed', agentSessionRef: 'x' }).success, false);
  assert.equal(workerToServerSchema.safeParse({ type: 'branch_attempt_result', sessionId: 's1', attemptId: 'a', outcome: 'failed' }).success, false);
  assert.equal(workerToServerSchema.safeParse({ type: 'branch_result', sessionId: 's1', outcome: 'failed', reason: 'legacy' }).success, true);
});
