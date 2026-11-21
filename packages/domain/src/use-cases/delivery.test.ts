import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps, inMemoryDeliveries } from '../testing/in-memory.ts';
import { ok, err } from '../result.ts';
import { invalid, unavailable } from '../errors.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { asAgentId, type SessionId } from '../ids.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { ingestWorkerEvent, promptSessionUseCase } from './conversation.ts';
import { cancelDelivery, attemptDelivery, findDeliveryEnded, pumpDeliveries, reconcileInFlightDelivery, reconcileSendingDeliveries, recoverOrphanedTurns, releaseAfterTurn, resolveOrphanTurnMs, retryDeliveryNow, turnInProgress, ORPHAN_TURN_MARKER, ORPHAN_TURN_MS, TURN_STALE_MS, TURN_WAIT_MS } from './delivery.ts';
import { recordEvent } from './sessions.ts';
import type { WorkerCommand } from '../ports/node-gateway.ts';
import type { SessionQueue } from '../ports/session-queue.ts';

/**
 * 真串行版 per-session 队列：默认的 immediateQueue 直接执行 work，测不出「队列不可
 * 重入」——真队列里嵌套 `run` 会等自己，永久挂住。
 */
function serialQueue(): SessionQueue & { maxActive: number } {
  const tails = new Map<string, Promise<unknown>>();
  let active = 0;
  const stats = { maxActive: 0 };
  return {
    get maxActive() {
      return stats.maxActive;
    },
    async run<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(sessionId) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      tails.set(sessionId, previous.catch(() => undefined).then(() => gate));
      await previous.catch(() => undefined);
      active += 1;
      stats.maxActive = Math.max(stats.maxActive, active);
      try {
        return await work();
      } finally {
        active -= 1;
        release();
      }
    }
  };
}

/**
 * promptSessionUseCase 现在先回 ack，再把派发丢到后台（MS-2）。
 * 测试要看派发结果，就等后台那一段的微任务跑完；setImmediate 在微任务清空后触发，不用睡固定时长。
 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function world(overrides: Parameters<typeof inMemoryDeps>[0] = {}) {
  const deliveries = inMemoryDeliveries();
  let offline = true;
  let clock = 1_000;
  const w = inMemoryDeps({ deliveries, ...overrides });
  w.agents.push({ id: asAgentId('fake'), label: 'Fake', capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available }), models: ['m1'], defaultModel: 'm1', options: [] });
  const sent: WorkerCommand[] = [];
  const interrupts: SessionId[] = [];
  const baseDispatch = w.deps.gateway.dispatch;
  const deps = {
    ...w.deps,
    deliveries,
    random: () => 0.5,
    now: () => clock,
    gateway: { ...w.deps.gateway, dispatch: async (c: WorkerCommand) => {
      if (c.kind === 'interrupt') {
        interrupts.push(c.sessionId);
        return offline ? err(unavailable('Worker 不在线')) : baseDispatch(c);
      }
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
  return { deps, deliveries, sent, interrupts, sid: session.value.id, online: () => (offline = false), offline: () => (offline = true), tick: (ms: number) => (clock += ms) };
}

type World = Awaited<ReturnType<typeof world>>;

/**
 * 落一条真实回合结束。默认带上当前在途送达的 deliveryId——新语义下只有精确 id 才能收掉 sending。
 * 传 `deliveryId: null` 可模拟老协议 / 不带 id 的 ended。
 */
