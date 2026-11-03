import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry, SessionEvent } from './event.ts';
import { HANDOFF_PREAMBLE, buildHandoff, handoffBudget, handoffCapFromEnv, handoffItems } from './handoff.ts';

const journal = (events: SessionEvent[]): JournalEntry[] => events.map((event, i) => ({ seq: (i + 1) as never, event, at: 0 }));
const where = { from: 'A', to: 'B', root: '/r' };

test('交接条目：工具调用和结果配成一条，带 ✓/✗、耗时、截短的输出', () => {
  const items = handoffItems(journal([
    { kind: 'prompt', text: '跑测试' },
    { kind: 'tool_call', name: 'bash', input: 'npm test' },
    { kind: 'tool_result', name: 'bash', ok: false, durationMs: 1200, output: 'y'.repeat(2000) + 'FAIL' },
    { kind: 'text', delta: '挂了' }
  ]));
  assert.equal(items.length, 3);
  assert.match(items[1]!.text, /^\[工具\] bash ✗ 1\.2s\n输入：npm test\n输出（截短）：…y+FAIL$/);
  assert.ok(items[1]!.text.length < 800);
  assert.equal(items[1]!.lastSeq, 3);
});

test('交接：放得下就全带；有防注入前言；统计对', () => {
  const r = buildHandoff(journal([{ kind: 'prompt', text: '目标' }, { kind: 'text', delta: '好' }]), where, { sourceSessionId: 's1' });
  assert.ok(r.text.startsWith(HANDOFF_PREAMBLE));
  assert.equal(r.stats.omitted, 0);
  assert.equal(r.stats.carried, 2);
  assert.equal(r.stats.turns, 1);
  assert.doesNotMatch(r.text, /省略了/);
});

test('交接：太长时整条挑选，保留第一句和最近，标出省略的轮次并给 session.read', () => {
  const events: SessionEvent[] = [];
  for (let t = 1; t <= 40; t++) {
    events.push({ kind: 'prompt', text: t === 1 ? '目标：重构' : t === 40 ? '最后一句' : `第${t}问` });
    events.push({ kind: 'tool_call', name: 'read', input: `f${t}` });
    events.push({ kind: 'tool_result', name: 'read', ok: true, durationMs: 10, output: '内容'.repeat(300) });
    events.push({ kind: 'text', delta: `回答${t} `.repeat(200) });
  }
  const r = buildHandoff(journal(events), where, { sourceSessionId: 's1', cap: 4000 });
  assert.match(r.text, /目标：重构/);
  assert.match(r.text, /最后一句/);
  assert.match(r.text, /回答40/);
  assert.match(r.text, /这里省略了第 \d+–\d+ 轮里的 \d+ 条，可用 session\.read\(\{session_id:"s1", after_seq:\d+\}\)/);
  assert.equal(r.stats.turns, 40);
  assert.ok(r.stats.omitted > 0 && r.stats.carried > 0);
  assert.ok(r.stats.tokens <= r.stats.budget);
  assert.equal(r.stats.budget, 4000);
  assert.ok(r.stats.omittedTurns.length > 0);
  // 不在中间切断一条普通回复
  assert.doesNotMatch(r.text, /中间截掉/);
});

test('交接：钉住的单条太大才截头尾', () => {
  const r = buildHandoff(journal([{ kind: 'prompt', text: '字'.repeat(50_000) }]), where, { sourceSessionId: 's', cap: 2000 });
  assert.match(r.text, /这条太长，中间截掉 \d+ 字/);
  assert.equal(r.stats.carried, 1);
});

test('预算：窗口减余量，夹在 [2k, cap]；环境变量不合法用默认', () => {
  assert.equal(handoffBudget({ windowTokens: 128_000 }), 16_000);
  assert.equal(handoffBudget({ windowTokens: 24_000 }), 8_000);
  assert.equal(handoffBudget({ windowTokens: 8_000 }), 2_000);
  assert.equal(handoffBudget({ windowTokens: 1_000_000, cap: 50_000 }), 50_000);
  assert.equal(handoffCapFromEnv(undefined), 16_000);
  assert.equal(handoffCapFromEnv('abc'), 16_000);
  assert.equal(handoffCapFromEnv('30000'), 30_000);
});
