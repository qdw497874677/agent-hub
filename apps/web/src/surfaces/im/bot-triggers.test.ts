import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_TRIGGERS_EMPTY,
  BOT_TRIGGERS_EMPTY_HINT,
  TRIGGER_RUN_LABEL,
  latestRun,
  nextRunView,
  relativeDay,
  runView,
  sourceText,
  triggerStateView,
  type TriggerNextView
} from './bot-triggers.ts';
import type { BotTriggerDto } from '@agent-hub/contract';

/** 固定 now，测试不依赖真实时钟。 */
const NOW = new Date(2026, 10, 13, 12, 0).getTime(); // 2026-11-13 12:00 本地时间
const ago = (ms: number) => NOW - ms;
const later = (ms: number) => NOW + ms;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const run = (patch: Partial<BotTriggerDto['runs'][number]> = {}): BotTriggerDto['runs'][number] => ({
  id: 'run1', bindingId: 'b1', externalId: 'ext1', state: 'done',
  plannedAt: null, catchup: false, reason: null, sessionId: null,
  createdAt: ago(5 * MINUTE), updatedAt: ago(5 * MINUTE), ...patch
});

const trigger = (patch: Partial<BotTriggerDto> = {}): BotTriggerDto => ({
  id: 'b1', connector: 'timer', kind: 'tick', name: '定时巡检', target: 'main',
  projectId: null, enabled: true, pausedReason: null, consecutiveFailures: 0,
  nextRunAt: later(15 * MINUTE), mainSessionId: null,
  createdAt: ago(DAY), updatedAt: ago(DAY), runs: [run()], ...patch
});

test('相对时间：未来用「后」、过去用「前」，一天说「明天 / 昨天」', () => {
  assert.equal(relativeDay(later(15 * MINUTE), NOW), '15 分钟后');
  assert.equal(relativeDay(ago(3 * MINUTE), NOW), '3 分钟前');
  assert.equal(relativeDay(later(2 * HOUR), NOW), '2 小时后');
  assert.equal(relativeDay(ago(5 * HOUR), NOW), '5 小时前');
  assert.equal(relativeDay(later(DAY), NOW), '明天');
  assert.equal(relativeDay(ago(DAY), NOW), '昨天');
  assert.equal(relativeDay(ago(3 * DAY), NOW), '3 天前');
});

test('相对时间：不足一分钟说「马上 / 刚刚」，时钟抖动不出现负数', () => {
  assert.equal(relativeDay(later(20_000), NOW), '马上');
  assert.equal(relativeDay(ago(20_000), NOW), '刚刚');
  assert.equal(relativeDay(later(60_000), NOW), '1 分钟后');
});

test('相对时间：超过一周给绝对日期，便于核对', () => {
  assert.equal(relativeDay(new Date(2026, 9, 1, 8, 30).getTime(), NOW), '2026-10-01 08:30');
});

test('下次运行：启用 + 排了期给相对时间；过了点说「该跑了」', () => {
  const scheduled = nextRunView(trigger(), NOW);
  assert.equal(scheduled.prefix, '下次');
  assert.equal(scheduled.text, '15 分钟后');
  assert.equal(scheduled.tone, 'scheduled');

  const overdue = nextRunView(trigger({ nextRunAt: ago(3 * MINUTE) }), NOW);
  assert.equal(overdue.prefix, '该跑了');
  assert.equal(overdue.text, '3 分钟前');
  assert.equal(overdue.tone, 'overdue');
});

test('下次运行：暂停 / 停用 / 没排期都给确定的话，不显示时间戳', () => {
  const paused: TriggerNextView = nextRunView(trigger({ enabled: true, pausedReason: '连续失败 5 次' }), NOW);
  assert.deepEqual(paused, { prefix: '', text: '暂停期间不再唤醒', tone: 'paused' });
  assert.deepEqual(nextRunView(trigger({ enabled: false }), NOW), { prefix: '', text: '已停用', tone: 'idle' });
  assert.deepEqual(nextRunView(trigger({ nextRunAt: null }), NOW), { prefix: '', text: '还没排期', tone: 'idle' });
});

test('状态徽标：有暂停原因就算已暂停（enabled 可能还是 true）', () => {
  assert.deepEqual(triggerStateView(trigger()), { label: '启用', tone: 'on' });
  assert.deepEqual(triggerStateView(trigger({ pausedReason: '连续失败 5 次' })), { label: '已暂停', tone: 'paused' });
  assert.deepEqual(triggerStateView(trigger({ enabled: false })), { label: '已停用', tone: 'off' });
});

test('来源写成 connector · kind，窄屏靠断行不靠省略号', () => {
  assert.equal(sourceText({ connector: 'github', kind: 'issue' }), 'github · issue');
  assert.equal(sourceText({ connector: 'timer', kind: 'tick' }), 'timer · tick');
  // 来源自报了名字就用名字；没报（或清单里没有它）回落到 id
  assert.equal(sourceText({ connector: 'timer', kind: 'tick' }, [{ id: 'timer', label: '定时', kinds: ['tick'] }]), '定时 · tick');
  assert.equal(sourceText({ connector: 'nope', kind: 'x' }, [{ id: 'timer', label: '定时', kinds: ['tick'] }]), 'nope · x');
});

test('最近一次 run 按 createdAt 取最大，不假设后端排好序', () => {
  const old = run({ id: 'run-old', createdAt: ago(2 * HOUR) });
  const newest = run({ id: 'run-new', createdAt: ago(MINUTE) });
  assert.equal(latestRun([old, newest])?.id, 'run-new');
  assert.equal(latestRun([newest, old])?.id, 'run-new');
  assert.equal(latestRun([]), null);
});

test('一条 run 说清状态和时间：有 plannedAt 用它，否则用 created', () => {
  assert.equal(runView(run({ state: 'done' }), NOW), '完成 · 5 分钟前');
  assert.equal(runView(run({ state: 'failed', plannedAt: ago(HOUR) }), NOW), '失败 · 1 小时前');
  assert.equal(TRIGGER_RUN_LABEL.waiting, '等待中');
  assert.equal(TRIGGER_RUN_LABEL.timeout, '超时');
});

test('空态文案：说清去哪儿挂触发器，不再提「C4」', () => {
  assert.equal(BOT_TRIGGERS_EMPTY, '还没有触发器');
  assert.match(BOT_TRIGGERS_EMPTY_HINT, /连接器页/);
  assert.doesNotMatch(`${BOT_TRIGGERS_EMPTY}${BOT_TRIGGERS_EMPTY_HINT}`, /C4/);
});
