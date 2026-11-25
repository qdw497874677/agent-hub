import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerToServerSchema } from './worker.ts';

test('keyed ready proof is optional, bounded and absent on non-ready frames', () => {
  const base = { type: 'session_start_result', sessionId: 's', startAttemptId: 'a' };
  const option = { id: 'model', label: 'Model', category: 'model', kind: 'select', current: 'one', choices: [] };
  const old = workerToServerSchema.parse({ ...base, state: 'ready' });
  assert.deepEqual(old, { ...base, state: 'ready' });
  const ready = workerToServerSchema.parse({ ...base, state: 'ready', agentSessionRef: 'native', options: [option] });
  assert.deepEqual(ready, { ...base, state: 'ready', agentSessionRef: 'native', options: [option] });
  for (const ref of ['pending', '   ', 'x'.repeat(513)]) assert.equal(workerToServerSchema.safeParse({ ...base, state: 'ready', agentSessionRef: ref }).success, false);
  assert.equal(workerToServerSchema.safeParse({ ...base, state: 'ready', options: Array(65).fill(option) }).success, false);
  assert.equal(workerToServerSchema.safeParse({ ...base, state: 'ready', options: [{ ...option, id: 'x'.repeat(2049) }] }).success, false);
  assert.equal(workerToServerSchema.safeParse({ ...base, state: 'ready', options: Array(40).fill({ ...option, id: '界'.repeat(1000) }) }).success, false);
  assert.deepEqual(workerToServerSchema.parse({ ...base, state: 'failed', agentSessionRef: 'native', options: [option] }), { ...base, state: 'failed' });
  assert.deepEqual(workerToServerSchema.parse({ ...base, state: 'ended', agentSessionRef: 'native', options: [option] }), { ...base, state: 'ended' });
});
