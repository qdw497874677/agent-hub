import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asAgentId, asProjectId, asSessionId, asTaskId, asWorkspaceId, deriveSession, ok, type AgentHandoffRecord, type AgentHandoffStartup, type RuntimeOption, type SessionStartReadiness, type Task, type WorkerCommand } from '@agent-hub/domain';
import { createAgentHandoffStartup, type AgentHandoffStartupDeps, type HandoffStartMetadata, type HandoffStartObserved } from './agent-handoff-startup.ts';

function fixture(timeoutMs = 30_000) {
  const task = { id: asTaskId('task'), projectId: asProjectId('project'), status: 'todo', archivedAt: null } as Task;
  const made = deriveSession({ task, agentId: asAgentId('target-agent'), model: 'target-model', now: 1, workerId: 'worker', workspaceId: asWorkspaceId('workspace'), createdBy: 'human', id: asSessionId('target') });
  if (!made.ok) throw new Error('fixture');
  let record = { reservation: { target: { ...made.value, options: { inherited: true } }, workerId: 'worker', path: '/workspace' }, first: { delivery: { id: 'delivery' } }, startup: { state: 'pending', workerId: null, attemptId: null, connectionId: null } } as unknown as AgentHandoffRecord;
  let connection: string | null = 'socket';
  let readiness: SessionStartReadiness = { state: 'starting' };
  let dispatch: (command: WorkerCommand) => ReturnType<AgentHandoffStartupDeps['gateway']['dispatch']> = async () => ok(undefined);
  const commands: WorkerCommand[] = [];
  const woke: string[] = [];
  const observed: HandoffStartObserved[] = [];
  const guards: (() => boolean)[] = [];
  const same = (input: AgentHandoffStartup) => record.startup.state === 'claimed' && record.startup.workerId === input.workerId && record.startup.connectionId === input.connectionId && record.startup.attemptId === input.attemptId && record.first?.delivery.id === input.deliveryId;
  const deps: AgentHandoffStartupDeps = {
    store: {
      async byTarget(id) { return id === 'target' ? record : null; },
      async claimStartup(input) {
        if (record.startup.state !== 'pending' || record.first?.delivery.id !== input.deliveryId) return { kind: 'ignored', record };
        record = { ...record, startup: { state: 'claimed', workerId: input.workerId, connectionId: input.connectionId, attemptId: input.attemptId } };
        return { kind: 'claimed', record };
      },
      async settleStartup(input) {
        if (!same(input)) return { kind: 'ignored', record };
        if (input.state === 'ready') observed.push(input.observed ?? {});
        record = { ...record, startup: { ...record.startup, state: input.state } };
        return { kind: 'settled', record };
      }
    },
    gateway: { sessionStartConnection: () => connection, sessionStartReadiness: () => readiness, dispatch: command => { commands.push(command); return dispatch(command); } },
    now: () => 1, newAttemptId: () => 'attempt', onReady: (worker, session, guard) => { woke.push(`${worker}:${session}`); guards.push(guard); }, timeoutMs
  };
  const coordinator = createAgentHandoffStartup(deps);
  return { coordinator, deps, commands, woke, observed, guards, get record() { return record; }, setConnection(value: string | null) { connection = value; }, setReadiness(value: SessionStartReadiness) { readiness = value; }, setDispatch(value: typeof dispatch) { dispatch = value; } };
}

const metadata: HandoffStartMetadata = { attemptId: 'attempt', connectionId: 'socket', isCurrent: () => true };
const readyMetadata: HandoffStartMetadata = { ...metadata, ready: { agentSessionRef: 'native-ref' } };
const option = (current: string): RuntimeOption => ({ id: 'model', label: 'Model', category: 'model', kind: 'select', current, choices: [] });

