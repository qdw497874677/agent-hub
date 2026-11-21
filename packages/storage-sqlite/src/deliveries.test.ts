import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Delivery } from '@agent-hub/domain';
import { createSqliteDeliveries } from './deliveries.ts';

const row = (id: string, sessionId: string, createdAt: number, over: Partial<Delivery> = {}): Delivery => ({
  id, sessionId, seq: createdAt, kind: 'prompt', payload: { text: id, parts: [] }, state: 'queued', attempt: 0, nextAt: null, lastError: null, createdAt, updatedAt: createdAt, ...over
});

test('认领：同一会话并发只放行一条；未送达的队首被重新排队，新的一句不越过', async () => {
  const db = new DatabaseSync(':memory:');
  const q = createSqliteDeliveries(db);
  const [first, second] = await Promise.all([
    q.claimPrompt(row('a1', 'A', 1, { nextAt: 1 })),
    q.claimPrompt(row('a2', 'A', 2, { nextAt: 2 }))
  ]);
  assert.deepEqual([first.send, second.send].sort(), [false, true]);
  const pending = await q.pendingFor('A');
  assert.equal(pending.length, 2);
  assert.equal(pending.filter((item) => item.nextAt === null).length, 1);
  await q.save({ ...pending[0]!, state: 'undelivered', nextAt: null });
  const third = await q.claimPrompt(row('a3', 'A', 3, { nextAt: 3 }));
  assert.equal(third.send, false);
  const again = await q.pendingFor('A');
  assert.equal(again[0]!.state, 'queued');
  assert.equal(again[0]!.attempt, 0);
  assert.equal(again.at(-1)!.id, 'a3');
  assert.equal(again.at(-1)!.nextAt, null);
});

test('送达队列：每个会话只出队首；未送达挡住后面的；重开数据库后 sending 仍占着在途；held 能取回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-delivery-queue-'));
  const path = join(dir, 'hub.db');
  try {
    const first = new DatabaseSync(path);
    const q = createSqliteDeliveries(first);
    await q.save(row('a1', 'A', 1, { nextAt: 5 }));
    await q.save(row('a2', 'A', 2));
    await q.save(row('b1', 'B', 3, { state: 'undelivered' }));
    await q.save(row('b2', 'B', 4));
    await q.save(row('c1', 'C', 5, { state: 'sending' }));
    assert.deepEqual((await q.due(4)).map((d) => d.id), []);
    assert.deepEqual((await q.due(5)).map((d) => d.id), ['a1']);
    assert.deepEqual((await q.pendingFor('B')).map((d) => d.id), ['b1', 'b2']);
    await q.save(row('h', 'A', 7, { kind: 'handoff_brief', state: 'held', payload: { text: 'brief' } }));
    assert.deepEqual((await q.held('A', 'handoff_brief'))!.payload, { text: 'brief' });
    assert.equal((await q.pendingFor('A')).some((d) => d.id === 'h'), false);
    first.close();

    // 重启不把 sending 退回 queued：它继续占着在途，不出现在 due 里，精确 inFlight 仍能看到。
    const reopened = new DatabaseSync(path);
    const q2 = createSqliteDeliveries(reopened);
    assert.deepEqual((await q2.due(10)).map((d) => d.id), ['a1']);
    assert.equal((await q2.byId('c1'))!.state, 'sending');
    assert.equal((await q2.inFlight('C'))!.id, 'c1');
    await q2.save(row('a1', 'A', 1, { state: 'delivered' }));
    assert.deepEqual((await q2.due(10)).map((d) => d.id), ['a2']);
    await q2.save(row('a2', 'A', 2, { nextAt: 999 }));
    assert.equal(await q2.wakeAll(20), 1);
    assert.equal((await q2.byId('a2'))!.nextAt, 20);
    assert.deepEqual((await q2.held('A', 'handoff_brief'))!.payload, { text: 'brief' });
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claimSend：只认领队首，不越过更早的 queued/undelivered，也不越过别的 sending', async () => {
  const q = createSqliteDeliveries(new DatabaseSync(':memory:'));
  await q.save(row('a1', 'A', 1, { nextAt: 1 }));
  await q.save(row('a2', 'A', 2, { nextAt: 2 }));
  assert.equal(await q.claimSend('a2', 10), false);
  assert.equal((await q.byId('a2'))!.state, 'queued');
  assert.equal(await q.claimSend('a1', 10), true);
  assert.equal(await q.claimSend('a1', 11), false);
  assert.equal(await q.claimSend('a2', 11), false);
  assert.equal((await q.byId('a2'))!.state, 'queued');
  // 未送达的队首可以认领（保留旧语义），但后面的仍不能越过它。
  await q.save(row('b1', 'B', 1, { state: 'undelivered' }));
  await q.save(row('b2', 'B', 2));
  assert.equal(await q.claimSend('b2', 12), false);
  assert.equal(await q.claimSend('b1', 12), true);
  // 交接简报这类非 prompt 不走派发认领。
  await q.save(row('h', 'A', 0, { kind: 'handoff_brief', state: 'queued' }));
  assert.equal(await q.claimSend('h', 13), false);
});

