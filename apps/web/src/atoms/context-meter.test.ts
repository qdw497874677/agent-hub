import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampArc, contextAriaLabel, contextPercent, contextTitle, contextTone, meterValue, percentLabel, shortTokens } from './context-meter.ts';

test('clampArc：弧只在 0–1 里，超限停在整圈', () => {
  assert.equal(clampArc(0), 0);
  assert.equal(clampArc(42), 0.42);
  assert.equal(clampArc(99.5), 0.995);
  assert.equal(clampArc(100), 1);
  assert.equal(clampArc(118), 1);
  assert.equal(clampArc(-5), 0);
  assert.equal(clampArc(null), 0);
});

test('percentLabel：不到一个点写 <1%，不把没满的写成 100%', () => {
  assert.equal(percentLabel(0), '0%');
  assert.equal(percentLabel(0.4), '<1%');
  assert.equal(percentLabel(0.999), '<1%');
  assert.equal(percentLabel(1), '1%');
  assert.equal(percentLabel(42.4), '42%');
  assert.equal(percentLabel(42.6), '43%');
  assert.equal(percentLabel(99.4), '99%');
  // 99.6 四舍五入会变 100，但窗口没满就不能写 100
  assert.equal(percentLabel(99.6), '99%');
  assert.equal(percentLabel(99.99), '99%');
  assert.equal(percentLabel(100), '100%');
  // 超限：数字继续涨，弧才停住
  assert.equal(percentLabel(100.6), '101%');
  assert.equal(percentLabel(118.4), '118%');
  assert.equal(percentLabel(null), '—');
});

test('meterValue：aria-valuenow 和文案里的数字一致，封顶 100', () => {
  assert.equal(meterValue(null), 0);
  assert.equal(meterValue(0), 0);
  assert.equal(meterValue(0.4), 1);
  assert.equal(meterValue(42.4), 42);
  assert.equal(meterValue(42.6), 43);
  assert.equal(meterValue(99.6), 99);
  assert.equal(meterValue(100), 100);
  assert.equal(meterValue(118), 100);
});

test('meterValue 与 percentLabel 在 0–100 内说同一个数；超限的零头交给 aria-valuetext', () => {
  for (const percent of [0, 0.3, 1, 12.4, 42.5, 69.9, 70, 94.99, 95, 99.5, 99.6, 100]) {
    const label = percentLabel(percent);
    if (label === '<1%') assert.equal(meterValue(percent), 1, label);
    else assert.equal(meterValue(percent), Number(label.replace('%', '')), `${percent} → ${label}`);
  }
  // ARIA 的 valuenow 不能越过 valuemax：弧停住了，读屏靠 valuetext 听到 137%
  assert.equal(percentLabel(137.2), '137%');
  assert.equal(meterValue(137.2), 100);
});

test('tone：70 黄、95 红，边界归上一档', () => {
  assert.equal(contextTone(null), 'normal');
  assert.equal(contextTone(0), 'normal');
  assert.equal(contextTone(69.9), 'normal');
  assert.equal(contextTone(70), 'warn');
  assert.equal(contextTone(94.9), 'warn');
  assert.equal(contextTone(95), 'danger');
  assert.equal(contextTone(130), 'danger');
});

test('contextPercent：运行时给的优先，没给就按 used/window 现算', () => {
  assert.equal(contextPercent({ usedTokens: 84_000, windowTokens: 200_000, percent: 42 }), 42);
  assert.equal(contextPercent({ usedTokens: 84_000, windowTokens: 200_000, percent: null }), 42);
  assert.equal(contextPercent({ usedTokens: null, windowTokens: 200_000, percent: null }), null);
  assert.equal(contextPercent({ usedTokens: 100, windowTokens: 0, percent: null }), null);
  assert.equal(contextPercent({ usedTokens: 240_000, windowTokens: 200_000, percent: null }), 120);
  assert.equal(contextPercent({ usedTokens: 10, windowTokens: 200_000, percent: -3 }), 0);
});

test('人话：标题、读屏句、短数字', () => {
  const usage = { usedTokens: 84_000, windowTokens: 200_000, percent: 42 };
  assert.equal(contextTitle(usage, 42), '上下文：84,000 / 200,000 token（42%）');
  assert.equal(contextAriaLabel(usage, 42), '上下文已用 42%，84K / 200K');
  assert.equal(contextAriaLabel({ usedTokens: null, windowTokens: 200_000, percent: null }, null), '上下文用量未知，上限 200K');
  assert.equal(shortTokens(999), '999');
  assert.equal(shortTokens(1_500), '1.5K');
  assert.equal(shortTokens(2_000_000), '2M');
});
