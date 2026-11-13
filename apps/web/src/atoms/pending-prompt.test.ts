import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACK_TIMEOUT_MS,
  expirePending,
  isExpired,
  newClientMessageId,
  pendingLabel,
  reconcilePending,
  type PendingPrompt
} from './pending-prompt.ts';

const pending = (id: string, text = '同样的话'): PendingPrompt => ({
  id,
  text,
  attachments: [],
  state: 'sending',
  sentAt: 1_000
});

test('对账按 id：journal 里出现同 id 的 prompt 块就删掉对应 pending', () => {
  const before = [pending('a'), pending('b')];
  const after = reconcilePending(before, [
    { kind: 'prompt', clientMessageId: 'a' },
    { kind: 'prompt', clientMessageId: 'b' }
  ]);
  assert.deepEqual(after, []);
});

test('对账按 id：没命的 id 原样保留，还没回显的那条不能提前消失', () => {
  const before = [pending('a'), pending('b')];
  const after = reconcilePending(before, [{ kind: 'prompt', clientMessageId: 'b' }]);
  assert.deepEqual(after.map((item) => item.id), ['a']);
});

test('同文不同 id 各留各的：回显第一条不会顶掉还没回显的第二条', () => {
  const before = [pending('a'), pending('b')];
  const after = reconcilePending(before, [{ kind: 'prompt', clientMessageId: 'a' }]);
  assert.equal(after.length, 1);
  assert.equal(after[0]?.id, 'b');
  assert.equal(after[0]?.text, '同样的话');
});

test('老事件没有 clientMessageId：不动 pending，也不误删', () => {
  const before = [pending('a')];
  assert.equal(reconcilePending(before, [{ kind: 'prompt' }, { kind: 'text' }]), before);
  assert.equal(reconcilePending(before, []), before);
});

test('没有变化时返回原数组，避免 setState 空转', () => {
  const before = [pending('a')];
  assert.equal(reconcilePending(before, [{ kind: 'prompt', clientMessageId: 'b' }]), before);
});

test('三种状态各有自己的一句话', () => {
  assert.equal(pendingLabel('sending'), '正在发送…');
  assert.match(pendingLabel('queued'), /排队/);
  assert.equal(pendingLabel('unknown'), '未送达');
});

test('超时判定：8 秒整算过期，差一毫秒不算', () => {
  assert.equal(isExpired('sending', 1_000, 1_000 + ACK_TIMEOUT_MS - 1), false);
  assert.equal(isExpired('sending', 1_000, 1_000 + ACK_TIMEOUT_MS), true);
  // 已经回执 / 已经标过未知的不再变。
  assert.equal(isExpired('queued', 1_000, 1_000 + ACK_TIMEOUT_MS * 10), false);
  assert.equal(isExpired('unknown', 1_000, 1_000 + ACK_TIMEOUT_MS * 10), false);
  // 自定义阈值。
  assert.equal(isExpired('sending', 0, 500, 500), true);
});

test('过期只标记还在飞的那条，其余原样；没得标时返回原数组', () => {
  const before: PendingPrompt[] = [
    { ...pending('a'), sentAt: 1_000 },
    { ...pending('b'), state: 'queued', sentAt: 1_000 }
  ];
  const after = expirePending(before, 1_000 + ACK_TIMEOUT_MS);
  assert.equal(after[0]?.state, 'unknown');
  assert.equal(after[1]?.state, 'queued');
  assert.equal(expirePending(before, 1_001), before);
});

test('id 生成：默认不重复，也能注入', () => {
  const ids = new Set<string>();
  for (let index = 0; index < 500; index += 1) ids.add(newClientMessageId());
  assert.equal(ids.size, 500);
  assert.equal(newClientMessageId(() => 'fixed-id'), 'fixed-id');
  for (const id of ids) assert.ok(id.length > 0 && id.length <= 80, `id 超长: ${id}`);
});
