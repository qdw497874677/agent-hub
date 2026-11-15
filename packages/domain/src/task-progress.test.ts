import test from 'node:test';
import assert from 'node:assert/strict';
import { milestoneText, createProgressBudget, PROGRESS_MAX_LINES } from '@agent-hub/domain';

test('进展文案：认得的工具说人话，认不得的原样带上', () => {
  assert.equal(milestoneText('bash'), '正在跑命令');
  assert.equal(milestoneText('grep'), '正在搜代码');
  assert.equal(milestoneText('deploy'), '正在用 deploy');
  assert.equal(milestoneText(null), '在执行下一步');
});

test('进展节流：开始/结束永远放行，阶段按间隔和条数收敛', () => {
  const budget = createProgressBudget({ minGapMs: 1_000, maxLines: 2 });
  assert.equal(budget.allow('t', 'started', 0), true);
  assert.equal(budget.allow('t', 'milestone', 100), true, '第一条阶段直接放行');
  assert.equal(budget.allow('t', 'milestone', 500), false, '间隔不够');
  assert.equal(budget.allow('t', 'milestone', 1_200), true);
  assert.equal(budget.allow('t', 'milestone', 9_999), false, `最多 ${2} 条自动阶段`);
  assert.equal(budget.allow('t', 'finished', 10_000), true, '结束不受限');
  budget.reset('t');
  assert.equal(budget.allow('t', 'milestone', 11_000), true, '结束后重新开始计数');
});

test('进展节流：默认上限不会让一条长任务刷屏', () => {
  const budget = createProgressBudget();
  let allowed = 0;
  for (let i = 0; i < 100; i++) if (budget.allow('t', 'milestone', i * 60_000)) allowed++;
  assert.equal(allowed, PROGRESS_MAX_LINES);
});
