import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { asAgentId, asProjectId, asSessionId, asTaskId, asWorkspaceId, deriveSession, type AgentDescriptor, type AgentHandoffRecord, type AgentHandoffStore, type Principal, type Session, type Task, type Workspace } from '@agent-hub/domain';
import { createAgentHandoffService, type AgentHandoffDeps } from './agent-handoff.ts';
import { installAgentHandoffRoutes } from './agent-handoff-routes.ts';

function descriptor(prompt: 'available' | 'denied' = 'available', nativeHandoff = true): AgentDescriptor {
  const available = { state: 'available' } as const;
  return { id: asAgentId('target-agent'), label: 'Target', models: ['model'], defaultModel: 'model', options: [], capabilities: {
    prompt: prompt === 'available' ? available : { state: 'denied', reason: 'disabled' },
    interrupt: available, fork: available, resume: available, tool_calls: available,
    artifacts: available, structured_events: available, attachments: available
  }, ...(nativeHandoff ? { nativeHandoff: true as const } : {}) };
}

function fixture() {
  const actor = { user: { id: 'human' }, loginId: 'login' } as unknown as Principal;
  const task = { id: asTaskId('task'), projectId: asProjectId('project'), status: 'todo', archivedAt: null } as Task;
  const workspace = { id: asWorkspaceId('workspace'), workerId: 'worker', path: '/work', state: 'ready', groupId: null } as Workspace;
  const made = deriveSession({ task, agentId: asAgentId('source-agent'), model: 'old', now: 1, workerId: 'worker', workspaceId: workspace.id, createdBy: 'human', id: asSessionId('source') });
  if (!made.ok) throw new Error('fixture');
  let source = made.value;
  const sessions = new Map<string, Session>([[source.id, source], ['ordinary', { ...source, id: asSessionId('ordinary') }]]);
  let record: AgentHandoffRecord | null = null;
  let admitted = 0;
  let permitted = true;
  let targetVisible = true;
  let sourceVisible = true;
  let active = true;
  let workspaceReady = true;
  let completed = false;
  let descriptors = [descriptor()];
  let window: number | null = null;
  const store: AgentHandoffStore = {
    async reserve(input) {
      if (record) return record.reservation.semanticHash === input.semanticHash && record.reservation.requestKey === input.requestKey ? { kind: 'replay', record } : { kind: 'conflict' };
      record = { reservation: input, sourceAgent: source.agentId, first: null, startup: { state: 'pending', attemptId: null, workerId: null, connectionId: null } };
      sessions.set(input.target.id, input.target);
      return { kind: 'created', record };
    },
    async byTarget(id) { return record?.reservation.target.id === id ? record : null; },
    async byRequest(actorId, sourceId, requestKey) { return record && record.reservation.actorId === actorId && record.reservation.sourceSessionId === sourceId && record.reservation.requestKey === requestKey ? record : null; },
    async historyFor() { return { entries: [], deliveries: [] }; },
    async firstEnded(sessionId, deliveryId, seq) { return completed && record?.reservation.target.id === sessionId && record.first?.delivery.id === deliveryId && record.first.delivery.seq === seq; },
    async admitFirst(input) {
      if (!record) return { kind: 'conflict' };
      if (record.first) return record.first.requestKey === input.requestKey && record.first.semanticHash === input.semanticHash ? { kind: 'replay', record, session: sessions.get(input.targetSessionId)! } : { kind: 'conflict' };
      const session = { ...sessions.get(input.targetSessionId)!, lastSeq: 1, turn: 1 };
      sessions.set(input.targetSessionId, session);
      record = { ...record, first: { requestKey: input.requestKey, semanticHash: input.semanticHash, event: { kind: 'prompt', text: input.text, promptActor: 'account', clientMessageId: input.clientMessageId }, delivery: { id: input.deliveryId, sessionId: session.id, seq: 1, kind: 'prompt', payload: { text: input.decoratedText, parts: [] }, state: 'queued', attempt: 0, nextAt: 1, lastError: null, createdAt: 1, updatedAt: 1 } } };
      return { kind: 'admitted', record, session };
    },
    async claimStartup() { return { kind: 'ignored', record }; },
    async settleStartup() { return { kind: 'ignored', record }; }
  };
  const deps: AgentHandoffDeps = { store, session: async id => sessions.get(id) ?? null, task: async () => task, workspace: async () => workspace, sessionAllowed: async (_actor, session) => permitted && (session.id === source.id ? sourceVisible : targetVisible), taskCreateAllowed: async () => permitted, taskActive: async () => active, workspaceReady: async () => workspaceReady, workerUseAllowed: async () => permitted, readyDescriptors: async () => descriptors, providerAllowed: async () => permitted, history: async () => ({ entries: [], deliveries: [] }), targetWindow: async () => window, firstCompleted: async r => !!r.first && store.firstEnded(r.reservation.target.id, r.first.delivery.id, r.first.delivery.seq), now: () => 1, onAdmitted: async () => { admitted++; } };
  const service = createAgentHandoffService(deps);
  const app = new Hono();
  let current: Principal | null = actor;
  installAgentHandoffRoutes(app, service, () => current);
  const call = (path: string, body?: unknown) => app.request(`/api/sessions/${path}/agent-handoff${body && 'text' in (body as object) ? '/first' : ''}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { actor, service, deps, call, get record() { return record; }, get admitted() { return admitted; }, setPermission(v: boolean) { permitted = v; }, setTargetVisible(v: boolean) { targetVisible = v; }, setSourceVisible(v: boolean) { sourceVisible = v; }, setActive(v: boolean) { active = v; }, setWorkspaceReady(v: boolean) { workspaceReady = v; }, setCompleted(v: boolean) { completed = v; }, setDescriptors(v: AgentDescriptor[]) { descriptors = v; }, setWindow(v: number | null) { window = v; }, setActor(v: Principal | null) { current = v; }, advance() { source = { ...source, lastSeq: 8 }; sessions.set(source.id, source); }, removeSource() { sessions.delete(source.id); } };
}

test('reservation replay retains original pin and first admission is exactly once', async () => {
  const f = fixture();
  const request = { agentId: 'target-agent', model: 'model', requestId: 'key' };
  const created = await f.service.reserve(f.actor, 'source', request);
  assert.ok(created.ok); const target = created.value.sessionId;
  f.advance();
  assert.deepEqual(await f.service.reserve(f.actor, 'source', request), created);
  assert.equal(f.record?.reservation.sourceCursor, 0);
  assert.equal((await f.service.reserve(f.actor, 'source', { ...request, model: 'other' })).ok, false);
  const first = { text: 'human text', clientMessageId: 'msg', withHistory: false };
  f.setActive(false);
  assert.equal((await f.service.first(f.actor, target, first)).ok, false);
  f.setActive(true);
  const ack = await f.service.first(f.actor, target, first);
  assert.ok(ack.ok); assert.deepEqual(await f.service.first(f.actor, target, first), ack);
  assert.equal(f.admitted, 1);
  assert.equal(f.record?.first?.event.kind, 'prompt');
  assert.deepEqual(f.record?.first?.delivery.payload, { text: 'human text', parts: [] });
  assert.equal((await f.service.first(f.actor, target, { ...first, text: 'changed' })).ok, false);
  f.setActive(false);
  assert.equal((await f.service.first(f.actor, target, first)).ok, false);
  f.setActive(true);
  f.setPermission(false);
  assert.equal((await f.service.first(f.actor, target, first)).ok, false);
});

test('reservation replay survives offline worker only while live access, task and placement remain valid', async () => {
  const f = fixture();
  const request = { agentId: 'target-agent', model: 'model', requestId: 'key' };
  f.setActive(false);
  assert.equal((await f.service.reserve(f.actor, 'source', request)).ok, false);
  f.setActive(true);
  const created = await f.service.reserve(f.actor, 'source', request); assert.ok(created.ok);
  f.advance(); f.setDescriptors([]);
  assert.deepEqual(await f.service.reserve(f.actor, 'source', request), created);
  assert.equal((await f.service.reserve(f.actor, 'source', { ...request, model: 'different' })).ok, false);
  f.setTargetVisible(false);
  assert.equal((await f.service.reserve(f.actor, 'source', request)).ok, false);
  f.setTargetVisible(true); f.setActive(false);
  assert.equal((await f.service.reserve(f.actor, 'source', request)).ok, false);
  f.setActive(true); f.setPermission(false);
  assert.equal((await f.service.reserve(f.actor, 'source', request)).ok, false);
  f.setPermission(true); f.removeSource();
  assert.equal((await f.service.reserve(f.actor, 'source', request)).ok, false);
});

test('reservation and first admission require native handoff, prompt capability and a ready workspace', async () => {
  const f = fixture();
  const request = { agentId: 'target-agent', model: 'model', requestId: 'key' };
  f.setDescriptors([descriptor('denied')]);
  assert.equal((await f.service.reserve(f.actor, 'source', request)).ok, false);
  f.setDescriptors([descriptor('available', false)]);
  assert.equal((await f.service.reserve(f.actor, 'source', request)).ok, false);
  f.setDescriptors([descriptor()]); f.setWorkspaceReady(false);
  assert.equal((await f.service.reserve(f.actor, 'source', request)).ok, false);
  assert.equal(Boolean(f.record), false);
  f.setWorkspaceReady(true);
  const created = await f.service.reserve(f.actor, 'source', request); assert.ok(created.ok);
  const first = { text: 'hello', clientMessageId: 'message', withHistory: false };
  f.setWorkspaceReady(false);
  assert.equal((await f.service.first(f.actor, created.value.sessionId, first)).ok, false);
  f.setWorkspaceReady(true); f.setDescriptors([descriptor('denied')]);
  assert.equal((await f.service.first(f.actor, created.value.sessionId, first)).ok, false);
  f.setDescriptors([descriptor('available', false)]);
  assert.equal((await f.service.first(f.actor, created.value.sessionId, first)).ok, false);
  assert.equal(f.record?.first, null);
  assert.equal(f.admitted, 0);
});

test('metadata conceals hidden ordinary, reserved and missing targets and handles source revocation', async () => {
  const f = fixture();
  const created = await f.service.reserve(f.actor, 'source', { agentId: 'target-agent', model: 'model', requestId: 'key' });
  assert.ok(created.ok); const id = created.value.sessionId;
  const ordinary = await f.call('ordinary');
  assert.equal(ordinary.status, 200); assert.deepEqual(await ordinary.json(), { handoff: null });
  f.setTargetVisible(false);
  const hiddenResponses = await Promise.all([f.call('ordinary'), f.call(id), f.call('missing')]);
  const bodies = await Promise.all(hiddenResponses.map(async response => {
    assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  }));
  assert.deepEqual(bodies[0], bodies[1]); assert.deepEqual(bodies[1], bodies[2]);
  f.setTargetVisible(true); f.setSourceVisible(false);
  const revoked = await f.call(id);
  assert.equal(revoked.status, 403); assert.doesNotMatch(await revoked.text(), /source/);
  f.setSourceVisible(true);
  assert.equal((await f.service.first(f.actor, id, { text: 'hello', clientMessageId: 'message', withHistory: false })).ok, true);
  f.setCompleted(true); f.setSourceVisible(false);
  const completed = await f.call(id);
  assert.equal(completed.status, 200); assert.deepEqual(await completed.json(), { handoff: null });
});

test('proven pinned history decorates only delivery; later source content never enters it', async () => {
  const f = fixture();
  f.advance();
  f.setWindow(8000);
  let observedCursor = -1;
  const service = createAgentHandoffService({ ...f.deps, history: async (id, cursor) => {
    assert.equal(id, 'source'); observedCursor = cursor;
    return { entries: [
      { seq: 1, at: 1, event: { kind: 'prompt', text: 'proven old text', promptActor: 'account' } },
      { seq: 2, at: 2, event: { kind: 'ended', outcome: 'done', deliveryId: 'old' } },
      { seq: 9, at: 9, event: { kind: 'prompt', text: 'later secret', promptActor: 'account' } },
      { seq: 10, at: 10, event: { kind: 'ended', outcome: 'done', deliveryId: 'later' } }
    ], deliveries: [
      { sessionId: 'source', promptSeq: 1, deliveryId: 'old', ended: { seq: 2, outcome: 'done' } },
      { sessionId: 'source', promptSeq: 9, deliveryId: 'later', ended: { seq: 10, outcome: 'done' } }
    ] };
  } });
  const reserved = await service.reserve(f.actor, 'source', { agentId: 'target-agent', model: 'model', requestId: 'key' });
  assert.ok(reserved.ok);
  const response = await service.first(f.actor, reserved.value.sessionId, { text: 'new raw text', clientMessageId: 'message', withHistory: true });
  assert.ok(response.ok); assert.equal(observedCursor, 8);
  assert.deepEqual(f.record?.first?.event, { kind: 'prompt', text: 'new raw text', promptActor: 'account', clientMessageId: 'message' });
  const payload = f.record?.first?.delivery.payload as { text: string };
  assert.match(payload.text, /proven old text/); assert.doesNotMatch(payload.text, /later secret/);
  assert.match(payload.text, /new raw text/);
});

test('route creates without sending, admits first text, and rejects extra first-message fields', async () => {
  const f = fixture();
  const created = await f.call('source', { agentId: 'target-agent', model: 'model', requestId: 'route-key' });
  assert.equal(created.status, 200); assert.equal(created.headers.get('cache-control'), 'no-store');
  const { sessionId } = await created.json() as { sessionId: string };
  assert.equal(f.admitted, 0);
  const invalid = await f.call(sessionId, { text: 'new', clientMessageId: 'm', withHistory: false, attachments: [] });
  assert.equal(invalid.status, 400);
  const accepted = await f.call(sessionId, { text: 'new', clientMessageId: 'm', withHistory: false });
  assert.equal(accepted.status, 200); assert.equal(accepted.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await accepted.json(), { seq: 1, deliveryId: f.record?.first?.delivery.id, state: 'queued', turn: 1 });
  assert.equal(f.admitted, 1);
});

test('unknown native window caps raw no-history text at 64 KiB without claiming it fits', async () => {
  const f = fixture();
  const reserved = await f.service.reserve(f.actor, 'source', { agentId: 'target-agent', model: 'model', requestId: 'key' });
  assert.ok(reserved.ok);
  const id = reserved.value.sessionId;
  const first = { text: 'x'.repeat(2 * 1024 * 1024), clientMessageId: 'm', withHistory: false };
  const tooLarge = await f.service.first(f.actor, id, first);
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.match(tooLarge.error.message, /64 KiB/);
  assert.equal((await f.service.first(f.actor, id, { ...first, text: 'é'.repeat(32769) })).ok, false);
  assert.equal(f.admitted, 0);
  assert.equal((await f.service.first(f.actor, id, { ...first, text: 'é'.repeat(32768) })).ok, true);
  assert.equal(f.admitted, 1);
});

test('history requires explicit fallback; policy, descriptor, actor and routes fail closed', async () => {
  const f = fixture();
  f.setDescriptors([]);
  const req = { agentId: 'target-agent', model: 'model', requestId: 'key' };
  assert.equal((await f.service.reserve(f.actor, 'source', req)).ok, false);
  f.setDescriptors([descriptor()]);
  assert.equal((await createAgentHandoffService({ ...f.deps, providerAllowed: undefined }).reserve(f.actor, 'source', req)).ok, false);
  const invalid = await f.call('source', { ...req, workerId: 'client-supplied' });
  assert.equal(invalid.status, 400); assert.equal(invalid.headers.get('cache-control'), 'no-store');
  const result = await f.service.reserve(f.actor, 'source', req); assert.ok(result.ok);
  const id = result.value.sessionId;
  assert.equal((await f.service.first(f.actor, id, { text: 'x', clientMessageId: 'x', withHistory: true })).ok, false);
  f.setWindow(2000);
  assert.equal((await f.service.first(f.actor, id, { text: 'x', clientMessageId: 'x', withHistory: true })).ok, false);
  const get = await f.call(id); assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await get.json(), { handoff: { sourceSessionId: 'source', firstAccepted: false, startup: 'pending', historyAvailable: false } });
  f.setActor({ ...f.actor, user: { ...f.actor.user, id: 'other' as typeof f.actor.user.id } });
  const hidden = await f.call(id); assert.equal(hidden.status, 403); assert.equal(hidden.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await (await f.call('ordinary')).json(), { handoff: null });
  f.setActor(null);
  const denied = await f.call(id, { text: 'x', clientMessageId: 'x', withHistory: false });
  assert.equal(denied.status, 403); assert.equal(denied.headers.get('cache-control'), 'no-store');
});
