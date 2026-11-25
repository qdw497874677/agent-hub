import { test } from 'node:test';
import assert from 'node:assert/strict';
import { available, capabilityMatrix } from '../capability.ts';
import { asAgentId } from '../ids.ts';
import type { BranchAttempt } from '../ports/branch-attempt.ts';
import { inMemoryDeliveries, inMemoryDeps } from '../testing/in-memory.ts';
import { ingestAgentSessionRef, promptSessionUseCase, workerAttached } from './conversation.ts';
import { attemptDelivery } from './delivery.ts';
import { ensureHosted } from './hosting.ts';
import { createProjectUseCase } from './projects.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { createTaskUseCase } from './tasks.ts';
import { admitBranchSession } from './branch-admission.ts';
import type { Session } from '../session.ts';

async function world() {
  const w = inMemoryDeps();
  w.agents.push({
    id: asAgentId('fake'), label: 'Fake', models: ['m1'], defaultModel: 'm1', options: [],
    capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available })
  });
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  const attempts = new Map<string, BranchAttempt>();
  const branchAttempts = { bySession: async (id: string) => attempts.get(id) ?? null };
  const deliveries = inMemoryDeliveries();
  const deps = { ...w.deps, deliveries, branchAttempts };
  return { ...w, deps, deliveries, attempts, session: session.value };
}

function attempt(sessionId: string, state: BranchAttempt['state']): BranchAttempt {
  return { id: 'attempt-1', sessionId, workerId: 'worker-1', brief: {} as BranchAttempt['brief'], state, createdAt: 0, updatedAt: 0 };
}

test('unresolved persisted branch blocks prompts and hosting even after restart, without side effects', async () => {
  const w = await world();
  const sid = w.session.id;
  w.attempts.set(sid, attempt(sid, 'pending'));
  const beforeEvents = await w.deps.sessions.eventsAfter(sid, 0 as never);
  const beforeDispatches = w.dispatched.length;
  // A new dependency object models a restarted process reading the same durable attempts.
  const restarted = { ...w.deps, branchAttempts: { bySession: w.deps.branchAttempts.bySession } };
  const prompt = await promptSessionUseCase(restarted, { sessionId: sid, text: 'ordinary', clientMessageId: 'retry' });
  assert.ok(!prompt.ok && prompt.error.code === 'conflict');
  const hosted = await ensureHosted(restarted, w.session);
  assert.ok(!hosted.ok && hosted.error.code === 'conflict');
  w.deps.hosting.drop(sid);
  const rehost = await ensureHosted(restarted, w.session);
  assert.ok(!rehost.ok && rehost.error.code === 'conflict');
  assert.deepEqual(await w.deps.sessions.eventsAfter(sid, 0 as never), beforeEvents);
  assert.deepEqual(await w.deliveries.recent(sid, 10), []);
  assert.equal(w.dispatched.length, beforeDispatches);
});

test('failed branch blocks; exact native and plain outcomes permit use; duplicate prompt is only acknowledged', async () => {
  const w = await world();
  const sid = w.session.id;
  w.attempts.set(sid, attempt(sid, 'both_failed'));
  const failed = await promptSessionUseCase(w.deps, { sessionId: sid, text: 'no' });
  assert.ok(!failed.ok && failed.error.code === 'conflict');
  assert.ok(!(await ensureHosted(w.deps, w.session)).ok);
  for (const state of ['native', 'plain'] as const) {
    await w.deps.sessions.save({ ...w.session, agentSessionRef: 'child-ref' });
    w.attempts.set(sid, { ...attempt(sid, state), workerId: w.session.workerId!, settledAgentSessionRef: 'child-ref' });
    assert.ok((await ensureHosted(w.deps, w.session)).ok);
  }
  const first = await promptSessionUseCase(w.deps, { sessionId: sid, text: 'yes', clientMessageId: 'same' });
  assert.ok(first.ok);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const before = w.dispatched.length;
  w.attempts.set(sid, attempt(sid, 'pending'));
  const duplicate = await promptSessionUseCase(w.deps, { sessionId: sid, text: 'yes', clientMessageId: 'same' });
  assert.ok(duplicate.ok);
  assert.equal(duplicate.value.seq, first.value.seq);
  assert.equal(w.dispatched.length, before);
  assert.equal((await w.deliveries.recent(sid, 10)).length, 1);
});

