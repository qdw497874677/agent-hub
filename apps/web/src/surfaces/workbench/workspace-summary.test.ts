import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceSummary, workspaceSummaryTone } from './workspace-summary.ts';

test('workspaceSummary：没绑仓库时说清现在能做什么，空间也没有就一起说', () => {
  assert.equal(
    workspaceSummary({ repos: 0, mode: 'shared', spaces: 0, machines: 0 }),
    '还没绑仓库：现在只能在线关联已有目录，开不了 worktree。这台项目还没有登记空间。'
  );
  assert.equal(workspaceSummaryTone({ repos: 0 }), 'warn');
});

test('workspaceSummary：1 个仓库 + 共用，不提组合工作空间', () => {
  assert.equal(
    workspaceSummary({ repos: 1, mode: 'shared', spaces: 1 }),
    '在 1 个仓库上工作，任务共用长期空间。现在有 1 个空间。'
  );
  assert.equal(workspaceSummaryTone({ repos: 1 }), 'info');
});

test('workspaceSummary：多仓库 + 共用，补一句组合工作空间', () => {
  assert.equal(
    workspaceSummary({ repos: 3, mode: 'shared' }),
    '在 3 个仓库上工作，任务共用长期空间；需要并行时可在派生时选组合工作空间。'
  );
});

test('workspaceSummary：独立档说每任务一个 worktree', () => {
  assert.equal(
    workspaceSummary({ repos: 2, mode: 'isolated', spaces: 4 }),
    '在 2 个仓库上工作，每个任务开独立 worktree；派生时可以把几个仓库一起开成组合工作空间。现在有 4 个空间。'
  );
});

test('workspaceSummary：多于一台机器时报机器数', () => {
  assert.equal(
    workspaceSummary({ repos: 1, mode: 'shared', spaces: 5, machines: 2 }),
    '在 1 个仓库上工作，任务共用长期空间。在 2 台机器上共有 5 个空间。'
  );
  // 一台机器不啰嗦地报「在 1 台机器上」
  assert.equal(
    workspaceSummary({ repos: 1, mode: 'shared', spaces: 5, machines: 1 }),
    '在 1 个仓库上工作，任务共用长期空间。现在有 5 个空间。'
  );
});

test('workspaceSummary：空间还没读到时先不说那句', () => {
  assert.equal(workspaceSummary({ repos: 2, mode: 'shared' }), '在 2 个仓库上工作，任务共用长期空间；需要并行时可在派生时选组合工作空间。');
});
