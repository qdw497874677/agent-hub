import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { newOutboxMessage, type ChannelOutboxMessage } from '@agent-hub/domain';
import { createSqliteConnectors } from './connectors.ts';

const outboxOf = () => createSqliteConnectors(new DatabaseSync(':memory:')).outbox;

const target = { kind: 'session' as const, id: 's1' };

const make = (id: string, over: Partial<ChannelOutboxMessage> = {}, now = 1_000): ChannelOutboxMessage => ({
  ...newOutboxMessage({ target, body: `body-${id}`, author: { kind: 'agent', name: 'hub' }, origin: 'inbound' }, now, id),
  ...over
});

test('并发 claim 同一条只有一次成功；分批拿到的 id 不重复', async () => {
  const store = outboxOf();
  await store.save(make('m1'));
  const [a, b] = await Promise.all([store.claim({ kinds: ['session'] }, 1_000, 500), store.claim({ kinds: ['session'] }, 1_000, 500)]);
  assert.equal([a, b].filter(Boolean).length, 1);
  const won = (a ?? b)!;
  assert.equal(won.id, 'm1');
  assert.equal(won.state, 'sending');
  assert.equal(won.leaseUntil, 1_500);
  assert.equal(won.attempts, 0);

  await store.save(make('m2', {}, 1_001));
  // 租约（到 1_500）还没到期：另一个并发调用只能拿到 m2，不能重复拿 m1
  const [c, d] = await Promise.all([store.claim({ kinds: ['session'] }, 1_400, 500), store.claim({ kinds: ['session'] }, 1_400, 500)]);
  assert.deepEqual([c, d].map((m) => m?.id).sort(), ['m2', undefined]);
  // 两条都过期后同时领：各领各的，不重复
  const both = await Promise.all([store.claim({ kinds: ['session'] }, 2_000, 500), store.claim({ kinds: ['session'] }, 2_000, 500)]);
  assert.deepEqual(both.map((m) => m?.id).sort(), ['m1', 'm2']);
});

test('租约过期可重领；requeue 把过期 sending 放回 queued；未到期不给', async () => {
  const store = outboxOf();
  await store.save(make('m1'));
  assert.equal((await store.claim({ kinds: ['session'] }, 1_000, 500))!.id, 'm1');
  assert.equal(await store.claim({ kinds: ['session'] }, 1_200, 500), null);
  assert.equal((await store.expiring(1_200)).length, 0);
  assert.equal((await store.expiring(1_500)).length, 1);

  assert.equal((await store.claim({ kinds: ['session'] }, 1_500, 500))!.id, 'm1'); // 过期直接重领
  await store.save({ ...make('m2'), state: 'sending', leaseUntil: 1_100, attempts: 2 });
  assert.equal(await store.requeue(1_500), 1);
  const back = (await store.claim({ kinds: ['session'] }, 1_500, 500))!;
  assert.equal(back.id, 'm2');
  assert.equal(back.attempts, 2);
});

test('未到期 / 未接线目标不会被领走', async () => {
  const store = outboxOf();
  await store.save(make('later', { nextAttemptAt: 5_000 }));
  await store.save(make('gh', { target: { kind: 'external', id: 'github:acme/app#7' } }, 500));
  assert.equal(await store.claim({ kinds: ['session'] }, 1_000, 500), null);
  assert.equal(await store.claim({ kinds: [] }, 5_000, 500), null);
  assert.equal((await store.claim({ kinds: ['external'] }, 5_000, 500))!.id, 'gh');
  assert.equal((await store.claim({ kinds: ['session'] }, 5_000, 500))!.id, 'later');
});

test('echoCandidates 只返回同目标、窗口内的 sending/sent 行', async () => {
  const store = outboxOf();
  await store.save({ ...make('sent-old', { state: 'sent', externalMessageId: 'e1' }), updatedAt: 100 });
  await store.save({ ...make('sending-new'), state: 'sending', leaseUntil: 9_000, updatedAt: 400 });
  await store.save({ ...make('queued-new'), state: 'queued', updatedAt: 500 });
  await store.save({ ...make('failed-new', { state: 'failed' }), updatedAt: 600 });
  await store.save({ ...make('other-target', { target: { kind: 'session', id: 's2' }, state: 'sent' }), updatedAt: 700 });

  assert.deepEqual((await store.echoCandidates(target, 300)).map((m) => m.id), ['sending-new']);
  assert.deepEqual((await store.echoCandidates(target, 0)).map((m) => m.id), ['sent-old', 'sending-new']);
});

test('save 按列 upsert：状态迁移不清空其它列，字段往返一致', async () => {
  const store = outboxOf();
  const m = make('m1', {
    replyToExternalId: 'ext-1', externalConversationId: 'c1', externalThreadId: '#7', origin: 'reply',
    author: { kind: 'user', name: 'me' }
  });
  await store.save(m);
  const claimed = (await store.claim({ kinds: ['session'] }, 1_000, 500))!;
  assert.deepEqual(claimed.target, target);
  assert.equal(claimed.replyToExternalId, 'ext-1');
  assert.equal(claimed.externalConversationId, 'c1');
  assert.equal(claimed.externalThreadId, '#7');
  assert.equal(claimed.author.name, 'me');
  assert.equal(claimed.origin, 'reply');
  assert.equal(claimed.createdAt, 1_000);

  await store.save({ ...claimed, state: 'sent', leaseUntil: null, externalMessageId: 'ext-9', updatedAt: 2_000 });
  const sent = (await store.echoCandidates(target, 0))[0]!;
  assert.equal(sent.state, 'sent');
  assert.equal(sent.externalMessageId, 'ext-9');
  assert.equal(sent.externalConversationId, 'c1');
  assert.equal(sent.replyToExternalId, 'ext-1');
});
