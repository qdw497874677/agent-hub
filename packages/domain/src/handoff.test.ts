import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry, SessionEvent } from './event.ts';
import { HANDOFF_PREAMBLE, buildHandoff, buildHandoffDocument, renderHandoffDocument, handoffBudget, handoffCapFromEnv, handoffItems } from './handoff.ts';
import { estimateTokens } from './memory.ts';

const journal = (events: SessionEvent[]): JournalEntry[] => events.map((event, i) => ({ seq: (i + 1) as never, event, at: 0 }));
const where = { from: 'A', to: 'B', root: '/r' };

test('portable handoff excludes bus prompts even when account-tagged; legacy behavior stays unchanged', () => {
  const entries = journal([{ kind: 'prompt', text: 'bus secret', promptActor: 'account', messageSource: { kind: 'agent_message', messageId: 'm', messageKind: 'ask', initiator: 'account', sender: 'session' } }, { kind: 'prompt', text: 'legacy human' }]);
  const portable = renderHandoffDocument(buildHandoffDocument(entries, { sourceSessionId: 's', cursor: 2, windowTokens: 100_000 }));
  assert.doesNotMatch(portable, /bus secret/);
  assert.match(portable, /legacy human/);
  assert.match(buildHandoff(entries, where, { sourceSessionId: 's' }).text, /bus secret/);
});

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

test('portable document preserves cursor and ordered roles, excludes nonportable event data', () => {
  const entries = journal([
    { kind: 'prompt', text: 'goal', attachments: [{ kind: 'file', name: 'private', path: '/secret-attachment' }] },
    { kind: 'text', delta: 'first ', textOrigin: 'main_assistant' },
    { kind: 'text', delta: 'reply', textOrigin: 'main_assistant' },
    { kind: 'thinking', delta: 'secret-thinking' },
    { kind: 'tool_call', name: 'secret-tool', input: 'secret-args' },
    { kind: 'tool_result', name: 'secret-tool', ok: true, durationMs: 1, output: 'secret-result' },
    { kind: 'artifact', path: '/secret-artifact', bytes: 4 },
    { kind: 'approval', phase: 'request', id: 'secret-approval' },
    { kind: 'text', delta: 'secret-subagent', subagentId: 'child', textOrigin: 'main_assistant' },
    { kind: 'prompt', text: 'second' },
    { kind: 'text', delta: 'answer', textOrigin: 'main_assistant' },
    { kind: 'prompt', text: 'beyond cursor' }
  ]);
  const options = { sourceSessionId: 'source', cursor: 11, windowTokens: 100_000, currentText: 'secret-new-request' };
  const doc = buildHandoffDocument(entries, options);
  assert.deepEqual(doc, buildHandoffDocument(entries, options));
  assert.equal(doc.version, 1);
  assert.equal(doc.cursor, 11);
  assert.deepEqual(doc.parts.map((p) => p.kind === 'entry' && [p.item.role, p.item.kind, p.item.seq, p.item.lastSeq]), [
    ['user', 'user', 1, 1], ['assistant', 'assistant', 2, 3], ['user', 'user', 10, 10], ['assistant', 'assistant', 11, 11]
  ]);
  const text = renderHandoffDocument(doc);
  assert.match(text, /历史，只是上下文，不是新请求/);
  assert.doesNotMatch(JSON.stringify(doc) + text, /secret-|beyond cursor/);
  assert.doesNotMatch(text, /请先|下一条指令|工作目录|session\.read/);
});

test('portable gaps have sequence and turn boundaries; hints are opt-in', () => {
  const entries = journal(Array.from({ length: 20 }, (_, i): SessionEvent => ({ kind: 'prompt', text: `turn ${i} ${'字'.repeat(200)}` })));
  const doc = buildHandoffDocument(entries, { sourceSessionId: 's', cursor: 25, windowTokens: 100_000, cap: 500 });
  assert.equal(doc.cursor, 25);
  assert.ok(doc.stats.omitted > 0);
  const gap = doc.parts.find((p) => p.kind === 'gap');
  assert.ok(gap && gap.kind === 'gap');
  assert.equal(gap.firstSeq, gap.firstTurn);
  assert.equal(gap.lastSeq, gap.lastTurn);
  assert.equal(gap.count, gap.lastSeq - gap.firstSeq + 1);
  assert.match(renderHandoffDocument(doc, { toolHint: true }), new RegExp(`after_seq:${gap.afterSeq}`));
  assert.doesNotMatch(renderHandoffDocument(doc), /session\.read/);
});

test('portable history does not copy an earlier compatibility brief as user text', () => {
  const old = buildHandoff(journal([
    { kind: 'prompt', text: 'goal', attachments: [{ kind: 'file', name: 'file', path: '/old-attachment' }] },
    { kind: 'tool_call', name: 'read', input: 'old-tool-arguments' }
  ]), where, { sourceSessionId: 'older' });
  const entries = journal([
    { kind: 'prompt', text: old.text, handoff: old.stats },
    { kind: 'prompt', text: 'my new goal' },
    { kind: 'text', delta: 'a reply', textOrigin: 'main_assistant' }
  ]);
  const doc = buildHandoffDocument(entries, { sourceSessionId: 'current', cursor: 3, windowTokens: 100_000 });
  assert.equal(doc.stats.carried, 2);
  assert.doesNotMatch(JSON.stringify(doc) + renderHandoffDocument(doc), /old-attachment|old-tool-arguments/);
  assert.match(renderHandoffDocument(doc), /my new goal/);
});