async function endTurn(
  w: World,
  outcome: 'done' | 'stopped' | 'interrupted' | 'failed' = 'done',
  deliveryId?: string | null
): Promise<string | undefined> {
  const inFlight = await w.deliveries.inFlight(w.sid);
  const id = deliveryId === null ? undefined : deliveryId ?? inFlight?.id;
  await recordEvent(w.deps, { sessionId: w.sid, event: { kind: 'ended', outcome, ...(id === undefined ? {} : { deliveryId: id }) } });
  return id;
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
  // 并发窗口里可能两条都已排队、后台那条先被 reschedule；泵只会放行队首。
  await pumpDeliveries(w.deps);
  await settle();
  assert.equal(w.sent.length, 1, 'worker 只收到队首');
  assert.equal(pendingEntered, 0, '认领不能拆成 pendingFor 再 save');
  const rows = await w.deliveries.recent(w.sid, 10);
  assert.equal(rows.length, 2);
  const waiting = rows.find((row) => row.state === 'queued');
  assert.ok(waiting);
  assert.equal(waiting.attempt, 0);
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
  // 派发成功只是「交给了运行时」：通道仍是 sending，等这一轮真实结束。
  assert.equal((await w.deliveries.byId(d!.id))!.state, 'sending');
  await endTurn(w);
  assert.equal(await reconcileInFlightDelivery(w.deps, w.sid), true);
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
  const ended = await endTurn(w);
  assert.ok(ended);
  assert.equal(await releaseAfterTurn(w.deps, w.sid, ended), true, '真实 ended 后才放行第二条');
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
  assert.equal((await w.deliveries.byId(d!.id))!.state, 'sending', '重试成功也只进入在途');
  await endTurn(w);
  assert.equal(await reconcileInFlightDelivery(w.deps, w.sid), true);
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
  const q = (await w.deliveries.pendingFor(w.sid)).find((d) => d.state === 'queued');
  assert.ok(q);
  assert.ok((await cancelDelivery(w.deps, q!.id)).ok);

  assert.equal((await w.deliveries.pendingFor(w.sid)).length, 1, '在途的那条仍占着通道');
  assert.equal((await w.deliveries.inFlight(w.sid))?.state, 'sending');
  assert.equal((await w.deps.sessions.byId(w.sid))?.status, 'running', '撤的是排队的那条，前面那轮还在跑');

  // 那一轮真结束之后才收尾
  await endTurn(w);
  assert.equal(await reconcileInFlightDelivery(w.deps, w.sid), true);
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
  const q = (await w.deliveries.pendingFor(w.sid)).find((d) => d.state === 'queued');
  assert.ok(q);
  assert.equal(q!.attempt, 0);
  assert.equal(await pumpDeliveries(w.deps), 0, '泵也不越过还在跑的这一轮');
  w.tick(TURN_WAIT_MS);
  await pumpDeliveries(w.deps);
  assert.equal(w.sent.length, 1);
  const firstEnded = await endTurn(w);
  assert.ok(firstEnded);
  assert.equal(await releaseAfterTurn(w.deps, w.sid, firstEnded), true);
  assert.equal(w.sent.length, 2);
  assert.ok(w.sent[1]!.kind === 'prompt' && w.sent[1]!.text.endsWith('人插一句'));
  assert.equal((await w.deliveries.byId(q!.id))!.state, 'sending');
});

test('超过旧的 30 分钟上限也不放行：只有真实 ended 才能继续', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'a' });
  await settle();
  assert.equal(w.sent.length, 1);

  // 旧实现会在这里用「超时」冒充结束，把 b 塞给仍在跑的 session。
  w.tick(TURN_STALE_MS + 1);
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'b' });
  await settle();
  assert.equal(w.sent.length, 1, '超时不是停止证据，b 只能排队');
  assert.equal((await w.deliveries.inFlight(w.sid))?.state, 'sending', 'a 仍在途');
  assert.equal((await w.deliveries.pendingFor(w.sid)).find((d) => d.state === 'queued')?.seq, (await w.deliveries.pendingFor(w.sid)).at(-1)?.seq);

  // 再过一个旧上限也一样：持久化的 sending + running 状态仍然说明这一轮没收尾。
  w.tick(TURN_STALE_MS + 1);
  await pumpDeliveries(w.deps);
  assert.equal(w.sent.length, 1, '无论等多久，没有真实 ended 都不放行');
  assert.equal((await w.deps.sessions.byId(w.sid))!.status, 'running');

  // 运行时真的结束了（带对应 deliveryId），才按正常回合收尾并放行。
  const endedB = await endTurn(w);
  assert.ok(endedB);
  assert.equal(await releaseAfterTurn(w.deps, w.sid, endedB), true);
  assert.equal(w.sent.length, 2);
  assert.ok(w.sent[1]!.kind === 'prompt' && w.sent[1]!.text.endsWith('b'));
});

test('sending 超过旧的 30 分钟上限仍算在跑：prompt 可能还没落盘，不能放行', async () => {
  const w = await world();
  w.online();
  await w.deliveries.save({
    id: 'inflight-1', sessionId: w.sid, seq: 1, kind: 'prompt', payload: { text: '在途', parts: [] },
    state: 'sending', attempt: 0, nextAt: null, lastError: null, createdAt: 1_000, updatedAt: 1_000
  });
  w.tick(TURN_STALE_MS * 2);
  assert.equal(await turnInProgress(w.deps, w.sid), true, 'sending 没有超时豁免');
});

test('sending 在 interrupted 状态也不放行：在途回合仍可能活着', async () => {
  const w = await world();
  await w.deps.sessions.markInterrupted(w.sid, w.deps.now());
  await w.deliveries.save({
    id: 'inflight-2', sessionId: w.sid, seq: 1, kind: 'prompt', payload: { text: '在途', parts: [] },
    state: 'sending', attempt: 0, nextAt: null, lastError: null, createdAt: 1_000, updatedAt: 1_000
  });
  assert.equal(await turnInProgress(w.deps, w.sid), true);
});

