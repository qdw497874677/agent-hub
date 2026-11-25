import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asAgentId, asSessionId, createProject, createTask, deriveSession, recordEvent } from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import {
  createTurnFinisher,
  finishFromJournalTail,
  MAX_TRACKED_SESSIONS,
  type TurnFinishDeps
} from './turn-finish.ts';

function world(overrides: Partial<TurnFinishDeps> = {}) {
  const calls: string[] = [];
  const logged: string[] = [];
  const deps: TurnFinishDeps = {
    log: (message) => logged.push(message),
    inbox: { end: async (sessionId, outcome, reason) => void calls.push(`inbox:${sessionId}:${outcome}:${reason ?? ''}`) },
    files: { endTurn: async (sessionId) => void calls.push(`files:${sessionId}`) },
    fakeReplies: { finish: async (sessionId) => (calls.push(`fake:${sessionId}`), null) },
    feishuReplies: { finish: async (sessionId) => (calls.push(`feishu:${sessionId}`), null) },
    ...overrides
  };
  return { deps, calls, logged };
}

async function seedSession() {
  const { deps, frames } = inMemoryDeps();
  const project = createProject({ name: 'demo', now: 1 });
  assert.ok(project.ok);
  const task = createTask({ projectId: project.value.id, title: 't', now: 1 });
  assert.ok(task.ok);
  const created = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1 });
  assert.ok(created.ok);
  await deps.projects.save(project.value);
  await deps.tasks.save(task.value);
  await deps.sessions.save(created.value);
  return { deps, frames, sessionId: created.value.id };
}

