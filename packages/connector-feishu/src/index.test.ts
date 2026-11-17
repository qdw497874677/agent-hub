import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelOutboxMessage, ConnectorBinding, InboundContext, InboundEvent, OutboxStore, TriggerRun } from '@agent-hub/domain';
import { createFeishuSource, FEISHU_MAX_TEXT, feishuExternalId, feishuTargetId, parseFeishuText } from './index.ts';
import type { FeishuClient } from './client.ts';
import { createFeishuSink, createFeishuTurnReplies } from './sink.ts';

const binding = (id: string, chatId?: string): ConnectorBinding => ({
  id,
  connector: 'feishu',
  kind: 'message',
  agentName: 'a',
  agentProjectId: 'p',
  projectId: null,
  name: id,
  target: 'main',
  groupId: null,
  params: chatId ? { chatId } : {},
  enabled: true,
  pausedReason: null,
  consecutiveFailures: 0,
  nextRunAt: null,
  mainSessionId: null,
  createdBy: 'test',
  timeZone: 'Asia/Shanghai',
  createdAt: 0,
  updatedAt: 0
});

const fakeContext = (bindings: readonly ConnectorBinding[]) => {
  const emitted: Array<{ bindingId: string; event: InboundEvent }> = [];
  const ctx: InboundContext = {
    now: () => Date.now(),
    bindings: async () => bindings,
    advance: async () => true,
    emit: async (bindingId, event) => { emitted.push({ bindingId, event }); },
    skip: async () => {},
    seen: async () => false
  };
  return { ctx, emitted };
};

const fakeClient = (fail?: unknown) => {
  const calls: Array<{ kind: 'send' | 'reply'; target: string; text: string }> = [];
  const client: FeishuClient = {
    sendText: async (target, text) => {
      calls.push({ kind: 'send', target: target.chatId, text });
      if (fail) throw fail;
      return { messageId: 'om_sent' };
    },
    replyText: async (parentMessageId, text) => {
      calls.push({ kind: 'reply', target: parentMessageId, text });
      if (fail) throw fail;
      return { messageId: 'om_replied' };
    }
  };
  return { client, calls };
};

const memoryOutbox = () => {
  const saved: ChannelOutboxMessage[] = [];
  const outbox = {
    claim: async () => null,
    echoCandidates: async () => [],
    expiring: async () => [],
    save: async (message: ChannelOutboxMessage) => { saved.push(message); },
    requeue: async () => {}
  } as unknown as OutboxStore;
  return { outbox, saved };
};

test('parseFeishuText 解析正文、坏 JSON、mention 占位符', () => {
  assert.equal(parseFeishuText(JSON.stringify({ text: '你好' })), '你好');
  assert.equal(parseFeishuText('{坏'), '');
  assert.equal(parseFeishuText(''), '');
  assert.equal(
    parseFeishuText(JSON.stringify({ text: '@_user_1 看下这个' }), [{ key: '@_user_1', name: '张三' }]),
    '@张三 看下这个'
  );
  // 拿不到 mentions 时保留占位符，不猜名字。
  assert.equal(parseFeishuText(JSON.stringify({ text: '@_user_1 在吗' })), '@_user_1 在吗');
});

test('feishuExternalId 带 chatId，避免跨会话撞 id', () => {
  assert.equal(feishuExternalId('oc_1', 'om_1'), 'oc_1:om_1');
  assert.notEqual(feishuExternalId('oc_1', 'om_1'), feishuExternalId('oc_2', 'om_1'));
});

