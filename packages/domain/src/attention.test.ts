import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePhase, isAskTool, isUnknownOutcomeEnded } from './attention.ts';
import type { JournalEntry, SessionEvent } from './event.ts';

const log = (...events: SessionEvent[]): JournalEntry[] => events.map((event, i) => ({ seq: (i + 1) as never, event, at: 1000 + i }));
const done: SessionEvent = { kind: 'ended', outcome: 'done' };
const prompt: SessionEvent = { kind: 'prompt', text: '干活' };
const s = (status: 'running' | 'done' | 'failed' | 'interrupted' = 'done') => ({ status, updatedAt: 5 });

test('显式 ask 工具 → 等回答（不是「可能」）', () => {
  const v = derivePhase({ session: s(), now: 9e9, events: log(prompt, { kind: 'tool_call', name: 'AskUserQuestion', input: '{}' }, { kind: 'text', delta: '好的。' }, done) });
  assert.equal(v.phase, 'needs_answer');
  assert.equal(v.possible, undefined);
  assert.equal(v.since, 1003);
});

test('最后一句以问号结尾 → 只是「可能在等你」', () => {
  const v = derivePhase({ session: s(), now: 9e9, events: log(prompt, { kind: 'text', delta: '要我继续吗？' }, done) });
  assert.equal(v.phase, 'needs_answer');
  assert.equal(v.possible, true);
  assert.equal(v.reason, '可能在等你');
});

test('普通结束 → 空闲；这一轮 git commit 成功 → 等审查', () => {
  assert.equal(derivePhase({ session: s(), now: 9e9, events: log(prompt, { kind: 'text', delta: '改完了。' }, done) }).phase, 'idle');
  const v = derivePhase({ session: s(), now: 9e9, events: log(prompt,
    { kind: 'tool_call', name: 'bash', input: 'git commit -m x' }, { kind: 'tool_result', name: 'bash', ok: true, durationMs: 1 }, done) });
  assert.equal(v.phase, 'needs_review');
  // commit 失败不算
  assert.equal(derivePhase({ session: s(), now: 9e9, events: log(prompt,
    { kind: 'tool_call', name: 'bash', input: 'git commit -m x' }, { kind: 'tool_result', name: 'bash', ok: false, durationMs: 1 }, done) }).phase, 'idle');
});

test('这一轮挂上了 PR → 等审查；上一轮的 PR 不算', () => {
  const events = log(prompt, { kind: 'text', delta: '好了' }, done);
  assert.equal(derivePhase({ session: s(), now: 9e9, events, prCreatedAt: [1001] }).phase, 'needs_review');
  assert.equal(derivePhase({ session: s(), now: 9e9, events, prCreatedAt: [10] }).phase, 'idle');
});

test('审批优先于一切；过期的卡不算', () => {
  const req: SessionEvent = { kind: 'approval', phase: 'request', id: 'a', title: 'rm -rf build', expiresAt: 5000 };
  const v = derivePhase({ session: s('running'), now: 2000, events: log(prompt, req) });
  assert.equal(v.phase, 'needs_approval');
  assert.equal(v.expiresAt, 5000);
  assert.equal(derivePhase({ session: s('running'), now: 6000, events: log(prompt, req) }).phase, 'working');
});

test('失败 / 中断 → failed；未送达 → undelivered；排队 → queued', () => {
  assert.equal(derivePhase({ session: s('failed'), now: 9e9, events: log(prompt, { kind: 'ended', outcome: 'failed', reason: 'boom' }) }).reason, 'boom');
  assert.equal(derivePhase({ session: s('done'), now: 9e9, events: log(prompt, done), pending: [{ state: 'undelivered', updatedAt: 7 }] }).phase, 'undelivered');
  assert.equal(derivePhase({ session: s('done'), now: 9e9, events: log(prompt, done), pending: [{ state: 'queued', updatedAt: 7 }] }).phase, 'queued');
  // 失败后又发了新话（还没结束）不算失败
  assert.equal(derivePhase({ session: s('running'), now: 9e9, events: log(prompt, { kind: 'ended', outcome: 'failed' }, prompt) }).phase, 'working');
});

test('结果未知：只认 Hermes 落库的 ended 标记 → outcome_unknown，不和真失败 / 断连混在一起', () => {
  const unknown: SessionEvent = { kind: 'ended', outcome: 'interrupted', reason: 'Hermes 这一轮的结果未知（outcome_unknown）' };
  const v = derivePhase({ session: s('interrupted'), now: 9e9, events: log(prompt, unknown) });
  assert.equal(v.phase, 'outcome_unknown');
  assert.equal(v.reason, unknown.reason);
  assert.equal(v.since, 1001);
  // 真失败还是 failed：结果未知不会吞掉 failed
  assert.equal(derivePhase({ session: s('failed'), now: 9e9, events: log(prompt, { kind: 'ended', outcome: 'failed', reason: 'boom' }) }).phase, 'failed');
  // 普通断连（interrupted，但原因里没有标记）还是 failed，不会冒充结果未知
  assert.equal(derivePhase({ session: s('interrupted'), now: 9e9, events: log(prompt, { kind: 'ended', outcome: 'interrupted', reason: 'worker 断了' }) }).phase, 'failed');
  // 标记只对 interrupted 生效：done / failed 带着同样的字也不算结果未知
  assert.equal(derivePhase({ session: s('done'), now: 9e9, events: log(prompt, { kind: 'ended', outcome: 'done', reason: 'outcome_unknown' }) }).phase, 'idle');
  // 只在会话状态上动手（没有 ended 标记）推断不出结果未知
  assert.equal(derivePhase({ session: s('interrupted'), now: 9e9, events: log(prompt) }).phase, 'idle');
});

test('结果未知标记：ended · interrupted 且原因里带 outcome_unknown 才算', () => {
  assert.equal(isUnknownOutcomeEnded({ kind: 'ended', outcome: 'interrupted', reason: 'Hermes（outcome_unknown）' }), true);
  assert.equal(isUnknownOutcomeEnded({ kind: 'ended', outcome: 'interrupted', reason: 'worker 断了' }), false);
  assert.equal(isUnknownOutcomeEnded({ kind: 'ended', outcome: 'interrupted' }), false);
  assert.equal(isUnknownOutcomeEnded({ kind: 'ended', outcome: 'failed', reason: 'outcome_unknown' }), false);
  assert.equal(isUnknownOutcomeEnded({ kind: 'ended', outcome: 'interrupted', outcomeUnknown: true }), true);
  assert.equal(isUnknownOutcomeEnded({ kind: 'ended', outcome: 'done', outcomeUnknown: true }), true);
  assert.equal(isUnknownOutcomeEnded({ kind: 'ended', outcome: 'done', outcomeUnknown: false } as never), true);
  assert.equal(isUnknownOutcomeEnded({ kind: 'text', delta: 'outcome_unknown' }), false);
});

test('ask 工具名识别', () => {
  for (const n of ['ask_user', 'AskUserQuestion', 'mcp__hub__ask_user', 'request_user_input', 'ask_followup_question', 'AskUserQuestion: 选哪个方案']) assert.ok(isAskTool(n), n);
  for (const n of ['bash', 'task', 'ask', 'read_file']) assert.ok(!isAskTool(n), n);
});