/** 让已排进微任务 / 队列的收尾链跑起来（不用真实计时）。 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const sid = asSessionId('s1');

test('同一 ended seq 的并发与重放：钩子只跑一次', async () => {
  const w = world();
  const finisher = createTurnFinisher(w.deps);
  const end = { sessionId: sid, seq: 3, outcome: 'done' as const };
  const [a, b] = await Promise.all([finisher.finish(end), finisher.finish(end)]);
  assert.deepEqual([a, b].sort(), [false, true]);
  assert.equal(await finisher.finish(end), false, '事件帧重放也不再收');
  assert.deepEqual(w.calls, [`fake:${sid}`, `feishu:${sid}`, `files:${sid}`, `inbox:${sid}:done:`]);
  assert.equal(w.calls.filter((call) => call.startsWith('inbox:')).length, 1);
  assert.equal(w.calls.filter((call) => call.startsWith('feishu:')).length, 1);
});

test('新回合（seq 前进）照常收尾；回放更早的 seq 被水位挡住', async () => {
  const w = world();
  const finisher = createTurnFinisher(w.deps);
  assert.equal(await finisher.finish({ sessionId: sid, seq: 3, outcome: 'done' }), true);
  assert.equal(await finisher.finish({ sessionId: sid, seq: 4, outcome: 'done' }), true);
  assert.equal(await finisher.finish({ sessionId: sid, seq: 3, outcome: 'done' }), false);
  assert.equal(w.calls.filter((call) => call.startsWith('inbox:')).length, 2);
});

test('收尾后 journal 又前进：旧 ended 帧重放不再收（不按 session.lastSeq 去重）', async () => {
  const { deps, sessionId } = await seedSession();
  await recordEvent(deps, { sessionId, event: { kind: 'prompt', text: '你好' } });
  const ended = await recordEvent(deps, { sessionId, event: { kind: 'ended', outcome: 'done' } });
  assert.ok(ended.ok);
  const seq = ended.value.lastSeq;

  const calls: string[] = [];
  const finisher = createTurnFinisher({
    log: () => undefined,
    inbox: { end: async (id, outcome) => void calls.push(`inbox:${id}:${outcome}`) },
    files: { endTurn: async () => undefined }
  });

  assert.equal(await finisher.finish({ sessionId, seq, outcome: 'done' }), true);
  // 收尾之后又落了一条迟到的 text：session.lastSeq 前进，但回合身份仍是那条 ended 的 seq。
  await recordEvent(deps, { sessionId, event: { kind: 'text', delta: '迟到的输出' } });
  assert.equal(await finisher.finish({ sessionId, seq, outcome: 'done' }), false);
  assert.deepEqual(calls, [`inbox:${sessionId}:done`]);
});

test('idle 先到（journal 末尾已 ended）与随后事件帧：共享 seq，只收一次，outcome/reason 取自落盘事件', async () => {
  const { deps, sessionId } = await seedSession();
  await recordEvent(deps, { sessionId, event: { kind: 'prompt', text: '跑一下' } });
  const ended = await recordEvent(deps, { sessionId, event: { kind: 'ended', outcome: 'stopped', reason: '手动停止' } });
  assert.ok(ended.ok);
  const seq = ended.value.lastSeq;

  // 把会话快照故意写成别的状态：收尾不应从 status 推断 outcome。
  const snapshot = (await deps.sessions.byId(sessionId))!;
  await deps.sessions.save({ ...snapshot, status: 'failed' });

  const calls: string[] = [];
  const finisher = createTurnFinisher({
    log: () => undefined,
    inbox: { end: async (id, outcome, reason) => void calls.push(`inbox:${id}:${outcome}:${reason ?? ''}`) },
    files: { endTurn: async () => undefined }
  });

  assert.equal(await finishFromJournalTail(deps, finisher, sessionId), true, 'idle 兜底按末尾 ended 收');
  assert.equal(await finisher.finish({ sessionId, seq, outcome: 'stopped', reason: '手动停止' }), false, '事件帧随后到达，同 seq 不重复');
  assert.deepEqual(calls, [`inbox:${sessionId}:stopped:手动停止`]);
});

test('idle 兜底：journal 末尾不是 ended 就什么都不做（不猜 outcome）', async () => {
  const { deps, sessionId } = await seedSession();
  await recordEvent(deps, { sessionId, event: { kind: 'prompt', text: '还在跑' } });
  const calls: string[] = [];
  const finisher = createTurnFinisher({
    log: () => undefined,
    inbox: { end: async (id, outcome) => void calls.push(`inbox:${id}:${outcome}`) },
    files: { endTurn: async () => void calls.push('files') }
  });
  assert.equal(await finishFromJournalTail(deps, finisher, sessionId), false);
  assert.deepEqual(calls, []);
  assert.equal((await deps.sessions.byId(sessionId))!.status, 'running', '状态没被这次兜底改掉');
});

test('回程与检查点先于收件箱：收件箱放行前回复已经取过', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const order: string[] = [];
  const finisher = createTurnFinisher({
    log: () => undefined,
    fakeReplies: { finish: async () => { order.push('fake:start'); await gate; order.push('fake:end'); return null; } },
    files: { endTurn: async () => void order.push('files') },
    inbox: { end: async () => void order.push('inbox') }
  });
  const running = finisher.finish({ sessionId: sid, seq: 1, outcome: 'done' });

  await flush();
  assert.deepEqual(order, ['fake:start', 'files'], '回程没完成前不收件箱放行');
  release();
  assert.equal(await running, true);
  assert.deepEqual(order, ['fake:start', 'files', 'fake:end', 'inbox']);
});

test('同一会话的不同 seq 串行：前一轮钩子没完不放行后一轮', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const order: string[] = [];
  const w = world({
    inbox: {
      end: async (_sessionId, outcome) => {
        order.push(`inbox:${outcome}:start`);
        if (outcome === 'done') await gate;
        order.push(`inbox:${outcome}:end`);
      }
    }
  });
  const finisher = createTurnFinisher(w.deps);
  const first = finisher.finish({ sessionId: sid, seq: 1, outcome: 'done' });
  const second = finisher.finish({ sessionId: sid, seq: 2, outcome: 'failed' });

  await flush();
  assert.deepEqual(order, ['inbox:done:start']);
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(order, ['inbox:done:start', 'inbox:done:end', 'inbox:failed:start', 'inbox:failed:end']);
});

test('一个钩子失败不影响其它钩子，收件箱仍然放行', async () => {
  const w = world({
    feishuReplies: { finish: async () => { throw new Error('飞书挂了'); } },
    inbox: { end: async () => { throw new Error('db down'); } }
  });
  const finisher = createTurnFinisher(w.deps);
  assert.equal(await finisher.finish({ sessionId: sid, seq: 3, outcome: 'failed', reason: 'boom' }), true);
  assert.ok(w.calls.some((call) => call.startsWith('fake:')));
  assert.ok(w.calls.some((call) => call.startsWith('files:')));
  assert.equal(w.logged.length, 2);
  assert.match(w.logged[0]!, /飞书回程失败：Error: 飞书挂了/);
  assert.match(w.logged[1]!, /回合收尾失败：Error: db down/);
});

test('送达放行在收件箱之后，并带本条 ended 的 deliveryId', async () => {
  const w = world({
    releaseDelivery: async (sessionId, deliveryId) => void w.calls.push(`release:${sessionId}:${deliveryId ?? ''}`)
  });
  const finisher = createTurnFinisher(w.deps);
  assert.equal(await finisher.finish({ sessionId: sid, seq: 3, outcome: 'done', deliveryId: 'd9' }), true);
  assert.deepEqual(w.calls, [`fake:${sid}`, `feishu:${sid}`, `files:${sid}`, `inbox:${sid}:done:`, `release:${sid}:d9`]);
});

test('匹配失败结束后，队首仍占用到回程完成；迟到结果不放行下一条', async () => {
  let wake!: () => void;
  const gate = new Promise<void>((resolve) => { wake = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let active = 'a';
  const released: Array<string | undefined> = [];
  const w = world({
    inFlight: async () => ({ id: active, sessionId: sid }),
    feishuReplies: { finish: async () => { entered(); await gate; return null; } },
    releaseDelivery: async (_id, deliveryId) => { released.push(deliveryId); active = 'b'; }
  });
  const finisher = createTurnFinisher(w.deps);
  const failed = { sessionId: sid, seq: 4, outcome: 'failed', deliveryId: 'a' } as const;
  const result = finisher.finish(failed);
  await started;
  assert.equal(active, 'a');
  assert.deepEqual(released, []);
  wake();
  assert.equal(await result, true);
  assert.ok(w.calls.includes(`inbox:${sid}:failed:`));
  assert.equal(active, 'b');
  assert.equal(await finisher.finish({ ...failed, seq: 5 }), false);
  assert.deepEqual(released, ['a']);
});

test('有在途投递时，无 key / 错 key 的 ended 不收尾且不推进去重水位', async () => {
  const seenDeliveryIds: Array<string | undefined> = [];
  const seenReleases: Array<string | undefined> = [];
  const w = world({
    inFlight: async (sessionId) => (sessionId === sid ? { id: 'd1', sessionId: sid } : null),
    feishuReplies: { finish: async (_sessionId, end) => { seenDeliveryIds.push(end.deliveryId); return null; } },
    releaseDelivery: async (_sessionId, deliveryId) => { seenReleases.push(deliveryId); }
  });
  const finisher = createTurnFinisher(w.deps);

  // 先拿一个很大的 seq 来试：如果身份不匹配也写水位，下面真正的 seq 1 就会被挡掉。
  assert.equal(await finisher.finish({ sessionId: sid, seq: 99, outcome: 'failed' }), false, '无 key ended 不能抢当前在途回合');
  assert.equal(await finisher.finish({ sessionId: sid, seq: 98, outcome: 'failed', deliveryId: 'd2' }), false, '错 key ended 不能抢当前在途回合');
  assert.equal(w.calls.length, 0, '身份不匹配时 files / replies / inbox 都不跑');
  assert.deepEqual(seenReleases, [], '身份不匹配时不放行送达队列');

  assert.equal(await finisher.finish({ sessionId: sid, seq: 1, outcome: 'done', deliveryId: 'd1' }), true);
  assert.deepEqual(seenDeliveryIds, ['d1'], '只有真正匹配的 ended 才把 key 交给回程');
  assert.deepEqual(seenReleases, ['d1'], '送达放行也只用匹配 ended 的 key');
  assert.ok(w.calls.includes(`inbox:${sid}:done:`));
});

test('查不到在途身份或投递已收尾时，不重跑带 key 的副作用', async () => {
  let readingFails = true;
  const w = world({ inFlight: async () => {
    if (readingFails) throw new Error('db down');
    return null;
  } });
  const finisher = createTurnFinisher(w.deps);
  const end = { sessionId: sid, seq: 2, outcome: 'done', deliveryId: 'd1' } as const;
  assert.equal(await finisher.finish(end), false);
  readingFails = false;
  assert.equal(await finisher.finish(end), false);
  assert.deepEqual(w.calls, []);
});

test('去重水位有界：超出上限后最久不用的会话被淘汰，重放会重跑（钩子幂等）', async () => {
  const w = world();
  const finisher = createTurnFinisher(w.deps);
  const first = asSessionId('s0');
  assert.equal(await finisher.finish({ sessionId: first, seq: 1, outcome: 'done' }), true);
  for (let i = 1; i <= MAX_TRACKED_SESSIONS; i++) {
    assert.equal(await finisher.finish({ sessionId: asSessionId(`s${i}`), seq: 1, outcome: 'done' }), true);
  }
  assert.equal(await finisher.finish({ sessionId: first, seq: 1, outcome: 'done' }), true, '被淘汰的会话重放会重跑');
});
