import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTrial } from './worker-update.ts';

const base = { startedAt: 0, connectedAt: 0, link: 'live' as const, inventoryApplied: true, online: true };

test('试运行：健康且这条连接稳定满 60 秒就提交，不到就等并给出剩余时间', () => {
  assert.deepEqual(decideTrial(base, 60_000), { kind: 'commit' });
  const wait = decideTrial(base, 18_000);
  assert.equal(wait.kind, 'wait');
  assert.equal(wait.kind === 'wait' && wait.remainingMs, 42_000);
  assert.equal(wait.kind === 'wait' && wait.deadlineAt, 300_000);
});

test('试运行：重连重置稳定窗口；没报 inventory / 连接不健康 / 离线都不提交', () => {
  assert.equal(decideTrial({ ...base, connectedAt: 30_000 }, 60_000).kind, 'wait');
  assert.equal(decideTrial({ ...base, inventoryApplied: false }, 120_000).kind, 'wait');
  assert.equal(decideTrial({ ...base, link: 'degraded' }, 120_000).kind, 'wait');
  assert.equal(decideTrial({ ...base, online: false }, 120_000).kind, 'wait');
});

test('试运行：5 分钟内没通过就回退，原因说清楚', () => {
  const abort = decideTrial({ ...base, online: false }, 300_000);
  assert.equal(abort.kind, 'abort');
  assert.match(abort.kind === 'abort' ? abort.reason : '', /掉线/);
  assert.match((decideTrial({ ...base, inventoryApplied: false }, 300_000) as { reason: string }).reason, /套件清单/);
  assert.equal(decideTrial({ ...base, connectedAt: 250_000 }, 300_000).kind, 'abort');
});