test('积压超过 recent(200) 窗口：精确 inFlight 仍挡住下一句，巡检也不漏', async () => {
  const w = await world();
  const base = (await w.deps.sessions.byId(w.sid))!;
  await w.deps.sessions.save({ ...base, status: 'running', updatedAt: w.deps.now() });
  await w.deliveries.save({
    id: 'inflight-old', sessionId: w.sid, seq: 1, kind: 'prompt', payload: { text: '在途', parts: [] },
    state: 'sending', attempt: 0, nextAt: null, lastError: null, createdAt: 1_000, updatedAt: 1_000
  });
  for (let i = 0; i < 205; i++) {
    await w.deliveries.save({
      id: `queued-${i}`, sessionId: w.sid, seq: 2 + i, kind: 'prompt', payload: { text: `q${i}`, parts: [] },
      state: 'queued', attempt: 0, nextAt: 1_000, lastError: null, createdAt: 1_001 + i, updatedAt: 1_001 + i
    });
  }

  // 旧实现只看 recent(200)，这条最早的 sending 已经被挤出窗口；现在必须命中精确 inFlight。
  assert.equal(await turnInProgress(w.deps, w.sid), true);
  assert.equal((await w.deliveries.inFlight(w.sid))?.id, 'inflight-old');
  assert.equal(await recoverOrphanedTurns(w.deps, ORPHAN_TURN_MS + 2_000), 1, '巡检也按精确 inFlight 看到窗口外的在途');
  assert.equal((await w.deliveries.byId('inflight-old'))!.state, 'sending', '巡检只诊断，不清在途');
});

test('journal 尾部读不到这一轮：仍按落盘的送达记录 fail closed', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'a' });
  await settle();
  w.tick(TURN_STALE_MS + 1);

  // 有界 tail 被截断 / 返回空，不能因此把仍在跑的回合当成已结束。
  w.deps.sessions.tail = async () => [];
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'b' });
  await settle();
  assert.equal(w.sent.length, 1, '送达记录和 running 状态足够挡住下一句');
  assert.equal(await turnInProgress(w.deps, w.sid), true);
});

test('journal 尾部被截断且没有送达记录：无法证明空闲，按在跑处理', async () => {
  const w = await world();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '排队中' });
  await settle();
  w.deps.sessions.tail = async () =>
    Array.from({ length: 2_000 }, (_, i) => ({
      seq: (100 + i) as never,
      at: 1_000,
      event: { kind: 'text' as const, delta: '' }
    }));
  assert.equal(await turnInProgress(w.deps, w.sid), true, '更早的 prompt 可能被截断，不能判空闲');
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

test('托管进程还在、送达后毫无进展：只请求一次中断，不补 ended、不放行下一句', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第一句' });
  await settle();
  assert.equal(w.sent.length, 1);
  // 旧协议的 Worker 收下了 prompt 却丢帧：托管表里还登记着，journal 再没有这一轮的事件。
  assert.equal(w.deps.hosting.has(w.sid), true, '这条会话确实还登记在托管表里');
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第二句' });
  await settle();
  assert.equal(w.sent.length, 1, '第二句只在 journal 里落了一条 prompt，还没送');

  // 中断请求发出时，持久标记必须已经在 journal 里：进程若在此刻崩掉，下一轮也不会重复请求。
  const realDispatch = w.deps.gateway.dispatch;
  let markerBeforeInterrupt = false;
  w.deps.gateway.dispatch = async (command) => {
    if (command.kind === 'interrupt') {
      const before = await w.deps.sessions.tail(w.sid, 20);
      markerBeforeInterrupt = before.some((e) => e.event.kind === 'diagnostic' && e.event.text.startsWith(ORPHAN_TURN_MARKER));
    }
    return realDispatch(command);
  };

  w.tick(ORPHAN_TURN_MS + 1);
  assert.equal(await recoverOrphanedTurns(w.deps), 1);
  assert.equal(markerBeforeInterrupt, true, '先落持久标记，再请求中断');
  assert.deepEqual(w.interrupts, [w.sid], '托管进程在，请求运行时中断一次');
  assert.equal(w.sent.length, 1, '不能替用户放行第二句：没有真实 ended 就不算收尾');
  const tail = await w.deps.sessions.tail(w.sid, 20);
  assert.equal(tail.filter((e) => e.event.kind === 'ended').length, 0, '不补 ended');
  assert.equal((await w.deps.sessions.byId(w.sid))!.status, 'running', '状态交给 Worker 的真实结果');
  const notices = tail.filter((e) => e.event.kind === 'diagnostic' && e.event.text.startsWith(ORPHAN_TURN_MARKER));
  assert.equal(notices.length, 1);
  assert.ok(notices[0]!.event.kind === 'diagnostic' && /正在请求中断/.test(notices[0]!.event.text));
  const queued = (await w.deliveries.pendingFor(w.sid)).find((d) => d.state === 'queued');
  assert.ok(queued);

  assert.equal(await recoverOrphanedTurns(w.deps), 0, '同一个回合不重复请求');
  assert.deepEqual(w.interrupts, [w.sid]);
  assert.equal(
    (await w.deps.sessions.tail(w.sid, 20)).filter((e) => e.event.kind === 'diagnostic' && e.event.text.startsWith(ORPHAN_TURN_MARKER)).length,
    1
  );
});

