import { test } from 'node:test';
import assert from 'node:assert/strict';
import { available, capabilityMatrix } from '../capability.ts';
import { asAgentId, asSessionId } from '../ids.ts';
import type { AgentHandoffRecord } from '../ports/agent-handoff-store.ts';
import { inMemoryDeliveries, inMemoryDeps } from '../testing/in-memory.ts';
import { promptSessionUseCase, ingestWorkerEvent, ingestAgentSessionRef, workerAttached, workerGone } from './conversation.ts';
import { attemptDelivery, cancelDelivery, pumpDeliveries, releaseAfterTurn, retryDeliveryNow, TURN_WAIT_MS } from './delivery.ts';
import { ensureHosted } from './hosting.ts';
import { handoffFirstEnded } from './handoff-admission.ts';
import { createProjectUseCase } from './projects.ts';
import { deriveSessionUseCase, recordEvent } from './sessions.ts';
import { createTaskUseCase } from './tasks.ts';
import { createMessageBus } from './messaging.ts';

async function world() {
  const w = inMemoryDeps();
  w.agents.push({ id: asAgentId('fake'), label: 'Fake', models: ['m1'], defaultModel: 'm1', options: [], capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available }) });
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  const deliveries = inMemoryDeliveries();
  let record = { reservation: { target: session.value }, first: null, startup: { state: 'pending', workerId: null, attemptId: null, connectionId: null } } as unknown as AgentHandoffRecord;
  let readyAttempt = 'attempt';
  let connection = 'socket';
  const deps = { ...w.deps, deliveries, agentHandoffs: { byTarget: async (id: string) => id === session.value.id ? record : null }, gateway: { ...w.deps.gateway, sessionStartConnection: () => connection, sessionStartReadiness: () => ({ state: 'ready' as const, startAttemptId: readyAttempt }) } };
  const first = { id: 'first', sessionId: session.value.id, seq: 1, kind: 'prompt' as const, payload: { text: 'first', parts: [] }, state: 'queued' as const, attempt: 0, nextAt: 0, lastError: null, createdAt: 0, updatedAt: 0 };
  const admit = async () => {
    const event = await recordEvent(deps, { sessionId: session.value.id, event: { kind: 'prompt', text: 'first' } });
    assert.ok(event.ok);
    await deliveries.save(first);
    await deps.sessions.save({ ...(await deps.sessions.byId(session.value.id))!, agentSessionRef: 'verified-native' });
    record = { ...record, first: { requestKey: 'key', semanticHash: 'hash', event: { kind: 'prompt', text: 'first' }, delivery: first }, startup: { state: 'ready', workerId: session.value.workerId, attemptId: 'attempt', connectionId: 'socket' } };
    deps.hosting.add(session.value.id, session.value.workerId);
  };
  return { ...w, deps, session: session.value, deliveries, first, admit, getRecord: () => record, staleAttempt: () => { readyAttempt = 'stale'; }, resetAttempt: () => { readyAttempt = 'attempt'; }, staleSocket: () => { connection = 'other'; }, resetSocket: () => { connection = 'socket'; } };
}

test('reservation blocks normal ingress, hosting and untrusted worker frames before first', async () => {
  const w = await world();
  const sid = w.session.id;
  const before = await w.deps.sessions.eventsAfter(sid, 0 as never);
  assert.ok(!(await promptSessionUseCase(w.deps, { sessionId: sid, text: 'ordinary' })).ok);
  assert.ok(!(await ensureHosted(w.deps, w.session)).ok);
  await ingestWorkerEvent(w.deps, sid, { kind: 'text', delta: 'untrusted' });
  await ingestAgentSessionRef(w.deps, sid, 'untrusted');
  assert.deepEqual(await workerAttached(w.deps, w.session.workerId!, [sid]), []);
  await workerGone(w.deps, w.session.workerId!);
  assert.deepEqual(await w.deps.sessions.eventsAfter(sid, 0 as never), before);
  assert.equal((await w.deps.sessions.byId(sid))?.agentSessionRef, null);
  assert.deepEqual(await w.deliveries.recent(sid, 20), []);
  const broken = { ...w.deps, agentHandoffs: { byTarget: async () => { throw Error('private'); } } };
  const out = await promptSessionUseCase(broken, { sessionId: sid, text: 'ordinary' });
  assert.ok(!out.ok && out.error.code === 'unavailable');
  assert.doesNotMatch(out.error.message, /private/);
});

test('external bus refuses before first without writes or delivery', async () => {
  const w = await world();
  let effects = 0;
  const bus = createMessageBus({ ...w.deps, messages: { save: async () => { effects++; } } as never, policy: {} as never, principalOf: async () => null, deliver: async () => { effects++; return { ok: true, value: null } as never; }, spawn: async () => { throw Error('unexpected spawn'); } });
  const result = await bus.acceptExternal({ inboxId: 'token', label: 'external', onBehalfOf: 'alice', targetSessionId: w.session.id, kind: 'send', body: 'ordinary' });
  assert.ok(!result.ok && result.error.code === 'conflict');
  assert.equal(effects, 0);
});

