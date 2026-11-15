import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutboxPump, looksLikeEcho, type ChannelOutboxMessage } from '@agent-hub/domain';
import { createFakeChannel, createFakeOutbound, createFakeReplies } from './fake-channel.ts';

test('假渠道：入站按 push 交付，事件形状是规范化的 message', () => {
  const channel = createFakeChannel();
  assert.equal(channel.source.id, 'fake');
  assert.equal(channel.source.delivery, 'push');
  const event = channel.inbound('你好', 'm1');
  assert.deepEqual(event, { kind: 'message', externalId: 'm1', title: '你好', text: '你好' });
});

test('假渠道：出站记下平台 id，回声靠它被认出来（不误杀人类重复发言）', async () => {
  const { deliver, sent } = createFakeOutbound();
  const out = await deliver({
    id: 'o1', target: { kind: 'external', id: 'fake:chan' }, body: '收到',
    author: { kind: 'agent', name: '回声' }, replyToExternalId: null,
    externalConversationId: 'chan', externalThreadId: null, state: 'sending', attempts: 1,
    leaseUntil: 1, nextAttemptAt: 1, externalMessageId: null, origin: 'reply', createdAt: 1, updatedAt: 1
  } as never);
  assert.equal(out.ok, true);
  assert.equal(sent().length, 1);
  const row = {
    id: 'o1', target: { kind: 'external' as const, id: 'fake:chan' }, body: '收到',
    author: { kind: 'agent' as const, name: '回声' }, replyToExternalId: null,
    externalConversationId: 'chan', externalThreadId: null, state: 'sent' as const, attempts: 1,
    leaseUntil: null, nextAttemptAt: 1, externalMessageId: 'fake_1', origin: 'reply' as const, createdAt: 1, updatedAt: 2
  };
  const echo = { target: row.target, body: '收到', author: { kind: 'agent' as const, name: '回声' }, externalMessageId: 'fake_1' };
  assert.equal(looksLikeEcho(echo, row), true);
  // 别人说了同一句、外部 id 也不同 → 不是回声（不误杀人类发言）
  assert.equal(looksLikeEcho({ ...echo, author: { kind: 'user' as const, name: '另一个人' }, externalMessageId: 'm2' }, row), false);
});

test('假渠道：回合结束后回复进 outbox，由假投递端收下（入站→会话→出站）', async () => {
  const rows: ChannelOutboxMessage[] = [];
  const store = {
    async claim(_d: unknown, _now: number, _lease: number) { return rows.find((r) => r.state === 'queued') ?? null; },
    async save(m: ChannelOutboxMessage) { const i = rows.findIndex((r) => r.id === m.id); if (i >= 0) rows[i] = m; else rows.push(m); },
    async requeue() { return 0; }
  };
  const outbox = createFakeOutbound();
  const pump = createOutboxPump({
    store: store as never,
    kinds: ['external'],
    deliver: outbox.deliver
  });
  const replies = createFakeReplies({
    enqueue: (input) => pump.enqueue({ ...input, target: input.target } as never),
    tail: async () => [
      { event: { kind: 'prompt' } },
      { event: { kind: 'text', delta: '子代理已' } },
      { event: { kind: 'text', delta: '完成。' } }
    ]
  });
  replies.remember('s1', 'b1');
  assert.equal(await replies.finish('s1'), '子代理已完成。');
  await pump.tick();
  assert.deepEqual(rows.map((r) => r.state), ['sent']);
  assert.equal(rows[0]!.externalMessageId, 'fake_1');
});
