import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import type { Delivery } from '../delivery.ts';
import type { JournalEntry } from '../event.ts';
import { asAgentId, asSessionId } from '../ids.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { inMemoryDeliveries, inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase, recordEvent, switchSessionModel } from './sessions.ts';
import { turnInProgress } from './delivery.ts';
import {
  readInFlightTurn,
  readJournalTail,
  readRecentTurnDeliveries,
  TURN_JOURNAL_WINDOW,
  TURN_RECENT_WINDOW,
  turnVerdictInTail
} from './turn-evidence.ts';

const sid = asSessionId('s-1');

function entry(seq: number, event: JournalEntry['event']): JournalEntry {
  return { seq, at: 1_000, event };
}

function deliveryRow(sessionId: string, id: string, seq: number, createdAt: number, state: Delivery['state'] = 'delivered'): Delivery {
  return {
    id,
    sessionId,
    seq,
    kind: 'prompt',
    payload: {},
    state,
    attempt: 0,
    nextAt: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt
  };
}

test('共享有界读：没有送达队列端口时 inFlight / recent 都为空', async () => {
  assert.equal(await readInFlightTurn(undefined, sid), null);
  assert.deepEqual(await readRecentTurnDeliveries(undefined, sid), []);
});

test('共享有界读：recent 按 TURN_RECENT_WINDOW 取，inFlight 是精确查询', async () => {
  const inFlight = deliveryRow('s-1', 'inflight', 7, 1, 'sending');
  let recentLimit = -1;
  let inFlightSession = '';
  const queue = {
    inFlight: async (sessionId: string) => {
      inFlightSession = sessionId;
      return inFlight;
    },
    recent: async (_sessionId: string, limit: number) => {
      recentLimit = limit;
      return [inFlight];
    }
  };
  assert.equal(await readInFlightTurn(queue, sid), inFlight);
  assert.equal(inFlightSession, 's-1');
  assert.deepEqual(await readRecentTurnDeliveries(queue, sid), [inFlight]);
  assert.equal(recentLimit, TURN_RECENT_WINDOW);
  assert.equal(TURN_RECENT_WINDOW, 200);
});

test('journal 尾窗：只有读满 2000 且不是从 seq 1 开始才算截断', async () => {
  const window = (entries: readonly JournalEntry[]) => ({
    sessions: {
      tail: async (_sessionId: string, limit: number) => {
        assert.equal(limit, TURN_JOURNAL_WINDOW);
        return [...entries];
      }
    }
  });
  const texts = (count: number, firstSeq: number): JournalEntry[] =>
    Array.from({ length: count }, (_, index) => entry(firstSeq + index, { kind: 'text', delta: `${index}` }));

  assert.equal(TURN_JOURNAL_WINDOW, 2_000);
  assert.deepEqual(await readJournalTail(window(texts(2_000, 2)), sid), { entries: texts(2_000, 2), truncated: true });
  assert.equal((await readJournalTail(window(texts(2_000, 1)), sid)).truncated, false, '从 seq 1 开始说明窗口覆盖整段 journal');
  assert.equal((await readJournalTail(window(texts(1_999, 5)), sid)).truncated, false, '没读满就没有丢更早的');
  assert.equal((await readJournalTail(window([]), sid)).truncated, false);
});

test('尾部裁决骨架：ended 收尾，未开局的 prompt 跳过，其余 prompt 未收尾，截断无法证明', () => {
  const verdict = (entries: readonly JournalEntry[], skipped: ReadonlySet<number> = new Set(), truncated = false) =>
    turnVerdictInTail({ entries, truncated }, (item) => skipped.has(item.seq));

  assert.equal(verdict([entry(1, { kind: 'prompt', text: 'a' }), entry(2, { kind: 'ended', outcome: 'done' })]), 'idle');
  assert.equal(verdict([entry(1, { kind: 'prompt', text: 'a' })]), 'open');
  assert.equal(
    verdict([entry(1, { kind: 'prompt', text: 'a' }), entry(2, { kind: 'ended', outcome: 'done' }), entry(3, { kind: 'prompt', text: 'queued' })], new Set([3])),
    'idle',
    '尾部排队中的 prompt 还没开局，不能盖过更早的 ended'
  );
  assert.equal(verdict([entry(1, { kind: 'prompt', text: 'a' })], new Set([1])), 'idle', '唯一一条 prompt 没开局 = 空闲');
  assert.equal(verdict([entry(1, { kind: 'text', delta: '' })], new Set(), true), 'unknown', '截断且没有证据 = 无法证明空闲');
  assert.equal(verdict([entry(1, { kind: 'text', delta: '' })]), 'idle');
});

const fakeAgent: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: capabilityMatrix({
    prompt: available,
    interrupt: available,
    fork: available,
    resume: available,
    tool_calls: available,
    artifacts: available,
    structured_events: available,
    attachments: available
  }),
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

async function world() {
  const deliveries = inMemoryDeliveries();
  const w = inMemoryDeps({ deliveries });
  w.agents.push(fakeAgent);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  return { ...w, deliveries, sid: session.value.id };
}

test('同一份 journal：送达门认准归属、拒绝替 B 收尾；切换门只看尾部 ended、允许切换', async () => {
  const w = await world();
  const a = await recordEvent(w.deps, { sessionId: w.sid, event: { kind: 'prompt', text: 'A' } });
  const b = await recordEvent(w.deps, { sessionId: w.sid, event: { kind: 'prompt', text: 'B' } });
  assert.ok(a.ok && b.ok);
  // A 的 ended 迟到，落在 B 的 prompt 之后：现代语义下它只能收掉 A。
  const late = await recordEvent(w.deps, { sessionId: w.sid, event: { kind: 'ended', outcome: 'done', deliveryId: 'delivery-a' } });
  assert.ok(late.ok);
  await w.deliveries.save(deliveryRow(w.sid, 'delivery-a', a.value.lastSeq, 1));
  await w.deliveries.save(deliveryRow(w.sid, 'delivery-b', b.value.lastSeq, 2));

  assert.equal(await turnInProgress(w.deps, w.sid), true, 'A 的 ended 不能当作 B 的结束证据');

  const switched = await switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/glm-5' });
  assert.ok(switched.ok, JSON.stringify(switched));
  assert.equal(await turnInProgress(w.deps, w.sid), true, '切换门放行不改变送达门的归属判断');
});

test('status 非 running：送达门仍按 delivered 证据 fail closed，切换门视为已停止', async () => {
  const w = await world();
  const prompt = await recordEvent(w.deps, { sessionId: w.sid, event: { kind: 'prompt', text: '半截' } });
  assert.ok(prompt.ok);
  // 升级前的 delivered 没有精确 ended，只有会话状态被人中断。
  await w.deliveries.save(deliveryRow(w.sid, 'legacy-delivered', prompt.value.lastSeq, 1));
  await w.deps.sessions.markInterrupted(w.sid, w.deps.now());

  assert.equal(await turnInProgress(w.deps, w.sid), true, 'delivered 没有 ended 时，status 单独说了不算');

  const switched = await switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/glm-5' });
  assert.ok(switched.ok, JSON.stringify(switched));
});
