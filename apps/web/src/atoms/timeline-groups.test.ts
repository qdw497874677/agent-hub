import assert from 'node:assert/strict';
import { test } from 'node:test';
import { durationText, groupTimeline, recoveredFailures, summaryCounts } from './timeline-groups.ts';
import { applyBlocks, blocksFromEntries, type Block } from './live-core.ts';

const tool = (seq: number, name = 'read', ok: boolean | null = true, ms = 100) => ({
  kind: 'tool' as const, seq, name, input: JSON.stringify(name === 'bash' ? { command: 'ls' } : { path: 'a' }),
  result: ok === null ? null : { ok, durationMs: ms }
});
const prompt = (seq: number, queued = false) => ({ kind: 'prompt' as const, seq, queued });
const text = (seq: number) => ({ kind: 'text' as const, seq });
const thinking = (seq: number) => ({ kind: 'thinking' as const, seq });
const barrier = (seq: number, kind: string) => ({ kind, seq });

test('单个工具或思考也形成默认收起的活动', () => {
  for (const block of [tool(2), thinking(2)]) {
    const items = groupTimeline([prompt(1), block, text(3)], { running: false });
    assert.deepEqual(items.map((item) => item.type), ['block', 'work', 'block']);
    const group = items[1]!;
    assert.ok(group.type === 'work');
    assert.equal(group.open, false);
    assert.equal(group.summary.steps + group.summary.thinking, 1);
  }
});

test('正文交错保持原序、同轮一个摘要，下一轮独立', () => {
  const items = groupTimeline([
    prompt(1), text(2), tool(3), text(4), thinking(5), tool(6), text(7),
    prompt(8), tool(9), text(10)
  ], { running: false });
  assert.deepEqual(items.map((item) => item.type), ['block', 'block', 'work', 'block', 'block', 'work', 'block']);
  const groups = items.filter((item) => item.type === 'work');
  assert.deepEqual(groups[0]!.items.map((item) => item.block.seq), [3, 4, 5, 6]);
  assert.deepEqual(groups.map((group) => group.open), [false, false]);
  assert.equal(groups[0]!.summary.thinking, 1);
  assert.equal(groups[0]!.summary.steps, 2);
});

test('审批、问题、错误及明确显示的活动都是不可跨越的边界', () => {
  const blocks = [prompt(1), tool(2), barrier(3, 'approval'), tool(4), barrier(5, 'error'), tool(6, 'ask_user'), thinking(7)];
  const items = groupTimeline(blocks, { running: false, groupable: (block) => block.kind !== 'tool' || !('name' in block) || block.name !== 'ask_user' });
  assert.deepEqual(items.map((item) => item.type), ['block', 'work', 'block', 'work', 'block', 'block', 'work']);
  assert.deepEqual(items.flatMap((item) => item.type === 'block' ? [item.block.seq] : item.items.map((entry) => entry.block.seq)), [1, 2, 3, 4, 5, 6, 7]);
});

test('回放与运行中都默认收起；稍后排队的问话不会冒充新运行轮', () => {
  const blocks = [prompt(1), tool(2, 'read', null), prompt(3, true)];
  const live = groupTimeline(blocks, { running: true });
  const replay = groupTimeline(blocks, { running: false });
  assert.ok(live[1]?.type === 'work' && live[1].live && live[1].summary.running && !live[1].open);
  assert.ok(replay[1]?.type === 'work' && !replay[1].live && !replay[1].open);
});

test('流式思考 seq 改变时活动身份不变，回放同样分组', () => {
  let blocks: readonly Block[] = [];
  blocks = applyBlocks(blocks, { kind: 'prompt', text: '问题' }, 1);
  blocks = applyBlocks(blocks, { kind: 'thinking', delta: '一' }, 2);
  const first = groupTimeline(blocks, { running: true })[1];
  blocks = applyBlocks(blocks, { kind: 'thinking', delta: '二' }, 3);
  const next = groupTimeline(blocks, { running: true })[1];
  assert.ok(first?.type === 'work' && next?.type === 'work');
  assert.notEqual(first.items[0]!.block.seq, next.items[0]!.block.seq);
  assert.equal(first.key, next.key);
  const replay = blocksFromEntries([
    { seq: 1, at: 1, event: { kind: 'prompt', text: '问题' } },
    { seq: 2, at: 2, event: { kind: 'thinking', delta: '一' } },
    { seq: 3, at: 3, event: { kind: 'thinking', delta: '二' } }
  ]);
  assert.deepEqual(groupTimeline(replay, { running: true }), groupTimeline(blocks, { running: true }));
});

test('失败分级、计数和时长', () => {
  assert.deepEqual([...recoveredFailures([{ kind: 'shell', ok: false }, { kind: 'shell', ok: true }, { kind: 'read', ok: false }])], [0]);
  const [, group] = groupTimeline([prompt(1), tool(2, 'bash', false), tool(3, 'bash', true, 900)], { running: false });
  assert.ok(group && group.type === 'work');
  assert.equal(group.summary.failed, 0);
  assert.equal(group.summary.recovered, 1);
  assert.equal(group.items[0]!.recovered, true);
  assert.equal(summaryCounts(group.summary), '命令 2');
  assert.equal(durationText(group.summary.durationMs), '1s');
  assert.equal(durationText(0), '');
  assert.equal(durationText(1500), '1.5s');
  assert.equal(durationText(45_000), '45s');
  assert.equal(durationText(192_000), '3m12s');
});
