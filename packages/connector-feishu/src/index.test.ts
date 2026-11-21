import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelOutboxMessage, ConnectorBinding, InboundContext, InboundEvent, OutboxStore, TriggerRun } from '@agent-hub/domain';
import { createFeishuSource, FEISHU_MAX_TEXT, feishuExternalId, feishuTargetId, parseFeishuText } from './index.ts';
import type { FeishuClient } from './client.ts';
import { createFeishuSink, createFeishuTurnReplies, feishuReplyOutboxId } from './sink.ts';

const binding = (id: string, chatId?: string, patch: Partial<ConnectorBinding> = {}): ConnectorBinding => ({
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
  ...patch,
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
  const rows = new Map<string, ChannelOutboxMessage>();
  const outbox = {
    claim: async () => null,
    echoCandidates: async () => [],
    expiring: async () => [],
    insertIfAbsent: async (message: ChannelOutboxMessage) => {
      const existing = rows.get(message.id);
      if (existing) return { message: existing, inserted: false };
      rows.set(message.id, message);
      saved.push(message);
      return { message, inserted: true };
    },
    save: async (message: ChannelOutboxMessage) => { rows.set(message.id, message); },
    byId: async (id: string) => rows.get(id) ?? null,
    requeue: async () => {}
  } as unknown as OutboxStore;
  return { outbox, saved, rows };
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

test('sink：同一 outboxId 重放保留已 sent 行，不同 run 各自插入', async () => {
  const { outbox, saved, rows } = memoryOutbox();
  const sink = createFeishuSink({ outbox, client: fakeClient().client, now: () => 1 });
  const first = await sink.enqueueReply({ chatId: 'oc_1', replyToExternalId: 'om_9', body: '第一版', outboxId: 'feishu-reply:run-1' });
  assert.equal(first.id, 'feishu-reply:run-1');
  assert.equal(first.state, 'queued');

  await outbox.save({ ...first, state: 'sent', externalMessageId: 'om_sent', updatedAt: 2_000 });
  const replay = await sink.enqueueReply({ chatId: 'oc_1', replyToExternalId: 'om_9', body: '重放正文', outboxId: 'feishu-reply:run-1' });
  assert.equal(replay.id, 'feishu-reply:run-1');
  assert.equal(replay.state, 'sent', '已发出的行不能被重放打回 queued');
  assert.equal(replay.externalMessageId, 'om_sent');
  assert.equal(rows.get('feishu-reply:run-1')!.body, '第一版');
  assert.equal(saved.length, 1, '重放不再插入');

  const nextRun = await sink.enqueueReply({ chatId: 'oc_1', replyToExternalId: 'om_9', body: '下一轮', outboxId: 'feishu-reply:run-2' });
  assert.equal(nextRun.state, 'queued');
  assert.equal(saved.length, 2, '新 run 插入新行');
});

test('turnReplies：直聊回复用 run.id 的确定性 outbox 身份', async () => {
  const runs = {
    deliveredRunFor: async (sessionId: string): Promise<TriggerRun | null> => (
      sessionId === 's1' ? { id: 'run-1', bindingId: 'b1', externalId: 'oc_1:om_9' } as TriggerRun : null
    ),
    binding: async (id: string) => (id === 'b1' ? binding('b1', 'oc_1') : null)
  } as never;
  const enqueued: Array<{ chatId: string; replyToExternalId?: string | null; body: string; outboxId?: string | null }> = [];
  const entries = [
    { seq: 2, event: { kind: 'text', delta: '收到' } },
    { seq: 3, event: { kind: 'ended', outcome: 'done', deliveryId: 'd1' } }
  ];
  const replies = createFeishuTurnReplies({
    runs,
    eventsAfter: async (_sessionId, afterSeq) => entries.filter((entry) => entry.seq > afterSeq) as never,
    tail: async () => { throw new Error('keyed 回程不应该退回 tail'); },
    inFlight: async (sessionId) => (sessionId === 's1' ? { id: 'd1', sessionId: 's1', seq: 1 } : null),
    enqueueReply: async (input) => { enqueued.push(input); return {} as never; }
  });
  assert.equal(await replies.finish('s1', { seq: 3, deliveryId: 'd1' }), '收到');
  assert.equal(enqueued[0]!.outboxId, 'feishu-reply:run-1');
  assert.equal(feishuReplyOutboxId('run-1'), 'feishu-reply:run-1');
  assert.equal(feishuReplyOutboxId(undefined), null);
});

test('turnReplies：飞书触发的会话把这一轮回复投进出站队列', async () => {
  const runs = {
    deliveredRunFor: async (sessionId: string): Promise<TriggerRun | null> => (
      sessionId === 's1' ? { id: 'run-1', bindingId: 'b1', externalId: 'oc_1:om_9' } as TriggerRun : null
    ),
    binding: async (id: string) => (id === 'b1' ? binding('b1', 'oc_1') : null)
  } as never;
  const enqueued: Array<{ chatId: string; replyToExternalId?: string | null; body: string; outboxId?: string | null }> = [];
  // B 的 prompt 先落盘（seq 2），A 的文字/ended 随后插进来（3-5），最后才是 B 的回复（6）。
  const entries = [
    { seq: 3, event: { kind: 'text', delta: 'A 的尾巴' } },
    { seq: 4, event: { kind: 'text', delta: '（A 还没结束）' } },
    { seq: 5, event: { kind: 'ended', outcome: 'done', deliveryId: 'dA' } },
    { seq: 6, event: { kind: 'text', delta: '我看了，' } },
    { seq: 7, event: { kind: 'text', delta: '没问题。' } },
    { seq: 8, event: { kind: 'ended', outcome: 'done', deliveryId: 'd1' } },
    { seq: 9, event: { kind: 'text', delta: '结束后的迟到文字' } }
  ];
  const replies = createFeishuTurnReplies({
    runs,
    eventsAfter: async (_sessionId, afterSeq) => entries.filter((entry) => entry.seq > afterSeq) as never,
    tail: async () => { throw new Error('keyed 回程不应该退回 tail'); },
    inFlight: async (sessionId) => (sessionId === 's1' ? { id: 'd1', sessionId: 's1', seq: 2 } : null),
    enqueueReply: async (input) => { enqueued.push(input); return {} as never; }
  });
  await replies.finish('s1', { seq: 8, deliveryId: 'd1' });
  await replies.finish('s2', { seq: 8, deliveryId: 'd1' });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]!.chatId, 'oc_1');
  assert.equal(enqueued[0]!.replyToExternalId, 'om_9');
  assert.equal(enqueued[0]!.body, '我看了，没问题。', 'B 的窗口要排除 A 的尾巴，也不能越过 B 的 ended');
  assert.equal(enqueued[0]!.outboxId, 'feishu-reply:run-1');
});