test('观察后、动作前出现真实输出：跳过中断，不打扰已经恢复的回合', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第一句' });
  await settle();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第二句' });
  await settle();
  w.tick(ORPHAN_TURN_MS + 1);

  const realEventsAfter = w.deps.sessions.eventsAfter.bind(w.deps.sessions);
  let calls = 0;
  w.deps.sessions.eventsAfter = async (sessionId, afterSeq) => {
    const rows = await realEventsAfter(sessionId, afterSeq);
    // 第一次观察之后、真正动作之前，运行时又吐了真实输出。
    if (sessionId === w.sid && calls++ === 0) {
      await recordEvent(w.deps, { sessionId: w.sid, event: { kind: 'text', delta: '刚恢复' } });
    }
    return rows;
  };

  assert.equal(await recoverOrphanedTurns(w.deps), 0, '锁内重核会看到新输出并跳过');
  assert.deepEqual(w.interrupts, [], '不能把中断打到已经恢复的回合上');
  const tail = await w.deps.sessions.tail(w.sid, 20);
  assert.equal(tail.filter((e) => e.event.kind === 'diagnostic' && e.event.text.startsWith(ORPHAN_TURN_MARKER)).length, 0);
});

test('观察后、动作前有新消息在途：跳过中断', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第一句' });
  await settle();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第二句' });
  await settle();
  w.tick(ORPHAN_TURN_MS + 1);

  const realEventsAfter = w.deps.sessions.eventsAfter.bind(w.deps.sessions);
  let calls = 0;
  w.deps.sessions.eventsAfter = async (sessionId, afterSeq) => {
    const rows = await realEventsAfter(sessionId, afterSeq);
    if (sessionId === w.sid && calls++ === 0) {
      // 新回合已经开始，prompt 已交给运行时、但 journal 里的 prompt 还没落盘。
      await w.deliveries.save({
        id: 'race-sending', sessionId: w.sid, seq: 2, kind: 'prompt', payload: { text: '新回合', parts: [] },
        state: 'sending', attempt: 0, nextAt: null, lastError: null, createdAt: w.deps.now(), updatedAt: w.deps.now()
      });
    }
    return rows;
  };

  assert.equal(await recoverOrphanedTurns(w.deps), 0, '锁内看到 sending 就跳过');
  assert.deepEqual(w.interrupts, [], '不能把中断打到新回合上');
});

test('固定 50 条窗口不再饿死后面的送达：每个会话按自己的最新记录判断', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第一句' });
  await settle();
  const actual = (await w.deliveries.inFlight(w.sid));
  assert.ok(actual);
  // 让这条送达比 55 条填充记录更新：旧的全局「最旧 50 条 delivered」会把它挤出窗口。
  await w.deliveries.save({ ...actual, updatedAt: 2_000 });
  for (let i = 0; i < 55; i++) {
    await w.deliveries.save({
      id: `filler-${i}`, sessionId: w.sid, seq: 1, kind: 'prompt', payload: { text: `填充 ${i}`, parts: [] },
      state: 'delivered', attempt: 0, nextAt: null, lastError: null,
      createdAt: actual.createdAt - 1_000 + i, updatedAt: 1_000
    });
  }
  w.tick(2_000 + ORPHAN_TURN_MS + 1);

  assert.equal(await recoverOrphanedTurns(w.deps), 1);
  assert.deepEqual(w.interrupts, [w.sid], '最新送达仍会被检查，不被旧窗口饿死');
});

test('无法确认进程是否已停止（托管记录缺失）：只记诊断，不收尾、不放行', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第一句' });
  await settle();
  assert.equal(w.sent.length, 1);
  // hub 重启 / Worker 掉线后托管表里没有它：这不能证明那一轮已经停了。
  w.deps.hosting.clear();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第二句' });
  await settle();
  assert.equal(w.sent.length, 1, '第一轮还占着队首，第二句只能排队');

  w.tick(ORPHAN_TURN_MS + 1);
  assert.equal(await recoverOrphanedTurns(w.deps), 1);
  assert.deepEqual(w.interrupts, [], '托管记录缺失时不盲目发中断');
  assert.equal(w.sent.length, 1, '不放行第二句');
  const tail = await w.deps.sessions.tail(w.sid, 20);
  assert.equal(tail.filter((e) => e.event.kind === 'ended').length, 0, '不补 ended');
  assert.equal((await w.deps.sessions.byId(w.sid))!.status, 'running');
  const notice = tail.filter((e) => e.event.kind === 'diagnostic' && e.event.text.startsWith(ORPHAN_TURN_MARKER)).at(-1);
  assert.ok(notice?.event.kind === 'diagnostic' && /无法确认/.test(notice.event.text));
  assert.ok((await w.deliveries.pendingFor(w.sid)).some((d) => d.state === 'queued'));

  assert.equal(await recoverOrphanedTurns(w.deps), 0, '同一个回合只记一次诊断');
  assert.deepEqual(w.interrupts, []);
});

