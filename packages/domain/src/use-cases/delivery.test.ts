import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps, inMemoryDeliveries } from '../testing/in-memory.ts';
import { ok, err } from '../result.ts';
import { unavailable } from '../errors.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { asAgentId } from '../ids.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { promptSessionUseCase } from './conversation.ts';
import { cancelDelivery, pumpDeliveries, retryDeliveryNow } from './delivery.ts';
import type { WorkerCommand } from '../ports/node-gateway.ts';

async function world() {
  const deliveries = inMemoryDeliveries();
  let offline = true;
  let clock = 1_000;
  const w = inMemoryDeps();
  w.agents.push({ id: asAgentId('fake'), label: 'Fake', capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available }), models: ['m1'], defaultModel: 'm1', options: [] });
  const sent: WorkerCommand[] = [];
  const baseDispatch = w.deps.gateway.dispatch;
  const deps = {
    ...w.deps,
    deliveries,
    random: () => 0.5,
    now: () => clock,
    gateway: { ...w.deps.gateway, dispatch: async (c: WorkerCommand) => {
      if (c.kind === 'prompt' && offline) return err(unavailable('Worker 不在线'));
      if (c.kind === 'prompt') sent.push(c);
      return baseDispatch(c);
    } }
  };
  const project = await createProjectUseCase(deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  return { deps, deliveries, sent, sid: session.value.id, online: () => (offline = false), tick: (ms: number) => (clock += ms) };
}

test('离线时不再当场失败：进队列按退避重试，机器回来后送达并带 deliveryId', async () => {
  const w = await world();
  const out = await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '你好' });
  assert.ok(out.ok, JSON.stringify(out));
  const [d] = await w.deliveries.pendingFor(w.sid);
  assert.equal(d!.state, 'queued');
  assert.equal(d!.attempt, 1);
  assert.equal(d!.nextAt, 1_000 + 2_000);
  assert.equal(await pumpDeliveries(w.deps), 0, '没到期不送');
  w.online();
  w.tick(2_000);
  assert.equal(await pumpDeliveries(w.deps), 1);
  assert.equal(w.sent.length, 1);
  assert.ok(w.sent[0]!.kind === 'prompt' && w.sent[0]!.deliveryId === d!.id);
  assert.equal((await w.deliveries.byId(d!.id))!.state, 'delivered');
});

test('严格按序：前一条没送达，后面的只排队；送达后下一条接着送', async () => {
  const w = await world();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '一' });
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '二' });
  const pending = await w.deliveries.pendingFor(w.sid);
  assert.equal(pending.length, 2);
  assert.equal(pending[1]!.attempt, 0, '第二条没试过');
  w.online();
  w.tick(2_000);
  await pumpDeliveries(w.deps);
  await pumpDeliveries(w.deps);
  assert.deepEqual(w.sent.map((c) => (c.kind === 'prompt' ? c.text.split('\n').at(-1) : '')), ['一', '二']);
});

test('重试 10 次后未送达并收掉这一轮；立即重试、撤回', async () => {
  const w = await world();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '一' });
  for (let i = 0; i < 12; i++) {
    w.tick(60_000);
    await pumpDeliveries(w.deps);
  }
  const [d] = await w.deliveries.pendingFor(w.sid);
  assert.equal(d!.state, 'undelivered');
  const events = await w.deps.sessions.eventsAfter(w.sid, 0 as never);
  assert.ok(events.some((e) => e.event.kind === 'ended' && /未送达/.test(e.event.reason ?? '')));
  w.online();
  assert.ok((await retryDeliveryNow(w.deps, d!.id)).ok);
  assert.equal((await w.deliveries.byId(d!.id))!.state, 'delivered');

  await w.deps.gateway.dispatch({ kind: 'interrupt', sessionId: w.sid });
});

test('撤回：不再送，journal 记一条说明', async () => {
  const w = await world();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '一' });
  const [d] = await w.deliveries.pendingFor(w.sid);
  assert.ok((await cancelDelivery(w.deps, d!.id)).ok);
  assert.equal((await w.deliveries.pendingFor(w.sid)).length, 0);
  w.online();
  w.tick(10_000);
  assert.equal(await pumpDeliveries(w.deps), 0);
  assert.ok(ok(undefined).ok);
});