test('unattested reference frames cannot settle or overwrite a branch, and unknown children are not adopted', async () => {
  const w = await world();
  const sid = w.session.id;
  const workerId = w.session.workerId!;
  w.deps.hosting.drop(sid);
  w.attempts.set(sid, attempt(sid, 'pending'));
  await ingestAgentSessionRef(w.deps, sid, 'unattested');
  assert.equal((await w.deps.sessions.byId(sid))?.agentSessionRef, null);
  assert.deepEqual(await workerAttached(w.deps, workerId, [sid]), []);
  await w.deps.sessions.save({ ...w.session, agentSessionRef: 'attested' });
  w.attempts.set(sid, { ...attempt(sid, 'plain'), workerId, settledAgentSessionRef: 'attested' });
  await ingestAgentSessionRef(w.deps, sid, 'late-unattested');
  assert.equal((await w.deps.sessions.byId(sid))?.agentSessionRef, 'attested');
  assert.deepEqual(await workerAttached(w.deps, workerId, [sid]), [sid]);
});

test('settled branch requires matching durable valid child proof, ordinary sessions remain admitted', async () => {
  const w = await world();
  const sid = w.session.id;
  assert.ok((await admitBranchSession(w.deps, sid)).ok);
  for (const state of ['native', 'plain'] as const) {
    for (const proof of [undefined, '', ' pending ', ' PeNdInG ', '界'.repeat(171), 'other']) {
      await w.deps.sessions.save({ ...w.session, agentSessionRef: proof === 'other' || proof === undefined ? 'child' : proof });
      w.attempts.set(sid, { ...attempt(sid, state), workerId: w.session.workerId!, settledAgentSessionRef: proof });
      const result = await admitBranchSession(w.deps, sid);
      assert.ok(!result.ok && result.error.code === 'unavailable');
    }
    w.attempts.set(sid, { ...attempt(sid, state), workerId: w.session.workerId!, settledAgentSessionRef: 'child' });
    await w.deps.sessions.save({ ...w.session, agentSessionRef: null });
    assert.ok(!(await admitBranchSession(w.deps, sid)).ok);
  }
});

test('hosting uses the proven persisted branch snapshot instead of stale caller data', async () => {
  for (const state of ['native', 'plain'] as const) {
    for (const staleRef of [null, 'wrong-ref'] as const) {
      for (const alreadyHosted of [false, true]) {
        const w = await world();
        const sid = w.session.id;
        const persisted = { ...w.session, agentSessionRef: 'proven-child', environmentRevision: 'old', lastSeq: 7 };
        await w.deps.sessions.save(persisted);
        w.attempts.set(sid, { ...attempt(sid, state), workerId: w.session.workerId!, settledAgentSessionRef: 'proven-child' });
        const admitted = await admitBranchSession(w.deps, sid);
        assert.ok(admitted.ok && admitted.value?.agentSessionRef === 'proven-child');
        if (!alreadyHosted) w.deps.hosting.drop(sid);
        let revisionRef: string | null | undefined;
        const deps = { ...w.deps, environment: { revision: async (session: Session) => { revisionRef = session.agentSessionRef; return 'new'; }, prepare: async (command: import('../ports/node-gateway.ts').WorkerCommand) => ({ command, revision: null }) } };
        const before = w.dispatched.length;
        assert.ok((await ensureHosted(deps, { ...w.session, agentSessionRef: staleRef, environmentRevision: 'new' })).ok);
        assert.equal(revisionRef, 'proven-child');
        const start = w.dispatched.slice(before).find((command) => command.kind === 'start_session');
        assert.ok(start?.kind === 'start_session');
        assert.deepEqual(start.resume, { agentSessionRef: 'proven-child', cursor: 7 });
        assert.equal((await w.deps.sessions.byId(sid))?.agentSessionRef, 'proven-child');
      }
    }
  }
});

test('lookup errors fail closed without exposing database details or claiming deliveries', async () => {
  const w = await world();
  const sid = w.session.id;
  const broken = { ...w.deps, branchAttempts: { bySession: async () => { throw new Error('secret database detail'); } } };
  const prompt = await promptSessionUseCase(broken, { sessionId: sid, text: 'no' });
  assert.ok(!prompt.ok && prompt.error.code === 'unavailable');
  assert.doesNotMatch(prompt.error.message, /secret/);
  const hosted = await ensureHosted(broken, w.session);
  assert.ok(!hosted.ok && hosted.error.code === 'unavailable');
  const row = { id: 'queued', sessionId: sid, seq: 1, kind: 'prompt' as const, payload: { text: 'queued', parts: [] }, state: 'queued' as const, attempt: 0, nextAt: 0, lastError: null, createdAt: 0, updatedAt: 0 };
  await w.deliveries.save(row);
  const before = w.dispatched.length;
  for (const state of ['pending', 'both_failed'] as const) {
    w.attempts.set(sid, attempt(sid, state));
    const blocked = await attemptDelivery(w.deps, row);
    assert.ok(!blocked.ok && blocked.error.code === 'conflict');
    assert.deepEqual(await w.deliveries.byId(row.id), row);
  }
  const sent = await attemptDelivery(broken, row);
  assert.ok(!sent.ok && sent.error.code === 'unavailable');
  assert.deepEqual(await w.deliveries.byId(row.id), row);
  assert.equal(w.dispatched.length, before);
});