test('送达后有真实输出：正常长回合，不请求中断也不记诊断', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '跑一个很慢的工具' });
  await settle();
  // 超过 ORPHAN_TURN_MS 之后还在出事件：这是正常的长回合。
  w.tick(ORPHAN_TURN_MS + 1);
  await recordEvent(w.deps, { sessionId: w.sid, event: { kind: 'text', delta: '还在跑' } });
  assert.equal(await recoverOrphanedTurns(w.deps), 0, '有进展就不插手');
  assert.deepEqual(w.interrupts, [], '绝不误杀正在出输出的长回合');
  assert.equal((await w.deps.sessions.byId(w.sid))!.status, 'running');
  const tail = await w.deps.sessions.tail(w.sid, 5);
  assert.equal(tail.filter((e) => e.event.kind === 'ended').length, 0, '不能补一条 ended');
  assert.equal(
    tail.filter((e) => e.event.kind === 'diagnostic' && e.event.text.startsWith(ORPHAN_TURN_MARKER)).length,
    0,
    '有进展时连诊断都不写'
  );
});

test('请求中断后 Worker 迟到的真实 ended：不抢跑收尾，显式 release 才放行', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第一句' });
  await settle();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第二句' });
  await settle();

  w.tick(ORPHAN_TURN_MS + 1);
  assert.equal(await recoverOrphanedTurns(w.deps), 1);
  assert.deepEqual(w.interrupts, [w.sid]);

  // Worker 收到 interrupt 后按真实结果上报 ended（带对应送达 id，不是平台伪造的）。
  await endTurn(w);
  const a = await w.deliveries.inFlight(w.sid);
  assert.ok(a);
  assert.equal((await w.deps.sessions.byId(w.sid))!.status, 'done');
  // 收尾钩子还挂在 ended 上：巡检必须让 sending 继续占着，不能提前放第二句。
  assert.equal(await recoverOrphanedTurns(w.deps), 0);
  assert.deepEqual(w.interrupts, [w.sid], '不重复请求');
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'sending');
  assert.equal(w.sent.length, 1, 'hooks 尚未完成，不放行队首');

  // inbox 在钩子之后显式 release：精确收掉 A，再送 B。
  assert.equal(await releaseAfterTurn(w.deps, w.sid, a!.id), true);
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'delivered');
  const tail = await w.deps.sessions.tail(w.sid, 20);
  assert.equal(tail.filter((e) => e.event.kind === 'ended').length, 1, '只有 Worker 那一条 ended');
  assert.equal(w.sent.length, 2, '显式 release 才放行队首');
  assert.equal((await w.deliveries.inFlight(w.sid))?.state, 'sending');
});

test('请求中断本身送不出去：只记失败诊断，不收尾、不放行、不重复轰炸', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第一句' });
  await settle();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第二句' });
  await settle();
  assert.equal(w.sent.length, 1);

  w.offline();
  w.tick(ORPHAN_TURN_MS + 1);
  assert.equal(await recoverOrphanedTurns(w.deps), 1);
  assert.deepEqual(w.interrupts, [w.sid], '只尝试一次');
  assert.equal(w.sent.length, 1, '不代写结束、不放行');
  const tail = await w.deps.sessions.tail(w.sid, 20);
  assert.equal(tail.filter((e) => e.event.kind === 'ended').length, 0);
  const failureNotice = tail.find((e) => e.event.kind === 'diagnostic' && /请求中断失败/.test(e.event.text));
  assert.ok(failureNotice?.event.kind === 'diagnostic');
  assert.equal(
    tail.filter((e) => e.event.kind === 'diagnostic' && e.event.text.startsWith(ORPHAN_TURN_MARKER)).length,
    1,
    '持久标记只有一条，失败原因另记一条'
  );
  assert.equal((await w.deps.sessions.byId(w.sid))!.status, 'running');

  assert.equal(await recoverOrphanedTurns(w.deps), 0, '失败也不每个周期重试');
  assert.deepEqual(w.interrupts, [w.sid]);
});

test('迟到的 A ended 不能放掉 B：B 早于 ended 入队也只看精确 deliveryId', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'A' });
  await settle();
  const a = await w.deliveries.inFlight(w.sid);
  assert.ok(a);
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'B' });
  await settle();
  const b = (await w.deliveries.pendingFor(w.sid)).find((d) => d.state === 'queued');
  assert.ok(b, 'B 在 A 的 ended 之前已经排队');

  // A 的真实结束落盘，但钩子还没跑完：A 必须继续占着 sending，B 不能提前出队。
  await ingestWorkerEvent(w.deps, w.sid, { kind: 'ended', outcome: 'done', deliveryId: a!.id });
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'sending');
  assert.equal((await w.deliveries.byId(b!.id))!.state, 'queued');
  assert.equal(w.sent.length, 1, 'hooks 期间队列保持占用');

  // release 之前的同 id 重复帧：journal 里已经有精确终态，不能再落一条。
  await ingestWorkerEvent(w.deps, w.sid, { kind: 'ended', outcome: 'failed', deliveryId: a!.id });
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'sending');
  assert.equal((await w.deps.sessions.tail(w.sid, 20)).filter((e) => e.event.kind === 'ended').length, 1, '重复帧不落盘');

  // 维护巡检也不能替 hooks 抢跑；1s 泵同样被 sending 挡住。
  assert.equal(await recoverOrphanedTurns(w.deps), 0, '精确 ended 待 release，不当孤儿');
  assert.equal(await pumpDeliveries(w.deps), 0, 'sending 仍占着队首，泵无可送');
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'sending');
  assert.equal(w.sent.length, 1);

  // 显式 release 才收 A、送 B；调用方带错 id 时不能误收当前在途。
  assert.equal(await releaseAfterTurn(w.deps, w.sid, 'someone-else'), false);
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'sending');
  assert.equal(w.sent.length, 1);
  assert.equal(await releaseAfterTurn(w.deps, w.sid, a!.id), true);
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'delivered');
  assert.equal((await w.deliveries.byId(b!.id))!.state, 'sending');
  assert.equal(w.sent.length, 2);

  // B 在途时，拿 A 的 id 来 release 也不能收掉 B。
  assert.equal(await releaseAfterTurn(w.deps, w.sid, a!.id), false);
  assert.equal((await w.deliveries.byId(b!.id))!.state, 'sending');
  assert.equal(w.sent.length, 2);

  // B 在途时，A 的迟到帧同样不能把 B 收掉。
  await ingestWorkerEvent(w.deps, w.sid, { kind: 'ended', outcome: 'done', deliveryId: a!.id });
  assert.equal((await w.deliveries.byId(b!.id))!.state, 'sending');
  assert.equal((await w.deps.sessions.tail(w.sid, 20)).filter((e) => e.event.kind === 'ended').length, 1, '重复帧不落盘');
});

