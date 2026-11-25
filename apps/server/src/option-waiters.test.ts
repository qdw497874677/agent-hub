import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOptionWaiters, ingestOptionReceipt } from './option-waiters.ts';
import { asSessionId, MODEL_PINNED, recordSessionOptions, startCommand } from '@agent-hub/domain';
import type { RuntimeOption, Session } from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';

const snapshot = (current: string): RuntimeOption[] => [{ id: 'effort', label: 'Effort', category: 'thought_level', kind: 'select', current, choices: [] }];
const modelSnapshot = (current: string): RuntimeOption[] => [{ id: 'model', label: 'Model', category: 'model', kind: 'select', current, choices: [] }];

test('only an exact live model receipt pins the first explicit model and protects fresh start', async () => {
  const { deps } = inMemoryDeps();
  const id = asSessionId('model-exact');
  await deps.sessions.save({ id, model: '', agentId: 'fake', workerId: 'w', options: {}, optionSpec: [], lastSeq: 0 } as unknown as Session);
  const waiters = createOptionWaiters(1000);
  const pending = waiters.register(id, 'model', 'm2');
  await ingestOptionReceipt(deps, waiters, id, pending.requestId, 'model', 'applied', modelSnapshot('m2'), () => true);
  assert.equal(await pending.result, 'confirmed');
  await recordSessionOptions(deps, { sessionId: id, options: modelSnapshot('m1') });
  const session = (await deps.sessions.byId(id))!;
  assert.equal(session.model, 'm2');
  assert.equal(session.options.model, 'm2');
  assert.equal(session.optionSpec[0]?.current, 'm1');
  assert.equal(session[MODEL_PINNED], true);
  assert.equal(startCommand({ ...session, workerId: 'w' }, '/tmp', null).options.model, 'm2');
});

test('mismatched, ambiguous and late model receipts never pin or overwrite', async () => {
  const { deps } = inMemoryDeps();
  const id = asSessionId('model-races');
  await deps.sessions.save({ id, model: '', options: {}, optionSpec: [] } as unknown as Session);
  const waiters = createOptionWaiters(5);
  const mismatch = waiters.register(id, 'model', 'm2');
  await ingestOptionReceipt(deps, waiters, id, mismatch.requestId, 'model', 'applied', modelSnapshot('m1'), () => true);
  assert.equal(await mismatch.result, 'unconfirmed');
  const ambiguous = waiters.register(id, 'model', 'm2');
  await ingestOptionReceipt(deps, waiters, id, ambiguous.requestId, 'model', 'applied', [...modelSnapshot('m2'), ...modelSnapshot('m1')], () => true);
  assert.equal(await ambiguous.result, 'unconfirmed');
  const late = waiters.register(id, 'model', 'm2');
  assert.equal(await late.result, 'unconfirmed');
  await ingestOptionReceipt(deps, waiters, id, late.requestId, 'model', 'applied', modelSnapshot('m2'), () => true);
  assert.equal((await deps.sessions.byId(id))?.model, '');
});

test('old receipt after timeout and newer selection cannot overwrite the newer desired model', async () => {
  const { deps } = inMemoryDeps();
  const id = asSessionId('model-newer');
  await deps.sessions.save({ id, model: '', options: {}, optionSpec: [] } as unknown as Session);
  const waiters = createOptionWaiters(10);
  const old = waiters.register(id, 'model', 'm1');
  assert.equal(await old.result, 'unconfirmed');
  const next = waiters.register(id, 'model', 'm2');
  await ingestOptionReceipt(deps, waiters, id, next.requestId, 'model', 'applied', modelSnapshot('m2'), () => true);
  assert.equal(await next.result, 'confirmed');
  await ingestOptionReceipt(deps, waiters, id, old.requestId, 'model', 'applied', modelSnapshot('m1'), () => true);
  assert.equal((await deps.sessions.byId(id))?.model, 'm2');
});

test('receipt cannot replace a desired model changed by a different command', async () => {
  const { deps } = inMemoryDeps();
  const id = asSessionId('model-concurrent');
  await deps.sessions.save({ id, model: 'm0', options: {}, optionSpec: [] } as unknown as Session);
  const waiters = createOptionWaiters(5);
  const pending = waiters.register(id, 'model', 'm1', 'm0');
  const current = (await deps.sessions.byId(id))!;
  await deps.sessions.save({ ...current, model: 'm2', [MODEL_PINNED]: true });
  await ingestOptionReceipt(deps, waiters, id, pending.requestId, 'model', 'applied', modelSnapshot('m1'), () => true);
  assert.equal(await pending.result, 'unconfirmed');
  assert.equal((await deps.sessions.byId(id))?.model, 'm2');
});

test('late exact applied snapshot persists as observation, not retroactive confirmation', async () => {
  const { deps } = inMemoryDeps();
  const id = asSessionId('s-late');
  await deps.sessions.save({ id, model: '', options: {}, optionSpec: [] } as unknown as Session);
  const waiters = createOptionWaiters(5);
  const pending = waiters.register(id, 'effort', 'high');
  assert.equal(await pending.result, 'unconfirmed');
  await ingestOptionReceipt(deps, waiters, id, pending.requestId, 'effort', 'applied', snapshot('high'), () => true);
  assert.equal((await deps.sessions.byId(id))?.options.effort, 'high');
  assert.equal(await pending.result, 'unconfirmed');
});

