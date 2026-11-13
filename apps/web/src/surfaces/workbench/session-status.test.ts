import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionDto } from '@agent-hub/contract';
import {
  activeSessions,
  elapsedLabel,
  phaseLabel,
  phaseTone,
  sessionPhase,
  settledSessions
} from './session-status.ts';

const at = (status: SessionDto['status'], settledAt?: number | null) => ({ status, ...(settledAt === undefined ? {} : { settledAt }) });

test('收起压过进程状态', () => {
  assert.equal(sessionPhase(at('running', 1_700_000_000_000)), 'settled');
  assert.equal(sessionPhase(at('failed', 1_700_000_000_000)), 'settled');
  // null / 缺字段都是「还在活跃列表」
  assert.equal(sessionPhase(at('done', null)), 'done');
  assert.equal(sessionPhase(at('done')), 'done');
});

test('五种存储状态各自映射', () => {
  assert.equal(sessionPhase(at('running')), 'working');
  assert.equal(sessionPhase(at('failed')), 'failed');
  assert.equal(sessionPhase(at('interrupted')), 'interrupted');
  assert.equal(sessionPhase(at('stopped')), 'stopped');
  assert.equal(sessionPhase(at('done')), 'done');
});

test('文案和底色', () => {
  assert.deepEqual(
    (['working', 'failed', 'interrupted', 'stopped', 'done', 'settled'] as const).map((phase) => phaseLabel(phase)),
    ['工作中', '失败了', '已中断', '已停止', '已完成', '已收起']
  );
  assert.deepEqual(
    (['working', 'failed', 'interrupted', 'stopped', 'done', 'settled'] as const).map((phase) => phaseTone(phase)),
    ['busy', 'bad', 'bad', 'idle', 'idle', 'idle']
  );
});

test('过了多久分四档，不跳到秒', () => {
  const now = 1_700_000_000_000;
  assert.equal(elapsedLabel(now - 59_000, now), '刚刚');
  assert.equal(elapsedLabel(now, now), '刚刚');
  assert.equal(elapsedLabel(now + 5_000, now), '刚刚');
  assert.equal(elapsedLabel(now - 60_000, now), '1 分钟');
  assert.equal(elapsedLabel(now - 45 * 60_000, now), '45 分钟');
  assert.equal(elapsedLabel(now - 3_600_000, now), '1 小时');
  assert.equal(elapsedLabel(now - 23 * 3_600_000, now), '23 小时');
  assert.equal(elapsedLabel(now - 86_400_000, now), '1 天');
  assert.equal(elapsedLabel(now - 9 * 86_400_000, now), '9 天');
});

test('切分活跃 / 收起，保持原顺序', () => {
  const a = at('running');
  const b = at('done', 1);
  const c = at('failed');
  const d = at('done', 2);
  assert.deepEqual(activeSessions([a, b, c, d]), [a, c]);
  assert.deepEqual(settledSessions([a, b, c, d]), [b, d]);
  assert.deepEqual(activeSessions([]), []);
});