test('turnReplies：keyed 窗口不截断在 tail 的 500 条长度上', async () => {
  const runs = {
    deliveredRunFor: async (sessionId: string): Promise<TriggerRun | null> => (
      sessionId === 's1' ? { id: 'run-1', bindingId: 'b1', externalId: 'oc_1:om_9' } as TriggerRun : null
    ),
    binding: async (id: string) => (id === 'b1' ? binding('b1', 'oc_1') : null)
  } as never;
  const entries = Array.from({ length: 620 }, (_, index) => ({
    seq: 10 + index,
    event: { kind: 'text', delta: index === 0 ? '长窗口开头' : index === 619 ? '长窗口结尾' : '' }
  }));
  let askedAfter = -1;
  const enqueued: Array<{ body: string }> = [];
  const replies = createFeishuTurnReplies({
    runs,
    eventsAfter: async (_sessionId, afterSeq) => {
      askedAfter = afterSeq;
      return entries.filter((entry) => entry.seq > afterSeq) as never;
    },
    tail: async () => { throw new Error('keyed 回程不应该退回 tail'); },
    inFlight: async (sessionId) => (sessionId === 's1' ? { id: 'd1', sessionId: 's1', seq: 5 } : null),
    enqueueReply: async (input) => { enqueued.push(input); return {} as never; }
  });
  const body = await replies.finish('s1', { seq: 629, deliveryId: 'd1' });
  assert.equal(askedAfter, 5, '锚点是投递的 prompt seq');
  assert.equal(body, '长窗口开头长窗口结尾');
  assert.equal(enqueued[0]!.body, '长窗口开头长窗口结尾');
});