test('source：按 binding 的 chatId 过滤后 emit，externalId 稳定', async () => {
  const { ctx, emitted } = fakeContext([binding('b1', 'oc_1'), binding('b2', 'oc_2'), binding('b3')]);
  let handler: ((message: never) => void) | null = null;
  const source = createFeishuSource({
    appId: 'id',
    appSecret: 'secret',
    connect: async (onMessage) => {
      handler = onMessage as never;
      return { close: () => {} };
    }
  });
  const handle = source.start(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  handler!({
    chatId: 'oc_1',
    messageId: 'om_9',
    senderId: 'ou_1',
    senderName: '张三',
    text: '帮我看看',
    mentionsBot: true
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(emitted.map((e) => e.bindingId), ['b1', 'b3']);
  assert.equal(emitted[0]!.event.externalId, 'oc_1:om_9');
  assert.equal(emitted[0]!.event.externalId, emitted[1]!.event.externalId);
  assert.equal(typeof emitted[0]!.event.text, 'object', '外部正文必须包成 untrusted');
  assert.match(String((emitted[0]!.event.text as { value: string }).value), /帮我看看/);
  assert.deepEqual(emitted[0]!.event.author, { name: '张三', externalId: 'ou_1' }, '群帖作者要带到发送者');
  handle.stop();
});

test('sink：有 replyTo 走 reply，没有就 send', async () => {
  const { outbox, saved } = memoryOutbox();
  const { client, calls } = fakeClient();
  const sink = createFeishuSink({ outbox, client, now: () => 1 });
  await sink.enqueueReply({ chatId: 'oc_1', replyToExternalId: 'om_9', body: '好的' });
  await sink.enqueueReply({ chatId: 'oc_1', body: '主动通知' });
  assert.equal(saved.length, 2);
  assert.equal(saved[0]!.target.id, 'feishu:oc_1');
  assert.equal(saved[0]!.replyToExternalId, 'om_9');

  const first = await sink.deliver(saved[0]!);
  const second = await sink.deliver(saved[1]!);
  assert.deepEqual(first, { ok: true, externalMessageId: 'om_replied' });
  assert.deepEqual(second, { ok: true, externalMessageId: 'om_sent' });
  assert.deepEqual(calls.map((c) => c.kind), ['reply', 'send']);
  assert.equal(calls[0]!.target, 'om_9');
  assert.equal(calls[1]!.target, 'oc_1');
});

test('sink：群的出站镜像带 `<chatId>:<messageId>`，发出去时只留 messageId、正文按 text 截断', async () => {
  const { outbox, saved } = memoryOutbox();
  const { client, calls } = fakeClient();
  const sink = createFeishuSink({ outbox, client, now: () => 1 });
  await sink.enqueueReply({ chatId: 'oc_1', replyToExternalId: 'oc_1:om_9', body: '**结论**\n第一行\n第二行' });
  const result = await sink.deliver(saved[0]!);
  assert.deepEqual(result, { ok: true, externalMessageId: 'om_replied' });
  assert.deepEqual(calls.map((c) => c.kind), ['reply']);
  assert.equal(calls[0]!.target, 'om_9', 'replyText 收裸 messageId');
  assert.equal(calls[0]!.text, '**结论**\n第一行\n第二行', 'v1 只发 text：原样保留换行，不做富文本');
});

test('sink：外部消息 id 形如 feishu:<chatId> 才处理，其余跳过', async () => {
  const { outbox, saved } = memoryOutbox();
  const { client, calls } = fakeClient();
  const sink = createFeishuSink({ outbox, client });
  saved.push({ ...saved[0]!, id: 'x', target: { kind: 'external', id: 'github:a/b#1' }, body: 'x' });
  const result = await sink.deliver(saved[0]!) as { ok: boolean; error?: { retryable?: boolean } };
  assert.equal(result.ok, false);
  assert.equal(result.error?.retryable, false);
  assert.equal(calls.length, 0);
  assert.equal(feishuTargetId('oc_1'), 'feishu:oc_1');
});

test('sink：失败映射成 retryable（业务码/网络）', async () => {
  const { outbox, saved } = memoryOutbox();
  const transient = fakeClient(Object.assign(new Error('飞书发送失败：99991400'), { retryable: true }));
  const sink = createFeishuSink({ outbox, client: transient.client });
  await sink.enqueueReply({ chatId: 'oc_1', body: 'hi' });
  const first = await sink.deliver(saved[0]!) as { ok: boolean; error?: { retryable?: boolean; message?: string } };
  assert.equal(first.ok, false);
  assert.equal(first.error?.retryable, true);
  assert.match(first.error!.message!, /99991400/);

  const { outbox: o2, saved: s2 } = memoryOutbox();
  const fatal = fakeClient(Object.assign(new Error('飞书发送失败：230002'), { retryable: false }));
  const sink2 = createFeishuSink({ outbox: o2, client: fatal.client });
  await sink2.enqueueReply({ chatId: 'oc_1', body: 'hi' });
  const second = await sink2.deliver(s2[0]!) as { ok: boolean; error?: { retryable?: boolean } };
  assert.equal(second.ok, false);
  assert.equal(second.error?.retryable, false);
});

test('sink：出站正文超过 8000 字先截断', async () => {
  const { outbox, saved } = memoryOutbox();
  const { client, calls } = fakeClient();
  const sink = createFeishuSink({ outbox, client });
  await sink.enqueueReply({ chatId: 'oc_1', body: '字'.repeat(FEISHU_MAX_TEXT + 50) });
  await sink.deliver(saved[0]!);
  assert.equal(calls[0]!.text.length, FEISHU_MAX_TEXT + 1);
  assert.ok(calls[0]!.text.endsWith('…'));
});

test('turnReplies：飞书触发的会话把这一轮回复投进出站队列', async () => {
  const runs = {
    deliveredRunFor: async (sessionId: string): Promise<TriggerRun | null> => (
      sessionId === 's1' ? { bindingId: 'b1', externalId: 'oc_1:om_9' } as TriggerRun : null
    ),
    binding: async (id: string) => (id === 'b1' ? binding('b1', 'oc_1') : null)
  } as never;
  const enqueued: Array<{ chatId: string; replyToExternalId?: string | null; body: string }> = [];
  const replies = createFeishuTurnReplies({
    runs,
    tail: async () => [
      { event: { kind: 'prompt', delta: 'ignored' } },
      { event: { kind: 'prompt', delta: '【飞书】帮我看看' } },
      { event: { kind: 'text', delta: '我看了，' } },
      { event: { kind: 'text', delta: '没问题。' } }
    ] as never,
    enqueueReply: async (input) => { enqueued.push(input); return {} as never; }
  });
  await replies.finish('s1');
  await replies.finish('s2');
  assert.deepEqual(enqueued, [{ chatId: 'oc_1', replyToExternalId: 'om_9', body: '我看了，没问题。', sessionId: 's1' }]);
});