test('sending 只认精确 ended：无 deliveryId 或别的 id 都不收尾', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'A' });
  await settle();
  const a = await w.deliveries.inFlight(w.sid);
  assert.ok(a);

  await endTurn(w, 'done', null);
  assert.equal(await findDeliveryEnded(w.deps, a!), null);
  assert.equal(await reconcileInFlightDelivery(w.deps, w.sid), false);
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'sending');

  await endTurn(w, 'done', 'someone-else');
  assert.equal(await reconcileInFlightDelivery(w.deps, w.sid), false);
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'sending');

  await endTurn(w, 'done', a!.id);
  assert.equal((await findDeliveryEnded(w.deps, a!))?.event.kind, 'ended');
  assert.equal(await reconcileInFlightDelivery(w.deps, w.sid), true);
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'delivered');
});

test('无 key 的 release 不收任何持久 sending：即使 journal 里已有匹配 ended 也不放行', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'A' });
  await settle();
  const a = await w.deliveries.inFlight(w.sid);
  assert.ok(a);
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'B' });
  await settle();
  const b = (await w.deliveries.pendingFor(w.sid)).find((d) => d.state === 'queued');
  assert.ok(b);

  // A 的精确 ended 已落盘，但旧协议 / 平台补写路径不带 key：不能拿「当前 inFlight」替它收尾。
  await ingestWorkerEvent(w.deps, w.sid, { kind: 'ended', outcome: 'done', deliveryId: a!.id });
  assert.equal(await releaseAfterTurn(w.deps, w.sid), false);
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'sending', '无 key 完全不动作');
  assert.equal((await w.deliveries.byId(b!.id))!.state, 'queued');
  assert.equal(w.sent.length, 1);

  // 带 A 的 id 才是 hooks 之后的授权收尾：A 收掉，B 才出队。
  assert.equal(await releaseAfterTurn(w.deps, w.sid, a!.id), true);
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'delivered');
  assert.equal(w.sent.length, 2);

  // 启动对账仍是有授权的兜底：B 在途且 ended 已落盘时可以收掉它。
  await endTurn(w);
  assert.equal(await reconcileSendingDeliveries(w.deps), 1);
  assert.equal((await w.deliveries.inFlight(w.sid)), null);
});

test('维护 / 状态变更 / 重启对账都不清 sending，只有持久 ended 才收', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'A' });
  await settle();
  const a = await w.deliveries.inFlight(w.sid);
  assert.ok(a);

  w.tick(TURN_STALE_MS * 2);
  assert.equal(await turnInProgress(w.deps, w.sid), true, '超时不等于停止');
  await w.deps.sessions.markInterrupted(w.sid, w.deps.now());
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'sending');
  assert.equal(await turnInProgress(w.deps, w.sid), true, 'interrupted 也不放行');

  // 重启后只做精确对账；没有 ended 就一条都不能清。
  assert.equal(await reconcileSendingDeliveries(w.deps), 0);
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'sending');

  await w.deps.sessions.markRunning(w.sid, w.deps.now());
  await endTurn(w, 'done', a!.id);
  assert.equal(await reconcileSendingDeliveries(w.deps), 1);
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'delivered');
});

