import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEnvironmentDto } from '@agent-hub/contract';
import { environmentNotice } from './environment-notice.ts';

function status(patch: Partial<SessionEnvironmentDto> = {}): SessionEnvironmentDto {
  return { revision: 'r-new', appliedRevision: 'r-old', pending: true, supported: true, ...patch };
}

test('环境待生效：说清下一轮才生效，不报警', () => {
  const notice = environmentNotice(status());
  assert.equal(notice?.text, '环境已更新 · 下一轮对话生效');
  assert.match(notice?.detail ?? '', /下一轮对话/);
  assert.doesNotMatch(notice?.text ?? '', /失败|错误|异常/);
});

test('环境已生效：不显示', () => {
  assert.equal(environmentNotice(status({ revision: 'r-same', appliedRevision: 'r-same', pending: false })), null);
});

test('部署不支持环境版本：不显示，也不假装 pending', () => {
  assert.equal(environmentNotice(status({ supported: false, pending: false, revision: null })), null);
  // 后端说过 supported:false 时 pending 恒为 false；这里额外守住「就算写错了也不显示」。
  assert.equal(environmentNotice(status({ supported: false, pending: true })), null);
});

test('还没拿到数据 / 请求失败：不显示', () => {
  assert.equal(environmentNotice(null), null);
  assert.equal(environmentNotice(undefined), null);
});

test('版本未知（还没派发过）：不显示', () => {
  assert.equal(environmentNotice(status({ revision: 'r-new', appliedRevision: null, pending: false })), null);
});