test('receipt is fenced before queued persistence; rejected and unknown carry no observation', async () => {
  const world = inMemoryDeps();
  const id = asSessionId('s-fenced');
  await world.deps.sessions.save({ id, model: '', options: {}, optionSpec: [] } as unknown as Session);
  const waiters = createOptionWaiters(1000);
  let current = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const deps = { ...world.deps, queue: { async run<T>(_sessionId: string, work: () => Promise<T>): Promise<T> { await gate; return work(); } } };
  const old = waiters.register(id, 'effort', 'low');
  const late = ingestOptionReceipt(deps, waiters, id, old.requestId, 'effort', 'applied', snapshot('low'), () => current);
  current = false; // newer command, replacement, or disconnect invalidates gateway generation
  release();
  await late;
  assert.deepEqual((await world.deps.sessions.byId(id))?.options, {});
  old.cancel();
  const next = waiters.register(id, 'effort', 'high');
  await ingestOptionReceipt(world.deps, waiters, id, next.requestId, 'effort', 'unknown', snapshot('high'), () => true);
  assert.equal(await next.result, 'unconfirmed');
  assert.deepEqual((await world.deps.sessions.byId(id))?.options, {});
});

test('replacement while snapshot is loading prevents stale write', async () => {
  const { deps } = inMemoryDeps();
  const id = asSessionId('s-reading');
  await deps.sessions.save({ id, model: '', options: {}, optionSpec: [] } as unknown as Session);
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sessions = { ...deps.sessions, async byId(sessionId: typeof id) { const session = await deps.sessions.byId(sessionId); entered(); await gate; return session; } };
  const waiters = createOptionWaiters(1000);
  const old = waiters.register(id, 'effort', 'low');
  let current = true;
  const receipt = ingestOptionReceipt({ ...deps, sessions }, waiters, id, old.requestId, 'effort', 'applied', snapshot('low'), () => current);
  await reading;
  current = false;
  release();
  await receipt;
  assert.deepEqual((await deps.sessions.byId(id))?.options, {});
  old.cancel();
});

test('receipt honors cross-provider snapshot normalization', async () => {
  const { deps } = inMemoryDeps();
  const id = asSessionId('s-model');
  await deps.sessions.save({ id, model: 'hub-new/b', options: {}, optionSpec: [] } as unknown as Session);
  const waiters = createOptionWaiters(5);
  const pending = waiters.register(id, 'effort', 'high');
  const oldModel: RuntimeOption = { id: 'model', label: 'Model', category: 'model', kind: 'select', current: 'hub-old/a', choices: [] };
  await ingestOptionReceipt(deps, waiters, id, pending.requestId, 'effort', 'applied', [oldModel, ...snapshot('high')], () => true);
  assert.deepEqual((await deps.sessions.byId(id))?.options, {});
  assert.equal(await pending.result, 'unconfirmed');
});

test('agent 回报了就立刻放行', async () => {
  const waiters = createOptionWaiters(10_000);
  const waiting = waiters.wait('s1');
  waiters.resolve('s1');
  await waiting;
});

test('exact receipts require request, session, option and requested snapshot value', async () => {
  const waiters = createOptionWaiters(1000);
  const first = waiters.register('s1', 'effort', 'high');
  waiters.resolve('s1');
  waiters.receipt('s1', 'wrong', 'effort', 'applied', snapshot('high'));
  waiters.receipt('s2', first.requestId, 'effort', 'applied', snapshot('high'));
  waiters.receipt('s1', first.requestId, 'other', 'applied', snapshot('high'));
  waiters.receipt('s1', first.requestId, 'effort', 'applied', snapshot('high'));
  assert.equal(await first.result, 'confirmed');
  const mismatch = waiters.register('s1', 'effort', 'high');
  waiters.receipt('s1', mismatch.requestId, 'effort', 'applied', snapshot('low'));
  assert.equal(await mismatch.result, 'unconfirmed');
  const rejected = waiters.register('s1', 'effort', 'high');
  waiters.receipt('s1', rejected.requestId, 'effort', 'rejected');
  assert.equal(await rejected.result, 'rejected');
});

test('timeout and late receipt cannot settle a newer mutation', async () => {
  const waiters = createOptionWaiters(5);
  const old = waiters.register('s1', 'effort', 'low');
  assert.equal(await old.result, 'unconfirmed');
  const next = waiters.register('s1', 'effort', 'high');
  waiters.receipt('s1', old.requestId, 'effort', 'applied', snapshot('low'));
  waiters.receipt('s1', next.requestId, 'effort', 'applied', snapshot('high'));
  assert.equal(await next.result, 'confirmed');
});

test('mutations serialize per session, not globally', async () => {
  const waiters = createOptionWaiters();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = waiters.serialize('s1', async () => { order.push('first'); await gate; });
  const second = waiters.serialize('s1', async () => { order.push('second'); });
  await waiters.serialize('s2', async () => { order.push('other'); });
  assert.deepEqual(order, ['first', 'other']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'other', 'second']);
});

test('agent 不回也不挂住请求：超时后放行', async () => {
  const waiters = createOptionWaiters(5);
  const started = Date.now();
  await waiters.wait('s1');
  assert.ok(Date.now() - started >= 4);
});
