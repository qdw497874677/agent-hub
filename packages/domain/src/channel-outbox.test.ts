import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffFor, createOutboxPump, isTransient, looksLikeEcho, newOutboxMessage, OUTBOX_MAX_ATTEMPTS,
  sameExternalMessage, splitExternalId,
  type ChannelOutboxMessage, type OutboxClaim, type OutboxStore, type OutboxTarget
} from './channel-outbox.ts';

/** 内存版 OutboxStore：claim 的 CAS 语义按契约实现（同一行只能被领一次）。 */
class MemoryOutbox implements OutboxStore {
  readonly rows = new Map<string, ChannelOutboxMessage>();

  async claim(due: OutboxClaim, now: number, leaseMs: number): Promise<ChannelOutboxMessage | null> {
    const dueRows = [...this.rows.values()]
      .filter((m) => due.kinds.includes(m.target.kind) && m.nextAttemptAt <= now)
      .filter((m) => m.state === 'queued' || (m.state === 'sending' && m.leaseUntil !== null && m.leaseUntil <= now))
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt);
    const hit = dueRows[0];
    if (!hit) return null;
    const claimed: ChannelOutboxMessage = { ...hit, state: 'sending', leaseUntil: now + leaseMs, updatedAt: now };
    this.rows.set(claimed.id, claimed);
    return claimed;
  }

  async save(message: ChannelOutboxMessage): Promise<void> { this.rows.set(message.id, message); }

  async byId(id: string): Promise<ChannelOutboxMessage | null> { return this.rows.get(id) ?? null; }

  async expiring(now: number): Promise<ChannelOutboxMessage[]> {
    return [...this.rows.values()].filter((m) => m.state === 'sending' && m.leaseUntil !== null && m.leaseUntil <= now);
  }

  async requeue(now: number): Promise<number> {
    let n = 0;
    for (const m of await this.expiring(now)) {
      this.rows.set(m.id, { ...m, state: 'queued', leaseUntil: null, nextAttemptAt: now, updatedAt: now });
      n++;
    }
    return n;
  }

  async echoCandidates(target: OutboxTarget, since: number): Promise<ChannelOutboxMessage[]> {
    return [...this.rows.values()].filter((m) => m.target.kind === target.kind && m.target.id === target.id
      && (m.state === 'sending' || m.state === 'sent') && m.updatedAt >= since);
  }
}

const target: OutboxTarget = { kind: 'session', id: 's1' };

const message = (over: Partial<ChannelOutboxMessage> = {}): ChannelOutboxMessage => ({
  ...newOutboxMessage({ target, body: 'hello', author: { kind: 'agent', name: 'hub' }, origin: 'inbound' }, 1_000, over.id ?? 'm1'),
  ...over
});

const queued = (store: MemoryOutbox, over: Partial<ChannelOutboxMessage> = {}) => {
  const m = message(over);
  store.rows.set(m.id, m);
  return m;
};

test('退避：1s、5s、30s、2min、10min 封顶', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(backoffFor), [1_000, 5_000, 30_000, 120_000, 600_000, 600_000, 600_000]);
  assert.equal(backoffFor(0), 1_000);
  assert.equal(OUTBOX_MAX_ATTEMPTS, 8);
});

test('永久失败（401/403/404/400）与瞬时失败（网络、429、5xx）分流', () => {
  for (const status of [400, 401, 403, 404, 422]) assert.equal(isTransient({ status }), false, String(status));
  for (const status of [0, 429, 500, 503]) assert.equal(isTransient({ status }), true, String(status));
  assert.equal(isTransient(new Error('ECONNRESET')), true);
  assert.equal(isTransient('GitHub 404：Not Found'), false);
  assert.equal(isTransient(null), true);
});