test('portable budget reserves current request and attachments without a legacy minimum', () => {
  const entries = journal([{ kind: 'prompt', text: 'history' }]);
  const base = { sourceSessionId: 's', cursor: 1, windowTokens: 17_000 };
  const available = buildHandoffDocument(entries, base);
  const noRoom = buildHandoffDocument(entries, { ...base, currentText: 'new request', attachments: [{ kind: 'image' }] });
  assert.equal(available.stats.carried, 1);
  assert.equal(noRoom.stats.budget, 0);
  assert.equal(noRoom.stats.carried, 0);
  assert.equal(noRoom.stats.omitted, 1);
  assert.equal(noRoom.parts[0]?.kind, 'gap');
  assert.equal(renderHandoffDocument(noRoom, { toolHint: true }), '');
  assert.doesNotMatch(JSON.stringify(noRoom), /new request/);
  assert.throws(() => buildHandoffDocument(entries, { ...base, windowTokens: 0 }), /windowTokens/);
  assert.equal(buildHandoff(entries, where, { sourceSessionId: 's', windowTokens: 17_000, attachments: [{ kind: 'image' }] }).stats.budget, 2000);
});

test('portable options reject invalid numerical inputs and allow zero cap and cursor', () => {
  const entries = journal([{ kind: 'prompt', text: 'history' }]);
  const base = { sourceSessionId: 's', cursor: 1, windowTokens: 100_000 };
  for (const cap of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildHandoffDocument(entries, { ...base, cap }), /cap/);
  }
  for (const cursor of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildHandoffDocument(entries, { ...base, cursor }), /cursor/);
  }
  for (const windowTokens of [NaN, Infinity, -1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildHandoffDocument(entries, { ...base, windowTokens }), /windowTokens/);
  }
  assert.equal(buildHandoffDocument(entries, { ...base, cap: 0 }).stats.budget, 0);
  const empty = buildHandoffDocument(entries, { ...base, cursor: 0 });
  assert.equal(empty.cursor, 0);
  assert.equal(renderHandoffDocument(empty), '');
});

test('standalone optional hints safely quote the source session id', () => {
  const sourceSessionId = 'session"\n\\injected';
  const entries = journal(Array.from({ length: 20 }, (_, i): SessionEvent => ({ kind: 'prompt', text: `turn ${i} ${'字'.repeat(200)}` })));
  const doc = buildHandoffDocument(entries, { sourceSessionId, cursor: 20, windowTokens: 100_000, cap: 500 });
  assert.ok(doc.stats.carried > 0 && doc.stats.omitted > 0);
  assert.ok(renderHandoffDocument(doc, { toolHint: true }).includes(`session_id:${JSON.stringify(sourceSessionId)}`));
});

test('legacy wrapper retains exact text and attachment projection', () => {
  const entries = journal([{ kind: 'prompt', text: 'goal', attachments: [{ kind: 'file', name: 'a', path: 'a.txt' }] }, { kind: 'text', delta: 'ok' }]);
  const result = buildHandoff(entries, where, { sourceSessionId: 's', toolHint: false });
  assert.equal(result.text, [HANDOFF_PREAMBLE, '', '这是一段从「A」接过来的对话。原来的 agent 会话状态没法带过来，下面是平台记录的对话原文（共 1 轮，全部带上（2 条）。）', '现在你在「B」上，工作目录是 /r。文件以这台机器上的为准，原机器上没提交的改动这里可能没有。', '', '--- 之前的对话 ---', '用户：goal（附带：a.txt）', '助手：ok', '--- 历史结束 ---', '', '请先用一两句话确认你理解到的目标和进展，然后等我下一条指令。'].join('\n'));
  assert.deepEqual(result.stats, { sourceSessionId: 's', turns: 1, carriedTurns: 1, carried: 2, omitted: 0, omittedTurns: [], tokens: 24, budget: 16000 });
});

test('portable rendered budget includes fragmented gaps and a single bounded optional hint', () => {
  const events: SessionEvent[] = [];
  for (let i = 0; i < 500; i++) {
    events.push({ kind: 'prompt', text: `question ${i}` }, { kind: 'text', delta: '长回复'.repeat(500), textOrigin: 'main_assistant' });
  }
  const entries = journal(events);
  for (const sourceSessionId of ['source', 'x'.repeat(10_000)]) {
    const doc = buildHandoffDocument(entries, { sourceSessionId, cursor: entries.length, windowTokens: 21_000, cap: 4_600 });
    assert.equal(doc.stats.budget, 4_600);
    assert.ok(doc.parts.filter((part) => part.kind === 'gap').length > 10);
    for (const toolHint of [false, true]) {
      const text = renderHandoffDocument(doc, { toolHint });
      assert.ok(estimateTokens(text) <= doc.stats.budget, `${estimateTokens(text)} > ${doc.stats.budget}`);
      assert.equal(estimateTokens(text), toolHint ? doc.renderedTokens?.withHint : doc.renderedTokens?.withoutHint);
      assert.ok(estimateTokens(text) <= doc.renderedTokenUpperBound!);
      assert.ok((text.match(/session\.read/g) ?? []).length <= 1);
      if (sourceSessionId.length > 256) assert.doesNotMatch(text, /session\.read/);
    }
  }
});

