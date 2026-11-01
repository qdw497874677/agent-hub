import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubManagedBudget, toolClearStrategy, trimStrategy, TRIM_GUIDANCE, type ContextMessage } from './context-strategy.ts';
import { parseContextMessages } from './tools/context-tools.ts';

const m = (id: string, role: ContextMessage['role'], tokens: number, extra: Partial<ContextMessage> = {}): ContextMessage => ({ id, role, tokens, content: null, ...extra });
const state = { schemaVersion: 1, data: null };
const turns = (n: number) => [m('sys', 'system', 10), ...Array.from({ length: n }, (_, i) => [m(`u${i}`, 'user', 100), m(`a${i}`, 'assistant', 50, { calls: [`c${i}`] }), m(`t${i}`, 'tool', 300, { callId: `c${i}` })]).flat()];

test('trim：没过软上限不动；过了按整轮从用户消息处切，system 和最后一轮保留，加引导', async () => {
  const msgs = turns(10); // 4510 tokens
  const idle = await trimStrategy.transform!({ transcript: { messages: msgs, guidance: [] }, state, budget: hubManagedBudget(10_000, 4510) } as never);
  assert.equal(idle.view.messages.length, msgs.length);
  const out = await trimStrategy.transform!({ transcript: { messages: msgs, guidance: [] }, state, budget: hubManagedBudget(5000, 4510) } as never);
  const ids = out.view.messages.map((x) => x.id);
  assert.equal(ids[0], 'sys');
  assert.equal(ids[1]!.startsWith('u'), true, '切点在用户消息上');
  assert.ok(ids.includes('u9') && ids.includes('t9'));
  assert.ok(out.view.messages.reduce((n, x) => n + x.tokens, 0) <= 2500 + 10);
  assert.deepEqual(out.view.guidance, [TRIM_GUIDANCE]);
  assert.equal(out.events[0]!.kind, 'truncated');
});

test('tool-clear：只清最近 5 条之外的旧结果，消息不删、当前一轮不动', async () => {
  const msgs = [...turns(8), m('u-now', 'user', 10), m('t-now', 'tool', 300, { callId: 'x' })];
  const out = await toolClearStrategy.transform!({ transcript: { messages: msgs, guidance: [] }, state, budget: hubManagedBudget(4000, 3000) } as never);
  assert.equal(out.view.messages.length, msgs.length);
  const cleared = out.view.messages.filter((x) => x.cleared).map((x) => x.id);
  assert.deepEqual(cleared, ['t0', 't1', 't2']);
  assert.ok(!out.view.messages.find((x) => x.id === 't-now')!.cleared);
});

test('context.transform 入参：只收元数据，正文丢掉；格式不对整个拒', () => {
  const ok = parseContextMessages({ messages: [{ id: 'a', role: 'tool', tokens: 3.7, callId: 'c', content: 'SECRET' }] });
  assert.deepEqual(ok, [{ id: 'a', role: 'tool', tokens: 3, content: null, callId: 'c' }]);
  assert.equal(parseContextMessages({ messages: [{ id: 'a', role: 'hacker', tokens: 1 }] }), null);
  assert.equal(parseContextMessages({ messages: 'x' }), null);
});
