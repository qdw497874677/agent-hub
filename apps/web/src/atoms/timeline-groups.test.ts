import assert from 'node:assert/strict';
import { test } from 'node:test';
import { durationText, groupTimeline, recoveredFailures, summaryCounts } from './timeline-groups.ts';

const tool = (seq: number, name: string, input: object, ok: boolean | null, ms = 100) => ({
  kind: 'tool' as const,
  seq,
  name,
  input: JSON.stringify(input),
  result: ok === null ? null : { ok, durationMs: ms }
});
const prompt = (seq: number) => ({ kind: 'prompt' as const, seq });
const text = (seq: number) => ({ kind: 'text' as const, seq });

test('两个以上工具调用才成组；单个照旧一行', () => {
  const items = groupTimeline([prompt(1), tool(2, 'read', { path: 'a' }, true), text(3)], { running: false });
  assert.deepEqual(items.map((item) => item.type), ['block', 'block', 'block']);
  const grouped = groupTimeline([prompt(1), tool(2, 'read', { path: 'a' }, true), tool(3, 'bash', { command: 'ls' }, true), text(4)], { running: false });
  assert.deepEqual(grouped.map((item) => item.type), ['block', 'work', 'block']);
});

test('更早、已结束的轮默认收起；最后一轮展开', () => {
  const blocks = [
    prompt(1), tool(2, 'read', { path: 'a' }, true), tool(3, 'read', { path: 'b' }, true), text(4),
    prompt(5), tool(6, 'read', { path: 'a' }, true), tool(7, 'read', { path: 'b' }, true), text(8)
  ];
  const groups = groupTimeline(blocks, { running: false }).filter((item) => item.type === 'work');
  assert.deepEqual(groups.map((group) => group.type === 'work' && group.open), [false, true]);
});

test('失败后同类又成功 = 可恢复；摘要只把没救回来的算失败', () => {
  assert.deepEqual([...recoveredFailures([{ kind: 'shell', ok: false }, { kind: 'shell', ok: true }, { kind: 'read', ok: false }])], [0]);
  const [, group] = groupTimeline([prompt(1), tool(2, 'bash', { command: 'x' }, false), tool(3, 'bash', { command: 'y' }, true, 900)], { running: false });
  assert.ok(group && group.type === 'work');
  assert.equal(group.summary.failed, 0);
  assert.equal(group.summary.recovered, 1);
  assert.equal(group.items[0]!.recovered, true);
  assert.equal(summaryCounts(group.summary), '命令 2');
  assert.equal(durationText(group.summary.durationMs), '1s');
});

test('正在跑的最后一组是 live', () => {
  const items = groupTimeline([prompt(1), tool(2, 'read', { path: 'a' }, true), tool(3, 'bash', { command: 'y' }, null)], { running: true });
  const group = items[1]!;
  assert.ok(group.type === 'work' && group.live && group.summary.running);
});

test('时长文字', () => {
  assert.equal(durationText(0), '');
  assert.equal(durationText(1500), '1.5s');
  assert.equal(durationText(45_000), '45s');
  assert.equal(durationText(192_000), '3m12s');
});