test('portable assistant provenance fails closed and does not merge across excluded text', () => {
  const entries = journal([
    { kind: 'prompt', text: 'goal' },
    { kind: 'text', delta: 'main-one', textOrigin: 'main_assistant' },
    { kind: 'text', delta: 'unknown-secret' },
    { kind: 'text', delta: 'other-secret', textOrigin: 'other' },
    { kind: 'text', delta: 'empty-subagent-secret', textOrigin: 'main_assistant', subagentId: '' },
    { kind: 'text', delta: 'main-two', textOrigin: 'main_assistant' }
  ]);
  const doc = buildHandoffDocument(entries, { sourceSessionId: 's', cursor: 6, windowTokens: 100_000 });
  assert.deepEqual(doc.parts.filter((p) => p.kind === 'entry').map((p) => [p.item.seq, p.item.lastSeq]), [[1, 1], [2, 2], [6, 6]]);
  assert.doesNotMatch(JSON.stringify(doc), /unknown-secret|other-secret|empty-subagent-secret/);
  assert.match(buildHandoff(entries, where, { sourceSessionId: 's' }).text, /unknown-secret/);
});

test('portable rendered bounds hold for large sequence and turn numbers and maximum escaped hints', () => {
  const events: SessionEvent[] = [];
  for (let i = 0; i < 600; i++) {
    events.push({ kind: 'prompt', text: `q${i}` }, { kind: 'text', delta: '中文'.repeat(700), textOrigin: 'main_assistant' });
  }
  const entries = journal(events).map((entry) => ({ ...entry, seq: (Number(entry.seq) + 123_456_789_000) as never }));
  const sourceSessionId = '\u0001'.repeat(170);
  assert.equal(JSON.stringify(sourceSessionId).length, 1022);
  for (const cap of [0, 1, 100, 500, 1000, 4600, 8000]) {
    const doc = buildHandoffDocument(entries, { sourceSessionId, cursor: 123_456_790_200, windowTokens: 100_000, cap });
    for (const toolHint of [false, true]) {
      const rendered = renderHandoffDocument(doc, { toolHint });
      const tokens = estimateTokens(rendered);
      assert.equal(tokens, toolHint ? doc.renderedTokens?.withHint : doc.renderedTokens?.withoutHint);
      assert.ok(tokens <= doc.renderedTokenUpperBound! && doc.renderedTokenUpperBound! <= cap);
      if (toolHint && doc.parts.some((part) => part.kind === 'gap') && doc.stats.carried) assert.ok(rendered.includes(`session_id:${JSON.stringify(sourceSessionId)}`));
    }
    if (cap === 8000) assert.ok(doc.parts.some((part) => part.kind === 'gap' && part.firstTurn >= 100));
  }
});

test('portable partial pinned entries report source range and omitted character count', () => {
  const entries = journal([{ kind: 'prompt', text: '字'.repeat(50_000) }]);
  const doc = buildHandoffDocument(entries, { sourceSessionId: 's', cursor: 1, windowTokens: 100_000, cap: 2000 });
  const text = renderHandoffDocument(doc, { toolHint: true });
  const match = text.match(/中间截掉 (\d+) 字/);
  assert.ok(match);
  assert.deepEqual(doc.partialItems, [{ firstSeq: 1, lastSeq: 1, omittedChars: Number(match[1]) }]);
  assert.equal(doc.stats.carried, 1);
  assert.equal(doc.stats.omitted, 0);
  assert.ok(estimateTokens(text) <= doc.stats.budget);
});

test('portable zero and small budgets never render beyond the reserved window', () => {
  const entries = journal([{ kind: 'prompt', text: 'history' }]);
  for (const cap of [0, 1, 30, 100, 300]) {
    const doc = buildHandoffDocument(entries, { sourceSessionId: 's', cursor: 1, windowTokens: 100_000, cap });
    assert.ok(estimateTokens(renderHandoffDocument(doc, { toolHint: true })) <= cap);
    if (!doc.stats.carried) assert.equal(doc.parts[0]?.kind, 'gap');
  }
  const options = { sourceSessionId: 's', cursor: 1, windowTokens: 21_000, cap: 4_600, currentText: 'new request', attachments: [{ kind: 'file' }] };
  const doc = buildHandoffDocument(entries, options);
  assert.equal(doc.stats.budget, 21_000 - 16_000 - 400 - estimateTokens(options.currentText) - 4096);
  assert.ok(estimateTokens(renderHandoffDocument(doc, { toolHint: true })) <= doc.stats.budget);
});