test('claimSend：不同会话互不阻塞，同一会话并发只有一个成功', async () => {
  const q = createSqliteDeliveries(new DatabaseSync(':memory:'));
  await q.save(row('a1', 'A', 1));
  await q.save(row('a2', 'A', 2));
  await q.save(row('b1', 'B', 3));
  await q.save(row('c1', 'C', 4, { createdAt: 1, seq: 2 }));
  await q.save(row('c2', 'C', 5, { createdAt: 1, seq: 2 }));
  assert.deepEqual(await Promise.all([q.claimSend('a1', 10), q.claimSend('b1', 10)]), [true, true]);
  assert.deepEqual(await Promise.all([q.claimSend('a2', 11), q.claimSend('a1', 11), q.claimSend('a2', 11)]), [false, false, false]);
  // createdAt / seq 相同：按 id 字典序决定队首，c1 先于 c2。
  assert.deepEqual([await q.claimSend('c2', 12), await q.claimSend('c1', 12)], [false, true]);
});

test('finishSending：会话不符 / 未知 id / 非 sending 都不改行，重复完成是 no-op', async () => {
  const q = createSqliteDeliveries(new DatabaseSync(':memory:'));
  await q.save(row('a1', 'A', 1, { state: 'sending', attempt: 2 }));
  assert.equal(await q.finishSending('B', 'a1', 10), false);
  assert.equal(await q.finishSending('A', 'nope', 10), false);
  assert.equal((await q.byId('a1'))!.state, 'sending');
  assert.equal((await q.byId('a1'))!.attempt, 2);
  assert.equal(await q.finishSending('A', 'a1', 10), true);
  const done = (await q.byId('a1'))!;
  assert.equal(done.state, 'delivered');
  assert.equal(done.attempt, 3);
  assert.equal(done.updatedAt, 10);
  assert.equal(await q.finishSending('A', 'a1', 11), false);
  assert.equal((await q.byId('a1'))!.updatedAt, 10);
});

test('重开数据库：inFlight 仍看到 sending，只有精确完成才放行下一条', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-delivery-'));
  const path = join(dir, 'hub.db');
  try {
    const first = new DatabaseSync(path);
    const q = createSqliteDeliveries(first);
    await q.save(row('a1', 'A', 1));
    await q.save(row('a2', 'A', 2));
    assert.equal(await q.claimSend('a1', 10), true);
    // inFlight 不受 recent 条数限制：塞满 delivered 之后仍能精确查到在飞的那条。
    for (let i = 0; i < 250; i++) await q.save(row(`old${i}`, 'A', 100 + i, { state: 'delivered' }));
    first.close();

    const reopened = new DatabaseSync(path);
    const q2 = createSqliteDeliveries(reopened);
    assert.equal((await q2.inFlight('A'))!.id, 'a1');
    assert.equal(await q2.inFlight('B'), null);
    assert.equal(await q2.claimSend('a2', 20), false);
    assert.equal(await q2.finishSending('A', 'a2', 20), false);
    assert.equal((await q2.byId('a2'))!.state, 'queued');
    assert.equal(await q2.finishSending('A', 'a1', 20), true);
    assert.equal(await q2.inFlight('A'), null);
    assert.equal(await q2.claimSend('a2', 21), true);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