test('turnReplies：在途投递不匹配（无 key / 错 key）时不得回程', async () => {
  const runs = {
    deliveredRunFor: async (): Promise<TriggerRun | null> => ({ id: 'run-1', bindingId: 'b1', externalId: 'oc_1:om_9' } as TriggerRun),
    binding: async (id: string) => (id === 'b1' ? binding('b1', 'oc_1') : null)
  } as never;
  const enqueued: unknown[] = [];
  const replies = createFeishuTurnReplies({
    runs,
    eventsAfter: async () => { throw new Error('身份不匹配时不应读 journal'); },
    tail: async () => { throw new Error('身份不匹配时不应退回 tail'); },
    inFlight: async (sessionId) => (sessionId === 's1' ? { id: 'd1', sessionId: 's1', seq: 2 } : null),
    enqueueReply: async (input) => { enqueued.push(input); return {} as never; }
  });
  assert.equal(await replies.finish('s1', { seq: 9 }), null, '无 key ended 不能归因给当前在途投递');
  assert.equal(await replies.finish('s1', { seq: 9, deliveryId: 'd2' }), null, '错 key ended 不能归因给当前在途投递');
  assert.deepEqual(enqueued, []);
});

test('turnReplies：平台补写的无 key 失败 ended 不回程', async () => {
  const runs = {
    deliveredRunFor: async (): Promise<TriggerRun | null> => ({ id: 'run-1', bindingId: 'b1', externalId: 'oc_1:om_9' } as TriggerRun),
    binding: async (id: string) => (id === 'b1' ? binding('b1', 'oc_1') : null)
  } as never;
  const enqueued: unknown[] = [];
  const replies = createFeishuTurnReplies({
    runs,
    eventsAfter: async () => { throw new Error('合成 ended 不应读 journal'); },
    tail: async () => { throw new Error('合成 ended 不应读 journal'); },
    inFlight: async () => null,
    enqueueReply: async (input) => { enqueued.push(input); return {} as never; }
  });
  assert.equal(await replies.finish('s1', { seq: 9, reason: '未送达：worker 掉线' }), null);
  assert.deepEqual(enqueued, []);
});

test('turnReplies：群目标的回复由群帖镜像回写，这里不再补一份（#230 重复发送）', async () => {
  const runs = {
    deliveredRunFor: async (sessionId: string): Promise<TriggerRun | null> => (
      sessionId === 's1' ? { bindingId: 'b1', externalId: 'oc_1:om_9' } as TriggerRun : null
    ),
    binding: async (id: string) => (id === 'b1' ? binding('b1', 'oc_1', { targetKind: 'group', groupId: 'g1' }) : null)
  } as never;
  const enqueued: unknown[] = [];
  const replies = createFeishuTurnReplies({
    runs,
    eventsAfter: async () => { throw new Error('群目标不应读 journal'); },
    tail: async () => [{ seq: 1, event: { kind: 'text', delta: '群里已经发过了' } }],
    inFlight: async () => null,
    enqueueReply: async (input) => { enqueued.push(input); return {} as never; }
  });
  assert.equal(await replies.finish('s1', { seq: 2, deliveryId: 'd1' }), null);
  assert.deepEqual(enqueued, []);
});
