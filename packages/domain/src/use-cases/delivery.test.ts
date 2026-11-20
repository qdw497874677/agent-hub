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
import { cancelDelivery, pumpDeliveries, recoverOrphanedTurns, releaseAfterTurn, retryDeliveryNow, ORPHAN_TURN_MS, TURN_STALE_MS, TURN_WAIT_MS } from './delivery.ts';
import { recordEvent } from './sessions.ts';
import type { WorkerCommand } from '../ports/node-gateway.ts';

/**
 * promptSessionUseCase 现在先回 ack，再把派发丢到后台（MS-2）。
 * 测试要看派发结果，就等后台那一段的微任务跑完；setImmediate 在微任务清空后触发，不用睡固定时长。
 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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

test('并发两句：只有先认领的那条派给 worker，另一条停在 queued，两句都留在 journal', async () => {
  const w = await world();
  w.online();
  let pendingEntered = 0;
  const innerPending = w.deliveries.pendingFor.bind(w.deliveries);
  let releaseFirst: (() => void) | null = null;
  w.deliveries.pendingFor = async (sessionId) => {
    pendingEntered += 1;
    if (pendingEntered === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
    else releaseFirst?.();
    return innerPending(sessionId);
  };
  const [first, second] = await Promise.all([
    promptSessionUseCase(w.deps, { sessionId: w.sid, text: '先' }),
    promptSessionUseCase(w.deps, { sessionId: w.sid, text: '后' })
  ]);
  assert.ok(first.ok && second.ok);
  await settle();
  assert.equal(w.sent.length, 1, 'worker 只收到队首');
  assert.equal(pendingEntered, 0, '认领不能拆成 pendingFor 再 save');
  const rows = await w.deliveries.recent(w.sid, 10);
  assert.equal(rows.length, 2);
  const waiting = rows.find((row) => row.state === 'queued');
  assert.ok(waiting);
  assert.equal(waiting.attempt, 0);
  assert.equal(waiting.nextAt, null);
  const events = await w.deps.sessions.eventsAfter(w.sid, 0 as never);
  assert.deepEqual(events.filter((event) => event.event.kind === 'prompt').map((event) => event.event.kind === 'prompt' ? event.event.text : ''), ['先', '后']);
});

test('离线时不再当场失败：进队列按退避重试，机器回来后送达并带 deliveryId', async () => {
  const w = await world();
  const out = await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '你好' });
  assert.ok(out.ok, JSON.stringify(out));
  await settle();
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

test('严格按序：前一条没送达，后面的只排队；送达且那一轮结束后下一条接着送', async () => {
  const w = await world();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '一' });
  await settle();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '二' });
  await settle();
  const pending = await w.deliveries.pendingFor(w.sid);
  assert.equal(pending.length, 2);
  assert.equal(pending[1]!.attempt, 0, '第二条没试过');
  w.online();
  w.tick(2_000);
  await pumpDeliveries(w.deps);
  await pumpDeliveries(w.deps);
  assert.equal(w.sent.length, 1, '第一轮没结束，第二条不塞进去');
  await recordEvent(w.deps, { sessionId: w.sid, event: { kind: 'ended', outcome: 'done' } });
  w.tick(TURN_WAIT_MS);
  await pumpDeliveries(w.deps);
  assert.deepEqual(w.sent.map((c) => (c.kind === 'prompt' ? c.text.split('\n').at(-1) : '')), ['一', '二']);
});

test('重试 10 次后未送达并收掉这一轮；立即重试、撤回', async () => {
  const w = await world();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '一' });
  await settle();
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
  await settle();
  const [d] = await w.deliveries.pendingFor(w.sid);
  assert.ok((await cancelDelivery(w.deps, d!.id)).ok);
  assert.equal((await w.deliveries.pendingFor(w.sid)).length, 0);
  // 撤回最后一条之后这一轮没有下文了：状态要收回来，别一直挂着「正在回复」并挡住删除。
  assert.equal((await w.deps.sessions.byId(w.sid))?.status, 'interrupted');
  w.online();
  w.tick(10_000);
  assert.equal(await pumpDeliveries(w.deps), 0);
  assert.ok(ok(undefined).ok);
});

test('撤回排队消息：前面还有一轮在跑，就不能标成 interrupted', async () => {
  const w = await world();
  w.online();
  // 定时触发的那一轮已经送到运行时，正在跑
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '定时触发：扫一遍', author: { id: 'u', name: 'timer', via: 'connector' } })).ok);
  await settle();
  assert.equal(w.sent.length, 1);
  assert.equal((await w.deps.sessions.byId(w.sid))?.status, 'running');

  // 人插的一句排在这一轮后面，随后被撤回
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '人插一句' })).ok);
  await settle();
  const [q] = await w.deliveries.pendingFor(w.sid);
  assert.equal(q!.state, 'queued');
  assert.ok((await cancelDelivery(w.deps, q!.id)).ok);

  assert.equal((await w.deliveries.pendingFor(w.sid)).length, 0);
  assert.equal((await w.deps.sessions.byId(w.sid))?.status, 'running', '撤的是排队的那条，前面那轮还在跑');

  // 那一轮真结束之后才收尾
  await recordEvent(w.deps, { sessionId: w.sid, event: { kind: 'ended', outcome: 'done' } });
  await releaseAfterTurn(w.deps, w.sid);
});

test('上一轮还在跑（如定时触发）：人发的话排队、不扣次数，回合结束立刻送达', async () => {  const w = await world();
  w.online();
  const first = await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '定时触发：扫一遍', author: { id: 'u', name: 'timer', via: 'connector' } });
  assert.ok(first.ok);
  await settle();
  assert.equal(w.sent.length, 1);
  const second = await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '人插一句' });
  assert.ok(second.ok, JSON.stringify(second));
  await settle();
  assert.equal(w.sent.length, 1, '回合没结束，不往运行时塞');
  const [q] = await w.deliveries.pendingFor(w.sid);
  assert.equal(q!.state, 'queued');
  assert.equal(q!.attempt, 0);
  assert.equal(await pumpDeliveries(w.deps), 0, '泵也不越过还在跑的这一轮');
  w.tick(TURN_WAIT_MS);
  await pumpDeliveries(w.deps);
  assert.equal(w.sent.length, 1);
  await recordEvent(w.deps, { sessionId: w.sid, event: { kind: 'ended', outcome: 'done' } });
  assert.equal(await releaseAfterTurn(w.deps, w.sid), true);
  assert.equal(w.sent.length, 2);
  assert.ok(w.sent[1]!.kind === 'prompt' && w.sent[1]!.text.endsWith('人插一句'));
  assert.equal((await w.deliveries.byId(q!.id))!.state, 'delivered');
});

test('上一轮 30 分钟没动静：不再挡着后面的消息', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'a' });
  await settle();
  w.tick(TURN_STALE_MS + 1);
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'b' });
  await settle();
  assert.equal(w.sent.length, 2);
});

test('撤回的那句不算开了一轮', async () => {
  const w = await world();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'a' });
  await settle();
  const [d] = await w.deliveries.pendingFor(w.sid);
  assert.ok((await cancelDelivery(w.deps, d!.id)).ok);
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'b' });
  await settle();
  assert.equal(w.sent.length, 1);
});

test('送出去就没有下文的那一轮：按失败收尾，并立刻放行排在后面的消息', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第一句' });
  await settle();
  assert.equal(w.sent.length, 1);
  // hub 重启或 Worker 丢帧：托管表里没有这条会话，之后也再没有事件。
  w.deps.hosting.clear();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第二句' });
  await settle();
  assert.equal(w.sent.length, 1, '第一轮还占着队首，第二句只能排队');
  w.tick(ORPHAN_TURN_MS + 1);
  assert.equal(await recoverOrphanedTurns(w.deps), 1);
  assert.equal(w.sent.length, 2, '收尾后马上放行第二句');
  const tail = await w.deps.sessions.tail(w.sid, 10);
  const ended = tail.filter((e) => e.event.kind === 'ended').at(-1);
  assert.ok(ended?.event.kind === 'ended' && ended.event.outcome === 'failed');
  const [second] = await w.deliveries.pendingFor(w.sid);
  assert.equal(second, undefined, '排在后面的那条已经被放出去了');
  assert.equal(await recoverOrphanedTurns(w.deps), 0, '同一条不会反复收尾');
});

test('托管进程还在、但这一轮投递后没有任何事件：也按失败收尾', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第一句' });
  await settle();
  assert.equal(w.sent.length, 1);
  // 旧协议的 Worker 收下了 prompt 却丢帧：托管表里还登记着，journal 再没有这一轮的事件。
  assert.equal(w.deps.hosting.has(w.sid), true, '这条会话确实还登记在托管表里');
  w.tick(ORPHAN_TURN_MS + 1);
  assert.equal(await recoverOrphanedTurns(w.deps), 1, '进程在也一样要收尾，不能一直堵队首');
  const tail = await w.deps.sessions.tail(w.sid, 10);
  const ended = tail.filter((e) => e.event.kind === 'ended').at(-1);
  assert.ok(ended?.event.kind === 'ended' && ended.event.outcome === 'failed');
  assert.equal((await w.deps.sessions.byId(w.sid))!.status, 'failed');
  assert.equal(await recoverOrphanedTurns(w.deps), 0, '同一条不会反复收尾');
});

test('长回合有持续事件：托管进程在时绝不误杀', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '跑一个很慢的工具' });
  await settle();
  // 超过 ORPHAN_TURN_MS 之后还在出事件：这是正常的长回合。
  w.tick(ORPHAN_TURN_MS + 1);
  await recordEvent(w.deps, { sessionId: w.sid, event: { kind: 'text', delta: '还在跑' } });
  assert.equal(await recoverOrphanedTurns(w.deps), 0, '有进展就不插手');
  assert.equal((await w.deps.sessions.byId(w.sid))!.status, 'running');
  const tail = await w.deps.sessions.tail(w.sid, 5);
  assert.equal(tail.filter((e) => e.event.kind === 'ended').length, 0, '不能补一条 ended');
});

test('投递后只有排队消息的 prompt 事件：不算进展，照样收尾', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第一句' });
  await settle();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第二句' });
  await settle();
  assert.equal(w.sent.length, 1, '第二句只在 journal 里落了一条 prompt，还没送');
  w.tick(ORPHAN_TURN_MS + 1);
  assert.equal(await recoverOrphanedTurns(w.deps), 1, 'prompt 事件是 hub 自己写的，不是这一轮的进展');
  assert.equal(w.sent.length, 2, '收尾后第二句能立刻送出去');
});

test('同一会话两个入口同时触发：只投递一次', async () => {
  const w = await world();
  w.online();
  // 一条已经排队的消息：定时泵和「回合结束放行」会同时看见它。
  await w.deliveries.save({
    id: 'race-1', sessionId: w.sid, seq: 1, kind: 'prompt', payload: { text: '并发', parts: [] },
    state: 'queued', attempt: 0, nextAt: 0, lastError: null, createdAt: 1_000, updatedAt: 1_000
  });
  // 两个入口在同一 tick 启动，谁都还没把状态写成 sending。
  await Promise.all([pumpDeliveries(w.deps), releaseAfterTurn(w.deps, w.sid)]);
  assert.equal(w.sent.length, 1, '两个入口只能派发一次');
  const again = await releaseAfterTurn(w.deps, w.sid);
  assert.equal(again, false, '已经送出去的不该再被放行');
});