test('回声三层各命中一次，且同目标 / 只认 sending 与 sent', () => {
  const inbound = { target, body: '  收 到了 ', author: { kind: 'user' as const, name: 'Bot' }, externalMessageId: null };
  const base = message({ state: 'sending', body: '完全不同的正文', author: { kind: 'agent', name: 'bot' } });
  // ① 平台身份：agent 同名（大小写无关）
  assert.equal(looksLikeEcho(inbound, base), true);
  // ② externalMessageId 精确相等
  assert.equal(looksLikeEcho({ ...inbound, author: { kind: 'user', name: '某人' }, externalMessageId: 'x-1' }, { ...base, author: { kind: 'user', name: 'hub' }, externalMessageId: 'x-1' }), true);
  // ③ 正文指纹 + 作者相同（候选行作者不是 agent，前两层都不命中）
  assert.equal(looksLikeEcho(inbound, { ...base, state: 'sent', author: { kind: 'user', name: 'BOT' }, body: '收 到了' }), true);

  // 不误判：作者 / 正文 / id 都不同；失败或排队中的行不算；跨目标不算
  assert.equal(looksLikeEcho(inbound, { ...base, author: { kind: 'user', name: '某人' }, body: '另一条' }), false);
  assert.equal(looksLikeEcho(inbound, { ...base, state: 'failed' }), false);
  assert.equal(looksLikeEcho(inbound, { ...base, state: 'queued' }), false);
  assert.equal(looksLikeEcho(inbound, { ...base, target: { kind: 'session', id: 's2' } }), false);
  // 正文相同但作者不同：人的重复发言不是回声
  assert.equal(looksLikeEcho({ ...inbound, author: { kind: 'user', name: '人类' } }, { ...base, author: { kind: 'agent', name: 'bot' }, body: '收到了' }), false);
});

test('租约：并发 tick 只有一条能领到，租约过期后可以重领', async () => {
  const store = new MemoryOutbox();
  queued(store);
  assert.equal((await Promise.all([store.claim({ kinds: ['session'] }, 1_000, 500), store.claim({ kinds: ['session'] }, 1_000, 500)])).filter(Boolean).length, 1);
  assert.equal(await store.claim({ kinds: ['session'] }, 1_200, 500), null); // 租约到 1_500
  const reclaimed = await store.claim({ kinds: ['session'] }, 1_600, 500);
  assert.equal(reclaimed?.id, 'm1');
  assert.equal(reclaimed?.state, 'sending');
  // 另一个泵同时 tick：领不到，deliver 只发生一次
  store.rows.set('m1', { ...message(), leaseUntil: 1_000 });
  let delivered = 0;
  const make = () => createOutboxPump({ store, now: () => 2_000, deliver: async () => { delivered++; await new Promise((r) => setImmediate(r)); return { ok: true, externalMessageId: 'ext' }; } });
  await Promise.all([make().tick(), make().tick()]);
  assert.equal(delivered, 1);
});

test('永不认领没接线的目标类型（github 回帖留在队列里）', async () => {
  const store = new MemoryOutbox();
  queued(store, { id: 'gh', target: { kind: 'external', id: 'github:acme/app#7' } });
  let delivered = 0;
  const pump = createOutboxPump({ store, now: () => 1_000, deliver: async () => { delivered++; return { ok: true }; } });
  assert.equal(await pump.tick(), 0);
  assert.equal(delivered, 0);
  assert.equal(store.rows.get('gh')!.state, 'queued');
  assert.equal(store.rows.get('gh')!.attempts, 0);
});