test('已知的派发前失败：保留 undelivered + failed ended，不占在途通道', async () => {
  const w = await world();
  w.online();
  const realDispatch = w.deps.gateway.dispatch;
  w.deps.gateway.dispatch = async (command) =>
    command.kind === 'prompt' ? err(invalid('参数不对')) : realDispatch(command);

  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'A' });
  await settle();

  const [d] = await w.deliveries.pendingFor(w.sid);
  assert.equal(d!.state, 'undelivered');
  assert.equal(await w.deliveries.inFlight(w.sid), null);
  assert.equal(await turnInProgress(w.deps, w.sid), false);
  const tail = await w.deps.sessions.tail(w.sid, 20);
  const ended = tail.find((e) => e.event.kind === 'ended');
  assert.ok(ended?.event.kind === 'ended' && ended.event.outcome === 'failed' && /未送达：参数不对/.test(ended.event.reason ?? ''));
});
test('重试 / 撤回排队消息不能绕过在途 sending', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'A' });
  await settle();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'B' });
  await settle();
  const a = await w.deliveries.inFlight(w.sid);
  const b = (await w.deliveries.pendingFor(w.sid)).find((d) => d.state === 'queued');
  assert.ok(a && b);

  assert.equal((await retryDeliveryNow(w.deps, b!.id)).ok, false, '队首在途时不能重试后面的');
  assert.equal((await w.deliveries.byId(b!.id))!.state, 'queued');
  assert.ok((await cancelDelivery(w.deps, b!.id)).ok);
  assert.equal((await w.deliveries.inFlight(w.sid))!.id, a!.id, '撤回 B 不影响在途 A');
  assert.equal((await w.deps.sessions.byId(w.sid))!.status, 'running');
});

test('ingestWorkerEvent：有在途送达时丢弃无 deliveryId 的 ended，不改回合', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'A' });
  await settle();
  const a = await w.deliveries.inFlight(w.sid);
  assert.ok(a);

  const ingested = await ingestWorkerEvent(w.deps, w.sid, { kind: 'ended', outcome: 'done' });
  assert.ok(ingested.ok);
  assert.equal((await w.deps.sessions.byId(w.sid))!.status, 'running', '不推进状态');
  assert.equal((await w.deps.sessions.tail(w.sid, 20)).filter((e) => e.event.kind === 'ended').length, 0, '不触发收尾');
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'sending');
});

test('ingestWorkerEvent：带 id 的 ended 精确匹配才收，重复帧只认一次', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'A' });
  await settle();
  const a = await w.deliveries.inFlight(w.sid);
  assert.ok(a);

  await ingestWorkerEvent(w.deps, w.sid, { kind: 'ended', outcome: 'done', deliveryId: 'other' });
  assert.equal((await w.deps.sessions.byId(w.sid))!.status, 'running');
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'sending');

  await ingestWorkerEvent(w.deps, w.sid, { kind: 'ended', outcome: 'done', deliveryId: a!.id });
  assert.equal((await w.deps.sessions.byId(w.sid))!.status, 'done');
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'sending', '等 hooks 后的 release');
  assert.equal((await w.deps.sessions.tail(w.sid, 20)).filter((e) => e.event.kind === 'ended').length, 1);

  // 重复的同 id 终态：sending 还在，但 journal 已有精确 ended，必须整条忽略。
  await ingestWorkerEvent(w.deps, w.sid, { kind: 'ended', outcome: 'failed', deliveryId: a!.id });
  assert.equal((await w.deps.sessions.byId(w.sid))!.status, 'done');
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'sending');
  assert.equal((await w.deps.sessions.tail(w.sid, 20)).filter((e) => e.event.kind === 'ended').length, 1);

  // 后面没有排队句：release 只做精确收尾，返回 false 是正常的。
  assert.equal(await releaseAfterTurn(w.deps, w.sid, a!.id), false);
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'delivered');
});

test('ingestWorkerEvent：B 在途时，A 的迟到 ended 被丢弃', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'A' });
  await settle();
  const a = await w.deliveries.inFlight(w.sid);
  assert.ok(a);
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'B' });
  await settle();

  await ingestWorkerEvent(w.deps, w.sid, { kind: 'ended', outcome: 'done', deliveryId: a!.id });
  assert.equal(await releaseAfterTurn(w.deps, w.sid, a!.id), true);
  const b = await w.deliveries.inFlight(w.sid);
  assert.ok(b && b.id !== a!.id);

  await ingestWorkerEvent(w.deps, w.sid, { kind: 'ended', outcome: 'done', deliveryId: a!.id });
  assert.equal((await w.deliveries.inFlight(w.sid))!.id, b!.id, 'B 仍占着通道');
  assert.equal((await w.deps.sessions.tail(w.sid, 20)).filter((e) => e.event.kind === 'ended').length, 1, 'A 的重复帧被丢弃');
});

test('ingestWorkerEvent：keyed ended 收尾后，迟到的裸 idle ended 不再改状态 / 触发收尾', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'A' });
  await settle();
  const a = await w.deliveries.inFlight(w.sid);
  assert.ok(a);

  await ingestWorkerEvent(w.deps, w.sid, { kind: 'ended', outcome: 'done', deliveryId: a!.id });
  await releaseAfterTurn(w.deps, w.sid, a!.id);
  assert.equal((await w.deliveries.byId(a!.id))!.state, 'delivered');
  const before = (await w.deps.sessions.tail(w.sid, 20)).filter((e) => e.event.kind === 'ended').length;
  assert.equal(before, 1);

  // 旧协议 / idle 生命周期补来的裸 ended：最近一条 delivered 已有自己的 keyed 终态，
  // 它只是重复帧，不能再推进状态或让 hooks 跑第二遍。
  await ingestWorkerEvent(w.deps, w.sid, { kind: 'ended', outcome: 'failed' });
  assert.equal((await w.deps.sessions.byId(w.sid))!.status, 'done');
  assert.equal((await w.deps.sessions.tail(w.sid, 20)).filter((e) => e.event.kind === 'ended').length, 1);
});

