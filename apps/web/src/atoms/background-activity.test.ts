import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backgroundActivity,
  backgroundActivityText,
  BACKGROUND_QUIET_MS,
  type ActivityBlock
} from './background-activity.ts';

const NOW = 1_700_000_000_000;

function block(kind: ActivityBlock['kind'], at?: number): ActivityBlock {
  return at === undefined ? { kind } : { kind, at };
}

/** 一段普通对话：问一句、答一句、这一轮到此结束。 */
function finishedTurn(at = NOW - 10_000): ActivityBlock[] {
  return [block('prompt', at), block('text', at), block('ended', at + 1_000)];
}

test('回合还在跑：不显示后台活动（状态点自己会说）', () => {
  const activity = backgroundActivity([...finishedTurn(), block('tool', NOW)], 'running', NOW);
  assert.equal(activity.active, false);
  assert.equal(activity.count, 0);
  assert.equal(activity.quiet, false);
});

test('回合结束之后又来了一块：算后台活动，并数出条数', () => {
  const activity = backgroundActivity([...finishedTurn(), block('tool', NOW - 12_000)], 'done', NOW);
  assert.equal(activity.active, true);
  assert.equal(activity.count, 1);
  assert.equal(activity.lastAt, NOW - 12_000);
  assert.equal(activity.quiet, false);
});

test('回合结束之后超过一分钟没有新块：还在，但是「可能已结束」', () => {
  const activity = backgroundActivity([...finishedTurn(), block('text', NOW - 61_000)], 'done', NOW);
  assert.equal(activity.active, true);
  assert.equal(activity.quiet, true);
  assert.equal(backgroundActivityText(activity, NOW)?.text, '后台任务可能已结束');
});

test('count 只数 text / tool / subagent，别的一律不算输出', () => {
  const after = [
    block('text', NOW),
    block('tool', NOW),
    block('subagent', NOW),
    block('thinking', NOW),
    block('artifact', NOW),
    block('prompt', NOW),
    block('approval', NOW)
  ];
  const activity = backgroundActivity([...finishedTurn(), ...after], 'done', NOW);
  assert.equal(activity.count, 3);
});

test('没有 ended 标记的会话不误报：块都在这一轮里', () => {
  const blocks = [block('prompt', NOW), block('text', NOW - 1_000), block('tool', NOW - 500)];
  const activity = backgroundActivity(blocks, 'done', NOW);
  assert.equal(activity.active, false);
  assert.equal(activity.lastAt, null);
});

test('空块：什么都不说', () => {
  assert.deepEqual(backgroundActivity([], 'done', NOW), { active: false, count: 0, lastAt: null, quiet: false });
  assert.equal(backgroundActivityText(backgroundActivity([], 'done', NOW), NOW), null);
});

test('标记就是最后一块：没有后续活动，不算', () => {
  const activity = backgroundActivity(finishedTurn(), 'done', NOW);
  assert.equal(activity.active, false);
  assert.equal(backgroundActivityText(activity, NOW), null);
});

test('安静阈值可以放宽：三分钟前有过输出，五分钟阈值内仍算在跑', () => {
  const activity = backgroundActivity([...finishedTurn(), block('tool', NOW - 180_000)], 'done', NOW, 5 * 60_000);
  assert.equal(activity.active, true);
  assert.equal(activity.quiet, false);
  assert.equal(backgroundActivityText(activity, NOW)?.text, '后台任务还在跑 · 已 3 分钟');
});

test('文案：十几秒前就说多少秒前，不说「刚刚」', () => {
  const activity = backgroundActivity([...finishedTurn(), block('text', NOW - 12_000)], 'done', NOW);
  assert.equal(backgroundActivityText(activity, NOW)?.text, '后台任务还在跑 · 12 秒前');
  assert.match(backgroundActivityText(activity, NOW)?.detail ?? '', /1 条输出/);
});

test('没有时间戳（刷新后才知道的）只敢说「可能已结束」', () => {
  const activity = backgroundActivity([block('prompt'), block('text'), block('ended'), block('tool')], 'done', NOW);
  assert.equal(activity.active, true);
  assert.equal(activity.lastAt, null);
  assert.equal(activity.quiet, true);
});

test('默认安静阈值是一分钟', () => {
  assert.equal(BACKGROUND_QUIET_MS, 60_000);
  assert.equal(backgroundActivity([...finishedTurn(), block('tool', NOW - 59_000)], 'done', NOW).quiet, false);
  assert.equal(backgroundActivity([...finishedTurn(), block('tool', NOW - 61_000)], 'done', NOW).quiet, true);
});