test('only exact ready attempt and connection dispatch first; manual retry/cancel cannot bypass', async () => {
  const w = await world();
  await w.admit();
  const initial = w.dispatched.length;
  const queued = await promptSessionUseCase(w.deps, { sessionId: w.session.id, text: 'later' });
  assert.ok(queued.ok && queued.value.deliveryId);
  assert.equal(w.dispatched.length, initial);
  w.deps.hosting.drop(w.session.id);
  await attemptDelivery(w.deps, w.first);
  assert.equal(w.dispatched.length, initial);
  w.deps.hosting.add(w.session.id, w.session.workerId);
  w.staleAttempt();
  await attemptDelivery(w.deps, w.first);
  w.resetAttempt(); w.staleSocket();
  await attemptDelivery(w.deps, w.first);
  assert.equal(w.dispatched.length, initial);
  assert.equal((await w.deliveries.byId('first'))?.state, 'queued');
  assert.ok(!(await retryDeliveryNow(w.deps, 'first')).ok);
  assert.ok(!(await cancelDelivery(w.deps, 'first')).ok);
  w.resetSocket();
  const readySession = (await w.deps.sessions.byId(w.session.id))!;
  await w.deps.sessions.save({ ...readySession, agentSessionRef: null });
  await attemptDelivery(w.deps, w.first);
  assert.equal(w.dispatched.length, initial);
  assert.equal((await w.deliveries.byId('first'))?.state, 'queued');
  await w.deps.sessions.save(readySession);
  await attemptDelivery(w.deps, w.first);
  assert.equal((await w.deliveries.byId('first'))?.state, 'sending');
  assert.equal(w.dispatched.length, initial + 1);
  assert.deepEqual(w.dispatched.at(-1), { kind: 'prompt', sessionId: w.session.id, text: 'first', parts: [], deliveryId: 'first', startAttemptId: 'attempt' });
  await ingestWorkerEvent(w.deps, w.session.id, { kind: 'ended', outcome: 'done', deliveryId: 'first' });
  await w.deliveries.finishSending(w.session.id, 'first', w.deps.now());
  assert.equal(await handoffFirstEnded(w.deps, w.getRecord()), true);
  assert.ok((await ensureHosted(w.deps, w.session)).ok);
  const next = await w.deliveries.byId(queued.value.deliveryId);
  assert.ok(next);
  await attemptDelivery(w.deps, next);
  assert.equal(w.dispatched.at(-1)?.kind, 'prompt');
  assert.equal((await w.deliveries.byId(queued.value.deliveryId))?.state, 'sending');
});

test('ambiguous or mismatched ended evidence never releases protected first', async () => {
  for (const event of [{ kind: 'ended', outcome: 'interrupted', reason: 'outcome_unknown', deliveryId: 'first' }, { kind: 'ended', outcome: 'done', deliveryId: 'other' }] as const) {
    const w = await world();
    await w.admit();
    await recordEvent(w.deps, { sessionId: w.session.id, event });
    await w.deliveries.save({ ...w.first, state: 'delivered' });
    assert.equal(await handoffFirstEnded(w.deps, w.getRecord()), false);
    assert.ok(!(await ensureHosted(w.deps, w.session)).ok);
  }
});

test('ordinary prompt cannot reuse the durable first key beyond the journal replay window', async () => {
  const w = await world();
  await w.admit();
  const sid = w.session.id;
  await recordEvent(w.deps, { sessionId: sid, event: { kind: 'ended', outcome: 'done', deliveryId: 'first' } });
  await w.deliveries.save({ ...w.first, state: 'delivered' });
  for (let i = 0; i < 205; i++) await recordEvent(w.deps, { sessionId: sid, event: { kind: 'text', delta: 'later' } });
  const cursor = (await w.deps.sessions.byId(sid))?.lastSeq;
  const dispatched = w.dispatched.length;
  for (const text of ['first', 'changed']) {
    const result = await promptSessionUseCase(w.deps, { sessionId: sid, clientMessageId: 'key', text });
    assert.ok(!result.ok && result.error.code === 'conflict');
  }
  assert.equal((await w.deps.sessions.byId(sid))?.lastSeq, cursor);
  assert.equal((await w.deliveries.recent(sid, 10)).length, 1);
  assert.equal(w.dispatched.length, dispatched);
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: sid, clientMessageId: 'different', text: 'new prompt' })).ok);
});

