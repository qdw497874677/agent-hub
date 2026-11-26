import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Block } from './live-core.ts';
import { advanceTurnClock, latestPromptSeq, turnProgress } from './turn-progress.ts';

const NOW = 1_700_000_000_000;

function prompt(seq = 1): Block {
  return { kind: 'prompt', text: '问一句', attachments: [], seq };
}

function text(delta = '答一句', seq = 2): Block {
  return { kind: 'text', text: delta, seq };
}

function thinking(seq = 2): Block {
  return { kind: 'thinking', text: '想一想', seq };
}

function tool(name: string, seq = 2): Block {
  return { kind: 'tool', name, input: '{}', result: null, seq };
}

function progress(blocks: readonly Block[], awaiting = true, startedAt = NOW - 6_000) {
  return turnProgress({ blocks, awaiting, startedAt, now: NOW, agentLabel: 'Codex' });
}

test('awaiting 为假：什么都不显示（回合结束，整行都得消失）', () => {
  assert.equal(progress([prompt(), text()], false), null);
  assert.equal(progress([], false), null);
});

test('刚发出去、还没有任何块：只说在等第一条输出（不宣称已经启动）', () => {
  const state = progress([]);
  assert.equal(state?.phase, 'starting');
  assert.equal(state?.label, '等 Codex 的第一条输出…');
  assert.equal(state?.seconds, 6);
});

test('有 prompt 但之后没块：仍然是在等第一条输出（第一段输出还没来）', () => {
  const state = progress([prompt()]);
  assert.equal(state?.phase, 'starting');
  assert.equal(state?.label, '等 Codex 的第一条输出…');
});

test('上一轮的块不算数：只看最后一条 prompt 之后', () => {
  // 分叉继承来的上一轮文本 + 刚发出的新 prompt：新回合还在启动。
  const state = progress([text('旧回复', 1), prompt(2)]);
  assert.equal(state?.phase, 'starting');
  assert.equal(state?.seconds, 6);
});

test('最后一块是工具调用：说出工具名', () => {
  const state = progress([prompt(), text('先看看', 2), tool('Bash', 3)]);
  assert.equal(state?.phase, 'tool');
  assert.equal(state?.label, '正在用 Bash…');
});

test('工具名过长截断到 20 个字符', () => {
  const name = 'mcp__some_very_long_server__do_something';
  const state = progress([prompt(), tool(name)]);
  assert.equal(state?.phase, 'tool');
  const shown = state?.label.replace(/^正在用 /, '').replace(/…$/, '');
  assert.ok((shown?.length ?? 0) <= 20, `工具名显示长度 ${shown?.length}`);
  assert.ok(state?.label.endsWith('…'));
});

test('文本已经在流：正在输出', () => {
  const state = progress([prompt(), text()]);
  assert.equal(state?.phase, 'writing');
  assert.equal(state?.label, '正在输出…');
});

test('思考过程也算在输出', () => {
  assert.equal(progress([prompt(), thinking()])?.phase, 'writing');
});

test('工具回来后又有文本：回到正在输出', () => {
  const returned: Block = { kind: 'tool', name: 'Bash', input: '{}', result: { ok: true, durationMs: 120 }, seq: 2 };
  const state = progress([prompt(), returned, text('完了', 3)]);
  assert.equal(state?.phase, 'writing');
});

test('工具已结束时不再说正在用，也不把之前的文本当成正在输出', () => {
  const settled: Block = { kind: 'tool', name: 'Bash', input: '{}', result: { ok: false, durationMs: 120 }, seq: 3 };
  const artifact: Block = { kind: 'artifact', path: 'a.png', bytes: 10, seq: 4 };
  for (const blocks of [[prompt(), settled], [prompt(), thinking(), settled, artifact]]) {
    const state = progress(blocks);
    assert.equal(state?.phase, 'tool-wait');
    assert.equal(state?.label, '工具已结束 · 等待模型回应…');
  }
});

test('非活动块不掩盖当前工具或后续输出；空文字也不是输出', () => {
  const artifact: Block = { kind: 'artifact', path: 'a.png', bytes: 10, seq: 4 };
  const settled: Block = { kind: 'tool', name: 'Bash', input: '{}', result: { ok: true, durationMs: 1 }, seq: 2 };
  assert.equal(progress([prompt(), tool('Bash'), artifact])?.phase, 'tool');
  assert.equal(progress([prompt(), settled, text('', 3), artifact])?.phase, 'tool-wait');
  assert.equal(progress([prompt(), settled, text('后续', 3), artifact])?.phase, 'writing');
});

test('计时身份使用当前会话与最新可见 prompt，不因普通块或 prompt 暂缺而重置', () => {
  const previous = [prompt(1), text('旧回复', 2)];
  const current = [...previous, prompt(3)];
  assert.equal(latestPromptSeq(current), 3);
  let clock = advanceTurnClock({ sessionId: 's', promptSeq: undefined, at: null }, 's', latestPromptSeq(previous), true, 100);
  clock = advanceTurnClock(clock, 's', latestPromptSeq(current), true, 200);
  assert.equal(clock.at, 200);
  clock = advanceTurnClock(clock, 's', latestPromptSeq([...current, text('新回复', 4)]), true, 300);
  assert.equal(clock.at, 200);
  clock = advanceTurnClock(clock, 's', undefined, true, 400);
  assert.equal(clock.at, 200);
  clock = advanceTurnClock(clock, 's', 3, true, 500);
  assert.equal(clock.at, 200);
  clock = advanceTurnClock(clock, 'other', 3, true, 600);
  assert.equal(clock.at, 600);
  clock = advanceTurnClock(clock, 'other', 3, false, 700);
  assert.equal(clock.at, null);
  clock = advanceTurnClock(clock, 'other', 3, true, 800);
  assert.equal(clock.at, 800);
});

test('只有登记类块（附件 / 产物）：在等模型回应，不说「已发送」', () => {
  assert.equal(progress([prompt(), { kind: 'artifact', path: 'a.png', bytes: 10, seq: 2 }])?.phase, 'waiting');
  assert.equal(progress([prompt(), { kind: 'artifact', path: 'a.png', bytes: 10, seq: 2 }])?.label, '等待模型回应…');
});

test('秒数取整：6.9 秒算 6 秒', () => {
  const state = progress([prompt()], true, NOW - 6_900);
  assert.equal(state?.seconds, 6);
});

test('秒数不会为负：时钟回拨 / 起点在将来也显示 0 秒', () => {
  const state = progress([prompt()], true, NOW + 5_000);
  assert.equal(state?.seconds, 0);
});

test('detail 给完整说明，并且包含「正在回复」', () => {
  const state = progress([prompt(), text()]);
  assert.ok(state?.detail.includes('正在回复'));
  assert.ok(state?.detail.includes('Codex'));
  assert.ok(!state?.detail.includes('秒'));
});