test('exact ready receipt settles and wakes before dispatch promise resolves, without repeated startup', async () => {
  const f = fixture();
  let finish!: () => void;
  f.setDispatch(() => new Promise(resolve => { finish = () => resolve(ok(undefined)); }));
  const start = f.coordinator.start(f.record);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.record.startup.state, 'claimed');
  assert.deepEqual(f.commands[0], { kind: 'start_session', sessionId: 'target', workerId: 'worker', taskId: 'task', agentId: 'target-agent', workspaceRoot: '/workspace', origin: f.record.reservation.target.origin, resume: null, options: { model: 'target-model' }, startAttemptId: 'attempt', expectedStartConnectionId: 'socket' });
  f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
  assert.equal(await f.coordinator.changed('worker', 'target', readyMetadata), true);
  assert.equal(f.record.startup.state, 'ready');
  assert.deepEqual(f.woke, ['worker:target']);
  finish(); await start;
  await f.coordinator.start(f.record);
  assert.equal(f.commands.length, 1);
  assert.equal(await f.coordinator.changed('worker', 'target'), true);
  assert.equal(await f.coordinator.changed('worker', 'target', readyMetadata), false);
  assert.equal(await f.coordinator.changed('worker', 'ordinary'), false);
});

test('wrong worker, wrong generation and replaced socket cannot settle ready', async () => {
  const f = fixture();
  await f.coordinator.start(f.record);
  f.setReadiness({ state: 'ready', startAttemptId: 'old' });
  assert.equal(await f.coordinator.changed('worker', 'target'), true);
  f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
  assert.equal(await f.coordinator.changed('other', 'target'), true);
  assert.equal(f.record.startup.state, 'claimed');
  f.setConnection('replacement');
  assert.equal(await f.coordinator.changed('worker', 'target'), true);
  assert.equal(f.record.startup.state, 'unknown');
  assert.deepEqual(f.woke, []);
  f.setConnection('socket');
  await f.coordinator.changed('worker', 'target', readyMetadata);
  await f.coordinator.start(f.record);
  assert.equal(f.commands.length, 1);
});

test('deadline and proofless dispatch failures become unknown and cannot restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(25);
  await f.coordinator.start(f.record);
  t.mock.timers.tick(25);
  assert.equal(f.record.startup.state, 'unknown');
  f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
  await f.coordinator.changed('worker', 'target');
  await f.coordinator.start(f.record);
  assert.equal(f.commands.length, 1);
  assert.deepEqual(f.woke, []);
  const g = fixture();
  g.setDispatch(async () => { throw new Error('uncertain'); });
  await g.coordinator.start(g.record);
  assert.equal(g.record.startup.state, 'unknown');
  await g.coordinator.start(g.record);
  assert.equal(g.commands.length, 1);
});

test('recreated coordinator never adopts a previously claimed attempt', async () => {
  const f = fixture();
  await f.coordinator.start(f.record);
  const restarted = createAgentHandoffStartup(f.deps);
  f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
  assert.equal(await restarted.changed('worker', 'target'), true);
  await restarted.start(f.record);
  assert.equal(f.record.startup.state, 'claimed');
  assert.deepEqual(f.woke, []);
  assert.equal(f.commands.length, 1);
});

test('offline pending admission projects unknown without mutating or replaying', async () => {
  const f = fixture();
  assert.equal(f.coordinator.metadataState({ ...f.record, first: null }), 'pending');
  f.setConnection(null);
  await f.coordinator.start(f.record);
  assert.equal(f.record.startup.state, 'pending');
  assert.equal(f.coordinator.metadataState(f.record), 'unknown');
  const restarted = createAgentHandoffStartup(f.deps);
  f.setConnection('socket');
  assert.equal(restarted.metadataState(f.record), 'unknown');
  assert.equal(await restarted.changed('worker', 'target'), true);
  assert.equal(f.commands.length, 0);
});

test('claimed projection requires the live local attempt and exact socket', async () => {
  const f = fixture();
  await f.coordinator.start(f.record);
  assert.equal(f.coordinator.metadataState(f.record), 'claimed');
  const restarted = createAgentHandoffStartup(f.deps);
  assert.equal(restarted.metadataState(f.record), 'unknown');
  assert.equal(f.coordinator.metadataState({ ...f.record, startup: { ...f.record.startup, attemptId: 'other' } }), 'unknown');
  f.setConnection('replacement');
  assert.equal(f.coordinator.metadataState(f.record), 'unknown');
  assert.equal(f.record.startup.state, 'claimed');
  assert.equal(f.commands.length, 1);
});