test('blocked handoff defers only the current queued head without claiming, and ready wake ignores nextAt', async () => {
  const w = await world();
  await w.admit();
  const now = 10_000;
  let claims = 0;
  const deps = { ...w.deps, now: () => now, deliveries: { ...w.deliveries, claimSend: async (...args: Parameters<typeof w.deliveries.claimSend>) => { claims++; return w.deliveries.claimSend(...args); } } };
  w.staleAttempt();
  const before = w.dispatched.length;
  await attemptDelivery(deps, w.first);
  const deferred = await w.deliveries.byId('first');
  assert.deepEqual(deferred, { ...w.first, nextAt: now + TURN_WAIT_MS, updatedAt: now });
  assert.equal(claims, 0);
  assert.equal(w.dispatched.length, before);
  w.resetAttempt();
  assert.equal(await releaseAfterTurn(deps, w.session.id), true);
  assert.equal(claims, 1);
  assert.equal((await w.deliveries.byId('first'))?.state, 'sending');
  assert.equal(w.dispatched.length, before + 1);
});

test('defer does not overwrite a moved head or a delivery claimed during its read', async () => {
  for (const movement of ['new-head', 'claimed'] as const) {
    const w = await world();
    await w.admit();
    w.staleAttempt();
    let reschedules = 0;
    const deps = { ...w.deps, deliveries: { ...w.deliveries,
      pendingFor: async (sid: string) => {
        if (movement === 'new-head') await w.deliveries.save({ ...w.first, id: 'earlier', seq: 0 });
        const head = await w.deliveries.pendingFor(sid);
        if (movement === 'claimed') await w.deliveries.claimSend('first', 123);
        return head;
      },
      reschedule: async (...args: Parameters<typeof w.deliveries.reschedule>) => { reschedules++; return w.deliveries.reschedule(...args); }
    } };
    await attemptDelivery(deps, w.first);
    assert.equal(reschedules, movement === 'claimed' ? 1 : 0);
    assert.equal((await w.deliveries.byId('first'))?.state, movement === 'claimed' ? 'sending' : 'queued');
    assert.equal((await w.deliveries.byId('first'))?.nextAt, 0);
    assert.equal(w.dispatched.filter((d) => d.kind === 'prompt').length, 0);
  }
});

test('bounded due scan yields to an ordinary session after 50 unresolved handoffs, including unknown ended', async () => {
  const w = await world();
  const now = 10_000;
  const records = new Map<string, AgentHandoffRecord>();
  const deliveries = { ...w.deliveries, due: async (at: number) => (await w.deliveries.due(at)).slice(0, 50) };
  const deps = { ...w.deps, now: () => now, deliveries, agentHandoffs: { byTarget: async (id: string) => records.get(id) ?? null } };
  for (let i = 0; i < 50; i++) {
    const sid = asSessionId(`blocked-${i}`);
    const session = { ...w.session, id: sid };
    await deps.sessions.save(session);
    const first = { ...w.first, id: `first-${i}`, sessionId: sid, createdAt: i, updatedAt: 0 };
    const unknown = i >= 25;
    await deliveries.save(unknown ? { ...first, state: 'delivered', nextAt: null } : first);
    if (unknown) {
      await recordEvent(deps, { sessionId: sid, event: { kind: 'prompt', text: 'first' } });
      await recordEvent(deps, { sessionId: sid, event: { kind: 'ended', outcome: 'interrupted', reason: 'outcome_unknown', deliveryId: first.id } });
      await deliveries.save({ ...first, id: `later-${i}`, seq: 3, createdAt: i + 0.5 });
    }
    records.set(sid, { reservation: { target: session }, first: { requestKey: 'key', semanticHash: 'hash', event: { kind: 'prompt', text: 'first' }, delivery: first }, startup: { state: 'pending', workerId: null, attemptId: null, connectionId: null } } as unknown as AgentHandoffRecord);
  }
  const ordinary = asSessionId('ordinary');
  await deps.sessions.save({ ...w.session, id: ordinary });
  deps.hosting.add(ordinary, w.session.workerId);
  await deliveries.save({ ...w.first, id: 'ordinary-first', sessionId: ordinary, createdAt: 100 });
  const before = w.dispatched.length;
  assert.equal(await pumpDeliveries(deps), 50);
  assert.equal(w.dispatched.length, before);
  for (let i = 0; i < 50; i++) {
    const row = await deliveries.byId(i < 25 ? `first-${i}` : `later-${i}`);
    assert.equal(row?.state, 'queued');
    assert.equal(row?.attempt, 0);
    assert.equal(row?.nextAt, now + TURN_WAIT_MS);
  }
  assert.equal(await pumpDeliveries(deps), 1);
  assert.deepEqual(w.dispatched.slice(before), [{ kind: 'prompt', sessionId: ordinary, text: 'first', parts: [], deliveryId: 'ordinary-first', startAttemptId: 'attempt' }]);
});