test('成功写 sent + externalMessageId；瞬时失败退避重试；到上限写 failed', async () => {
  let clock = 1_000;
  const store = new MemoryOutbox();
  const pump = createOutboxPump({ store, now: () => clock, maxAttempts: 3, deliver: async () => ({ ok: true, externalMessageId: 'ext-1' }) });
  await pump.enqueue({ target, body: 'hi', author: { kind: 'agent', name: 'hub' }, origin: 'reply' });
  assert.equal(await pump.tick(), 1);
  const sent = [...store.rows.values()][0]!;
  assert.equal(sent.state, 'sent');
  assert.equal(sent.externalMessageId, 'ext-1');
  assert.equal(sent.leaseUntil, null);

  // 瞬时失败：attempts+1、nextAttemptAt = now + backoff(1)
  const failures: number[] = [];
  const retrying = createOutboxPump({ store, now: () => clock, maxAttempts: 3, deliver: async () => { failures.push(clock); return { ok: false, error: { status: 503 } }; } });
  await retrying.enqueue({ target, body: 'retry', author: { kind: 'agent', name: 'hub' }, origin: 'inbound' });
  clock = 2_000;
  await retrying.tick();
  const wait = [...store.rows.values()].find((m) => m.body === 'retry')!;
  assert.equal(wait.state, 'queued');
  assert.equal(wait.attempts, 1);
  assert.equal(wait.nextAttemptAt, 2_000 + 1_000);
  assert.equal(await retrying.tick(), 0); // 还没到期

  clock = 3_000;
  await retrying.tick(); // attempts 2 → 退避 5s
  clock = 3_000 + 5_000;
  await retrying.tick(); // attempts 3 → 到 maxAttempts，failed
  const dead = [...store.rows.values()].find((m) => m.body === 'retry')!;
  assert.equal(dead.state, 'failed');
  assert.equal(dead.attempts, 3);
  assert.deepEqual(failures, [2_000, 3_000, 8_000]);
});

test('永久失败立即 failed，不占用重试次数；抛错按瞬时处理', async () => {
  const store = new MemoryOutbox();
  const pump = createOutboxPump({ store, now: () => 1_000, deliver: async () => { throw Object.assign(new Error('boom'), { status: 404 }); } });
  await pump.enqueue({ target, body: 'nope', author: { kind: 'agent', name: 'hub' }, origin: 'inbound' });
  assert.equal(await pump.tick(), 1);
  const dead = [...store.rows.values()][0]!;
  assert.equal(dead.state, 'failed');
  assert.equal(dead.attempts, 0);

  const thrown = new MemoryOutbox();
  const transient = createOutboxPump({ store: thrown, now: () => 1_000, deliver: async () => { throw new Error('socket hang up'); } });
  await transient.enqueue({ target, body: 'net', author: { kind: 'agent', name: 'hub' }, origin: 'inbound' });
  await transient.tick();
  const retry = [...thrown.rows.values()][0]!;
  assert.equal(retry.state, 'queued');
  assert.equal(retry.attempts, 1);
});

test('租约过期的行由 tick 收回并重投；enqueue 落 queued', async () => {
  const store = new MemoryOutbox();
  queued(store, { state: 'sending', leaseUntil: 1_000, attempts: 1 });
  let delivered = 0;
  const pump = createOutboxPump({ store, now: () => 2_000, deliver: async () => { delivered++; return { ok: true, externalMessageId: 'ext' }; } });
  assert.equal(await pump.tick(), 1);
  assert.equal(delivered, 1);
  assert.equal(store.rows.get('m1')!.state, 'sent');

  const fresh = await pump.enqueue({ target, body: 'x', author: { kind: 'user', name: 'me' }, origin: 'inbound' });
  assert.equal(fresh.state, 'queued');
  assert.equal(fresh.attempts, 0);
  assert.equal(fresh.leaseUntil, null);
  assert.equal(fresh.nextAttemptAt, 2_000);
  assert.equal(fresh.createdAt, 2_000);
});

test('externalId 拆分与「裸 messageId / 带 chat 前缀」对齐（#219 C3 出站回声）', () => {
  assert.deepEqual(splitExternalId('oc_1:om_9'), { chatId: 'oc_1', messageId: 'om_9' });
  assert.deepEqual(splitExternalId('om_9'), { chatId: 'om_9', messageId: '' }, '没有冒号就整串当 chatId');
  assert.equal(sameExternalMessage('om_9', 'oc_1:om_9'), true, '飞书 outbox 存裸 id，入站带 chat 前缀');
  assert.equal(sameExternalMessage('oc_1:om_9', 'oc_1:om_9'), true);
  assert.equal(sameExternalMessage('oc_1:om_9', 'om_9'), true);
  assert.equal(sameExternalMessage('om_8', 'oc_1:om_9'), false);
  assert.equal(sameExternalMessage(null, 'oc_1:om_9'), false);
  assert.equal(sameExternalMessage('', 'oc_1:om_9'), false);
});