test('ready projects unknown and suppresses wake after connection or generation loss', async () => {
  const f = fixture();
  await f.coordinator.start(f.record);
  f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
  await f.coordinator.changed('worker', 'target', readyMetadata);
  assert.equal(f.coordinator.metadataState(f.record), 'ready');
  f.setReadiness({ state: 'ready', startAttemptId: 'old' });
  assert.equal(f.coordinator.metadataState(f.record), 'unknown');
  assert.equal(await f.coordinator.changed('worker', 'target'), true);
  f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
  f.setConnection('replacement');
  assert.equal(f.coordinator.metadataState(f.record), 'unknown');
  assert.equal(await f.coordinator.changed('worker', 'target'), true);
  assert.equal(f.record.startup.state, 'ready');
  assert.deepEqual(f.woke, ['worker:target']);
  assert.equal(f.commands.length, 1);
});

test('lost socket while ready CAS is in flight does not wake or display ready', async () => {
  const f = fixture();
  const settle = f.deps.store.settleStartup;
  const store = { ...f.deps.store, async settleStartup(input: Parameters<typeof settle>[0]) {
    const result = await settle(input);
    if (input.state === 'ready') f.setConnection('replacement');
    return result;
  } };
  const coordinator = createAgentHandoffStartup({ ...f.deps, store });
  await coordinator.start(f.record);
  f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
  assert.equal(await coordinator.changed('worker', 'target', readyMetadata), true);
  assert.equal(f.record.startup.state, 'ready');
  assert.equal(coordinator.metadataState(f.record), 'unknown');
  assert.deepEqual(f.woke, []);
});

test('exact ready proof before dispatch resolves passes actual native metadata and guarded snapshot', async () => {
  const f = fixture();
  let finish!: () => void;
  f.setDispatch(() => new Promise(resolve => { finish = () => resolve(ok(undefined)); }));
  const start = f.coordinator.start(f.record);
  await new Promise<void>(resolve => setImmediate(resolve));
  const values = [option('native')];
  assert.deepEqual(f.observed, []);
  f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
  let current = true;
  await f.coordinator.changed('worker', 'target', { ...metadata, isCurrent: () => current, ready: { agentSessionRef: 'native-ref', options: values } });
  values[0] = option('mutated');
  assert.deepEqual(f.observed, [{ agentSessionRef: 'native-ref', options: [option('native')] }]);
  assert.equal(f.guards[0]!(), true);
  current = false;
  assert.equal(f.guards[0]!(), false);
  current = true;
  assert.equal(f.guards[0]!(), true);
  f.setConnection('replacement');
  assert.equal(f.guards[0]!(), false);
  finish(); await start;
});

test('missing or wrong metadata cannot settle ready; exact valid ref is required', async () => {
  const f = fixture();
  await f.coordinator.start(f.record);
  const c = f.coordinator;
  f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
  for (const proof of [undefined, metadata, { ...readyMetadata, attemptId: 'old', ready: { agentSessionRef: 'bad' } }, { ...readyMetadata, connectionId: 'old', ready: { agentSessionRef: 'bad' } }, { ...readyMetadata, isCurrent: () => false, ready: { agentSessionRef: 'bad' } }]) {
    assert.equal(await c.changed('worker', 'target', proof), true);
    assert.equal(f.record.startup.state, 'claimed');
    assert.deepEqual(f.observed, []);
  }
  assert.equal(await c.changed('other', 'target', { ...readyMetadata, ready: { agentSessionRef: 'bad' } }), true);
  assert.equal(f.record.startup.state, 'claimed');
  await c.changed('worker', 'target', readyMetadata);
  assert.equal(f.record.startup.state, 'ready');
  assert.deepEqual(f.observed, [{ agentSessionRef: 'native-ref' }]);
});

test('oversized options are omitted without inference when native ref is valid', async () => {
  const f = fixture();
  await f.coordinator.start(f.record);
  f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
  await f.coordinator.changed('worker', 'target', { ...metadata, ready: { agentSessionRef: 'native-ref', options: [option('x'.repeat(256 * 1024))] } });
  assert.deepEqual(f.observed, [{ agentSessionRef: 'native-ref' }]);
});

