import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalGate, openApprovals } from './approval.ts';
import type { SessionEvent } from './event.ts';

function harness(timeoutMs = 1000) {
  const events: SessionEvent[] = [];
  const sent: [string, string][] = [];
  const timers: (() => void)[] = [];
  const gate = createApprovalGate({
    push: (e) => events.push(e),
    send: async (id, d) => void sent.push([id, d]),
    timeoutMs,
    now: () => 100,
    setTimer: (fn) => timers.push(fn) - 1,
    clearTimer: (h) => void (timers[h as number] = () => undefined)
  });
  return { events, sent, timers, gate };
}

test('批准：人点允许 → resolved(user) + 回运行时 allow；重复点无效', async () => {
  const { events, sent, gate } = harness();
  gate.request({ id: 'a', title: 'rm x' });
  assert.deepEqual(events[0], { kind: 'approval', phase: 'request', id: 'a', title: 'rm x', expiresAt: 1100 });
  assert.equal(await gate.respond('a', 'allow', { id: 'u', name: 'D' }), true);
  assert.equal(await gate.respond('a', 'deny'), false);
  assert.deepEqual(sent, [['a', 'allow']]);
  assert.deepEqual(events[1], { kind: 'approval', phase: 'resolved', id: 'a', decision: 'allow', by: 'user', author: { id: 'u', name: 'D' } });
});

test('批准：超时 = 拒绝；点晚了无效', async () => {
  const { events, sent, timers, gate } = harness();
  gate.request({ id: 'a', title: 'x' });
  timers[0]!();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [['a', 'deny']]);
  assert.equal((events[1] as { by: string }).by, 'timeout');
  assert.equal(await gate.respond('a', 'allow'), false);
});

test('批准：会话关闭 → 全部拒绝；运行时撤回不回', async () => {
  const { sent, gate, events } = harness();
  gate.request({ id: 'a', title: 'x' });
  gate.request({ id: 'b', title: 'y' });
  gate.withdraw('b');
  await gate.close();
  assert.deepEqual(sent, [['a', 'deny']]);
  assert.equal(events.filter((e) => e.kind === 'approval' && e.phase === 'resolved').length, 2);
  assert.deepEqual(gate.pending(), []);
});

test('openApprovals：收掉的、过期的都不算', () => {
  const evs: SessionEvent[] = [
    { kind: 'approval', phase: 'request', id: 'a', title: 'x', expiresAt: 50 },
    { kind: 'approval', phase: 'request', id: 'b', title: 'y', expiresAt: 500 },
    { kind: 'approval', phase: 'request', id: 'c', title: 'z', expiresAt: 500 },
    { kind: 'approval', phase: 'resolved', id: 'c', decision: 'deny', by: 'user' }
  ];
  assert.deepEqual([...openApprovals(evs, 100).keys()], ['b']);
});