test('HUB_ORPHAN_TURN_MS 解析：正安全整数生效，空 / 非法 / 小数 / 非正回落默认 2 分钟', () => {
  assert.equal(resolveOrphanTurnMs('90000'), 90_000);
  assert.equal(resolveOrphanTurnMs(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  for (const raw of [null, undefined, '', '   ', '0', '0.1', '-1', '1500.9', 'nope', 'Infinity', String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.equal(resolveOrphanTurnMs(raw), ORPHAN_TURN_MS, String(raw));
  }
});

test('回收阈值可独立指定：默认 2 分钟没到，自定义 1 分钟已经触发', async () => {
  const w = await world();
  w.online();
  await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '第一句' });
  await settle();
  w.tick(60_001);
  assert.equal(await recoverOrphanedTurns(w.deps), 0, '默认阈值还没到');
  assert.equal(await recoverOrphanedTurns(w.deps, w.deps.now(), 60_000), 1);
  assert.deepEqual(w.interrupts, [w.sid]);
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

test('撤回与派发认领共用会话队列：读完 queued 后认领先到，就不能把 sending 覆盖成 cancelled', { timeout: 5_000 }, async () => {
  const w = await world({ queue: serialQueue() });
  w.online();
  await w.deliveries.save({
    id: 'c-1', sessionId: w.sid, seq: 1, kind: 'prompt', payload: { text: '撤回竞态', parts: [] },
    state: 'queued', attempt: 0, nextAt: 0, lastError: null, createdAt: 1_000, updatedAt: 1_000
  });

  // 卡住撤回的第一次读：让它在「读到 queued」之后停住，派发随后完成认领。
  let resumeRead!: () => void;
  const readGate = new Promise<void>((resolve) => (resumeRead = resolve));
  let held = false;
  const realById = w.deliveries.byId.bind(w.deliveries);
  w.deliveries.byId = async (deliveryId) => {
    const row = await realById(deliveryId);
    if (!held && deliveryId === 'c-1') {
      held = true;
      await readGate;
    }
    return row;
  };

  const cancel = cancelDelivery(w.deps, 'c-1');
  await settle();
  assert.equal((await w.deliveries.byId('c-1'))!.state, 'queued', '撤回只读到快照，还没写');

  const attempt = await attemptDelivery(w.deps, (await w.deliveries.byId('c-1'))!);
  assert.ok(attempt.ok);
  assert.equal(w.sent.length, 1, '认领先到，消息已经交给运行时');
  assert.equal((await w.deliveries.byId('c-1'))!.state, 'sending');

  resumeRead();
  const cancelled = await cancel;
  assert.equal(cancelled.ok, false, '在途消息不能撤回');
  assert.equal((await w.deliveries.byId('c-1'))!.state, 'sending', 'durable sending 不能被旧快照覆盖');
  const journal = await w.deps.sessions.tail(w.sid, 20);
  assert.equal(journal.filter((entry) => entry.event.kind === 'diagnostic' && /已撤回/.test(entry.event.text)).length, 0);
});

test('派发失败收尾不复用会话队列：串行队列下 attemptDelivery 正常返回、不自己等自己', { timeout: 5_000 }, async () => {
  const queue = serialQueue();
  const w = await world({ queue });
  w.online();
  const realDispatch = w.deps.gateway.dispatch;
  w.deps.gateway.dispatch = async (command) =>
    command.kind === 'prompt' ? err(invalid('参数不对')) : realDispatch(command);

  await w.deliveries.save({
    id: 'fail-1', sessionId: w.sid, seq: 1, kind: 'prompt', payload: { text: '必失败', parts: [] },
    state: 'queued', attempt: 0, nextAt: 0, lastError: null, createdAt: 1_000, updatedAt: 1_000
  });

  const result = await Promise.race([
    attemptDelivery(w.deps, (await w.deliveries.byId('fail-1'))!).then((out) => out),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000))
  ]);
  assert.notEqual(result, 'timeout', '队列内收尾不能再 queue.run（会等自己）');
  assert.equal(queue.maxActive, 1, 'claim → dispatch → 失败收尾都在同一次会话队列里');
  assert.equal((await w.deliveries.byId('fail-1'))!.state, 'undelivered');
  assert.equal(await w.deliveries.inFlight(w.sid), null);
  const tail = await w.deps.sessions.tail(w.sid, 20);
  const ended = tail.find((entry) => entry.event.kind === 'ended');
  assert.ok(ended?.event.kind === 'ended' && ended.event.outcome === 'failed' && /未送达：参数不对/.test(ended.event.reason ?? ''));
});
