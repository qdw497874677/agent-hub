import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalRepoUrl,
  chooseApprovalKey,
  DELEGATION_STATE_LABEL,
  delegationNeedsReconcile,
  delegationSummary,
  delegationTone,
  isSha,
  matchRepoForWorkspace,
  publishGate,
  publishOutcomeLine,
  readApprovalMemory,
  shortSha
} from './delegation.ts';
import type { DelegationDto, DelegationPublishDto } from './delegation-types.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function record(over: Partial<DelegationDto> = {}): DelegationDto {
  return {
    id: 'd1',
    coordinatorSessionId: 's1',
    requestKey: 'req-1',
    projectId: 'p1',
    taskId: 't1',
    repoId: 'r1',
    workerId: 'w1',
    baseBranch: 'main',
    baseSha: OTHER,
    instructions: '把按钮改宽一点',
    executionSessionId: 'x1',
    worktreePath: '/tmp/ws.delegation-abc',
    branch: 'delegation/abc',
    state: 'prepared',
    failure: null,
    createdAt: 1,
    updatedAt: 2,
    ...over
  };
}

function publish(over: Partial<DelegationPublishDto> = {}): DelegationPublishDto {
  return {
    delegationId: 'd1',
    state: 'prepared',
    projectId: 'p1',
    taskId: 't1',
    executionSessionId: 'x1',
    workerId: 'w1',
    repo: 'e2e/demo',
    branch: 'delegation/abc',
    baseBranch: 'main',
    baseSha: OTHER,
    failure: null,
    headSha: SHA,
    headUnavailable: null,
    attempt: null,
    createdAt: 1,
    updatedAt: 2,
    ...over
  };
}

test('六种派工状态都有中文说法，缺一种界面就会露出英文原值', () => {
  assert.deepEqual(Object.keys(DELEGATION_STATE_LABEL).sort(), [
    'cancelled',
    'failed',
    'pending',
    'prepared',
    'preparing',
    'uncertain'
  ]);
  for (const label of Object.values(DELEGATION_STATE_LABEL)) assert.match(label, /[\u4e00-\u9fa5]/);
  assert.equal(delegationTone('uncertain'), 'danger');
  assert.equal(delegationNeedsReconcile('uncertain'), true);
  assert.equal(delegationNeedsReconcile('failed'), false);
});

test('提交号只截短显示，完整值不接受伪造', () => {
  assert.equal(shortSha(SHA), 'aaaaaaa');
  assert.equal(shortSha(null), '—');
  assert.equal(isSha(SHA), true);
  assert.equal(isSha(SHA.toUpperCase()), false);
  assert.equal(isSha('abc'), false);
});

test('同一提交重试复用批准键，换提交就换新键', () => {
  const first = chooseApprovalKey('d1', SHA, null, () => 'key-1');
  assert.deepEqual(first.memory, { delegationId: 'd1', headSha: SHA, approvalKey: 'key-1' });
  assert.equal(first.changed, true);

  const retry = chooseApprovalKey('d1', SHA, first.memory, () => 'key-2');
  assert.equal(retry.memory.approvalKey, 'key-1');
  assert.equal(retry.changed, false);

  const moved = chooseApprovalKey('d1', OTHER, first.memory, () => 'key-2');
  assert.equal(moved.memory.approvalKey, 'key-2');
  assert.equal(moved.changed, true);
});

test('存储里的记录坏掉时不炸：当成没有记录', () => {
  assert.equal(readApprovalMemory(null), null);
  assert.equal(readApprovalMemory(''), null);
  assert.equal(readApprovalMemory('not json'), null);
  assert.equal(readApprovalMemory('{"delegationId":"d1"}'), null);
  assert.deepEqual(readApprovalMemory('{"delegationId":"d1","headSha":"x","approvalKey":"k"}'), {
    delegationId: 'd1',
    headSha: 'x',
    approvalKey: 'k'
  });
});

test('仓库匹配按 HTTPS 地址去掉 .git、尾斜杠和大小写', () => {
  const repos = [{ id: 'r1', url: 'https://github.com/E2E/Demo.git' }];
  assert.equal(matchRepoForWorkspace(repos, 'https://github.com/e2e/demo/')?.id, 'r1');
  assert.equal(matchRepoForWorkspace(repos, 'https://github.com/e2e/other'), null);
  assert.equal(matchRepoForWorkspace(repos, null), null);
  assert.equal(canonicalRepoUrl('https://github.com/E2E/Demo.git/'), 'https://github.com/e2e/demo');
});

test('只有「已就绪 + 有权威 head + 未发布过」才放行发布', () => {
  assert.deepEqual(publishGate(publish()), { kind: 'ready', headSha: SHA });

  const noHead = publishGate(publish({ headSha: null, headUnavailable: '工作区不在这个 worker 上' }));
  assert.deepEqual(noHead, { kind: 'blocked', reason: '工作区不在这个 worker 上' });

  const notPrepared = publishGate(publish({ state: 'preparing' }));
  assert.equal(notPrepared.kind, 'blocked');
  assert.match(notPrepared.kind === 'blocked' ? notPrepared.reason : '', /正在建独立目录/);

  const uncertain = publishGate(
    publish({
      attempt: {
        state: 'uncertain',
        headSha: SHA,
        remote: null,
        pullRequest: null,
        failure: null,
        createdAt: 3,
        updatedAt: 4
      }
    })
  );
  assert.equal(uncertain.kind, 'blocked');
  assert.match(uncertain.kind === 'blocked' ? uncertain.reason : '', /先对账/);

  const published = publishGate(
    publish({
      attempt: {
        state: 'published',
        headSha: SHA,
        remote: null,
        pullRequest: {
          repo: 'e2e/demo',
          number: 41,
          url: 'https://github.com/e2e/demo/pull/41',
          headRef: 'delegation/abc',
          headSha: SHA,
          base: 'main',
          baseRepo: 'e2e/demo',
          state: 'open',
          draft: true
        },
        failure: null,
        createdAt: 3,
        updatedAt: 4
      }
    })
  );
  assert.equal(published.kind, 'blocked');
  assert.match(published.kind === 'blocked' ? published.reason : '', /已经建好/);
});

test('结果一句话只报到草稿 PR，不说已合并', () => {
  assert.equal(publishOutcomeLine(publish()), '还没有发布过');
  const line = publishOutcomeLine(
    publish({
      attempt: {
        state: 'published',
        headSha: SHA,
        remote: null,
        pullRequest: {
          repo: 'e2e/demo',
          number: 41,
          url: 'https://github.com/e2e/demo/pull/41',
          headRef: 'delegation/abc',
          headSha: SHA,
          base: 'main',
          baseRepo: 'e2e/demo',
          state: 'open',
          draft: true
        },
        failure: null,
        createdAt: 3,
        updatedAt: 4
      }
    })
  );
  assert.equal(line, '草稿 PR #41 已创建：e2e/demo');
  assert.doesNotMatch(line, /合并|merge/);
});

test('列表摘要带任务、基线和分支，未知任务也不留空白', () => {
  assert.equal(delegationSummary(record(), '修按钮'), '修按钮 · 基线 main · delegation/abc');
  assert.equal(delegationSummary(record({ baseBranch: '  ', branch: '' }), null), '未知任务 · 基线 未知基线 · （无分支）');
});