test('exact bare or invalid native refs fail startup without wake or replay', async () => {
  for (const ref of [undefined, '', '  ', 'pending', ' PeNdInG ', 'nul\0ref', 'control\nref', 'x\u0085y', 'x'.repeat(513), 'é'.repeat(257)]) {
    const f = fixture();
    await f.coordinator.start(f.record);
    f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
    const proof = { ...metadata, ready: ref === undefined ? {} : { agentSessionRef: ref } };
    assert.equal(await f.coordinator.changed('worker', 'target', proof), true);
    assert.equal(f.record.startup.state, 'failed', JSON.stringify(ref));
    assert.deepEqual(f.observed, []);
    assert.deepEqual(f.woke, []);
    await f.coordinator.changed('worker', 'target', readyMetadata);
    await f.coordinator.start(f.record);
    assert.equal(f.commands.length, 1);
  }
});

test('recreated gateway cannot match a durable ready generation', async () => {
  const f = fixture();
  await f.coordinator.start(f.record);
  f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
  await f.coordinator.changed('worker', 'target', readyMetadata);
  const restarted = createAgentHandoffStartup({ ...f.deps, gateway: { ...f.deps.gateway,
    sessionStartConnection: () => 'new-socket', sessionStartReadiness: () => ({ state: 'untracked' })
  } });
  assert.equal(restarted.metadataState(f.record), 'unknown');
  assert.equal(await restarted.changed('worker', 'target', readyMetadata), true);
  assert.deepEqual(f.woke, ['worker:target']);
});

test('ignored ready CAS does not establish persisted proof or wake', async () => {
  const f = fixture();
  const settle = f.deps.store.settleStartup;
  const coordinator = createAgentHandoffStartup({ ...f.deps, store: { ...f.deps.store,
    async settleStartup(input) {
      if (input.state === 'ready') return { kind: 'ignored', record: f.record };
      return settle(input);
    }
  } });
  await coordinator.start(f.record);
  f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
  await coordinator.changed('worker', 'target', readyMetadata);
  assert.equal(f.record.startup.state, 'claimed');
  assert.deepEqual(f.woke, []);
  assert.equal(coordinator.metadataState(f.record), 'claimed');
});

test('live ready remains ready beyond the startup observation deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(25);
  await f.coordinator.start(f.record);
  f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
  await f.coordinator.changed('worker', 'target', readyMetadata);
  assert.equal(f.coordinator.metadataState(f.record), 'ready');
  t.mock.timers.tick(60);
  assert.equal(f.coordinator.metadataState(f.record), 'ready');
  assert.equal(await f.coordinator.changed('worker', 'target', readyMetadata), false);
  assert.deepEqual(f.woke, ['worker:target']);
});

test('maximum 512 UTF-8 byte native ref is accepted', async () => {
  const f = fixture();
  await f.coordinator.start(f.record);
  f.setReadiness({ state: 'ready', startAttemptId: 'attempt' });
  const ref = 'é'.repeat(256);
  await f.coordinator.changed('worker', 'target', { ...metadata, ready: { agentSessionRef: ref } });
  assert.equal(f.record.startup.state, 'ready');
  assert.deepEqual(f.observed, [{ agentSessionRef: ref }]);
  assert.deepEqual(f.woke, ['worker:target']);
});

test('only exact current failed callback settles failed; timeout and wrong generation remain uncertain', async () => {
  const f = fixture();
  await f.coordinator.start(f.record);
  f.setReadiness({ state: 'failed', reason: 'runtime' });
  await f.coordinator.changed('worker', 'target');
  await f.coordinator.changed('worker', 'target', { ...metadata, attemptId: 'old' });
  await f.coordinator.changed('worker', 'target', { ...metadata, isCurrent: () => false });
  assert.equal(f.record.startup.state, 'claimed');
  f.setReadiness({ state: 'failed', reason: 'timed_out' });
  await f.coordinator.changed('worker', 'target', metadata);
  assert.equal(f.record.startup.state, 'claimed');
  f.setReadiness({ state: 'failed', reason: 'configuration' });
  await f.coordinator.changed('worker', 'target', metadata);
  assert.equal(f.record.startup.state, 'failed');
  assert.deepEqual(f.observed, []);
  assert.deepEqual(f.woke, []);
  await f.coordinator.start(f.record);
  assert.equal(f.commands.length, 1);
});
