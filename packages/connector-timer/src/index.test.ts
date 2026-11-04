import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimerSource, everyMs, planFire, timerTick } from './index.ts';
import type { ConnectorBinding, InboundContext, InboundEvent } from '@agent-hub/domain';

const M = 60_000;
test('planFire：先认领下一次，不立刻触发', () => {
  assert.deepEqual(planFire(null, 15 * M, 1000), { action: 'claim', next: 1000 + 15 * M });
  assert.deepEqual(planFire(5000, 15 * M, 4000), { action: 'wait' });
});
test('planFire：到点触发；宽限 = 半个周期，错过多次只补最近一次', () => {
  const p = 10 * M;
  const on = planFire(0, p, 30_000);
  assert.equal(on.action, 'fire');
  if (on.action === 'fire') { assert.equal(on.next, p); assert.equal(on.catchup, false); assert.equal(on.missed, 0); }
  const late = planFire(0, p, 3 * p + 2 * M);
  assert.equal(late.action, 'fire');
  if (late.action === 'fire') { assert.equal(late.slot, 3 * p); assert.equal(late.next, 4 * p); assert.equal(late.catchup, true); assert.equal(late.missed, 3); }
  const tooLate = planFire(0, p, 3 * p + 6 * M);
  assert.equal(tooLate.action, 'skip');
});
test('everyMs：最短 5 分钟、默认 15', () => {
  assert.equal(everyMs({}), 15 * M);
  assert.equal(everyMs({ everyMin: 1 }), 5 * M);
});
test('validate：拒绝太短、没内容', () => {
  const t = createTimerSource();
  assert.match(t.validate('tick', { everyMin: 2, prompt: 'x' }) ?? '', /5/);
  assert.ok(t.validate('tick', { everyMin: 15, prompt: ' ' }));
  assert.equal(t.validate('tick', { everyMin: 15, prompt: '巡检' }), null);
  assert.ok(t.validate('other', { prompt: 'x' }));
});
test('tick：CAS 抢到才触发；抢不到不发', async () => {
  const b = { id: 'b1', enabled: true, pausedReason: null, nextRunAt: 0, params: { everyMin: 10, prompt: '看看' }, name: 'n' } as unknown as ConnectorBinding;
  const emitted: InboundEvent[] = [];
  let win = true;
  const ctx: InboundContext = { now: () => 1000, bindings: async () => [b], advance: async () => win, emit: async (_id, e) => { emitted.push(e); }, skip: async () => {} };
  await timerTick(ctx);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.externalId, '0');
  assert.equal(emitted[0]!.text, '看看');
  win = false;
  await timerTick(ctx);
  assert.equal(emitted.length, 1);
});
