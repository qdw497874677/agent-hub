import type { DatabaseSync } from 'node:sqlite';
import type { Delivery, DeliveryQueue } from '@agent-hub/domain';
import { upsertSql } from './upsert.ts';
import { inTransaction } from './tx.ts';

/** 送达队列（ADR 0031 D2）。payload 是 JSON（附件只存引用，不存二进制以外的东西）。 */
export function createSqliteDeliveries(db: DatabaseSync): DeliveryQueue {
  db.exec(`CREATE TABLE IF NOT EXISTS message_delivery (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
    payload TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS message_delivery_due ON message_delivery(state, next_at)');
  db.exec('CREATE INDEX IF NOT EXISTS message_delivery_session ON message_delivery(session_id, created_at)');
  type Row = { id: string; session_id: string; seq: number; kind: string; payload: string; state: string; attempt: number; next_at: number | null; last_error: string | null; created_at: number; updated_at: number };
  const toDelivery = (r: Row): Delivery => ({
    id: r.id, sessionId: r.session_id, seq: r.seq, kind: r.kind as Delivery['kind'], payload: JSON.parse(r.payload) as unknown,
    state: r.state as Delivery['state'], attempt: r.attempt, nextAt: r.next_at, lastError: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at
  });
  const upsert = db.prepare(upsertSql('message_delivery', [
    'id', 'session_id', 'seq', 'kind', 'payload', 'state', 'attempt', 'next_at', 'last_error', 'created_at', 'updated_at'
  ]));
  const byId = db.prepare('SELECT * FROM message_delivery WHERE id = ?');
  const pending = db.prepare(`SELECT * FROM message_delivery WHERE session_id = ? AND kind = 'prompt'
    AND state IN ('queued','sending','undelivered') ORDER BY created_at, seq, id`);
  // 每个会话的队首：没有更早的未完成项，且自己到期（created_at、seq、id 全序，不靠插入顺序）
  const due = db.prepare(`SELECT * FROM message_delivery d WHERE d.kind = 'prompt' AND d.state = 'queued'
    AND NOT EXISTS (SELECT 1 FROM message_delivery e WHERE e.session_id = d.session_id AND e.kind = 'prompt'
      AND e.state IN ('queued','sending','undelivered') AND (e.created_at < d.created_at
        OR (e.created_at = d.created_at AND e.seq < d.seq)
        OR (e.created_at = d.created_at AND e.seq = d.seq AND e.id < d.id)))
    AND COALESCE(d.next_at, 0) <= ? ORDER BY d.created_at, d.seq, d.id LIMIT 50`);
  const held = db.prepare(`SELECT * FROM message_delivery WHERE session_id = ? AND kind = ? AND state = 'held' ORDER BY created_at DESC, seq DESC, id DESC LIMIT 1`);
  const recent = db.prepare('SELECT * FROM message_delivery WHERE session_id = ? AND kind = \'prompt\' ORDER BY created_at DESC, seq DESC, id DESC LIMIT ?');
  const inFlight = db.prepare(`SELECT * FROM message_delivery WHERE session_id = ? AND kind = 'prompt' AND state = 'sending'
    ORDER BY created_at, seq, id LIMIT 1`);
  const stale = db.prepare(`SELECT * FROM message_delivery WHERE kind = 'prompt' AND state = 'delivered'
    AND updated_at <= ? ORDER BY updated_at LIMIT ?`);
  const wake = db.prepare(`UPDATE message_delivery SET next_at = ? WHERE kind = 'prompt' AND state = 'queued' AND COALESCE(next_at, 0) > ?`);
  // 原子认领队首：自述还在 queued/undelivered，前面没有更早的未完成项（created_at、seq、id 全序），
  // 且同一会话没有别的 sending。单条 UPDATE + NOT EXISTS 在 SQLite 里是原子的。
  const claimSend = db.prepare(`UPDATE message_delivery SET state = 'sending', updated_at = ?
    WHERE id = ? AND kind = 'prompt' AND state IN ('queued','undelivered')
      AND NOT EXISTS (SELECT 1 FROM message_delivery e
        WHERE e.session_id = message_delivery.session_id AND e.kind = 'prompt'
          AND e.state IN ('queued','sending','undelivered')
          AND (e.created_at < message_delivery.created_at
            OR (e.created_at = message_delivery.created_at AND e.seq < message_delivery.seq)
            OR (e.created_at = message_delivery.created_at AND e.seq = message_delivery.seq AND e.id < message_delivery.id)))
      AND NOT EXISTS (SELECT 1 FROM message_delivery s
        WHERE s.session_id = message_delivery.session_id AND s.kind = 'prompt'
          AND s.state = 'sending' AND s.id <> message_delivery.id)`);
  // 只有「这条会话的这条还在 sending」能完成：重复调用 / 会话不符都不改行。
  const finishSending = db.prepare(`UPDATE message_delivery
    SET state = 'delivered', attempt = attempt + 1, next_at = NULL, last_error = NULL, updated_at = ?
    WHERE session_id = ? AND id = ? AND state = 'sending'`);
  const reschedule = db.prepare(`UPDATE message_delivery SET state = 'queued', next_at = ?, last_error = NULL, updated_at = ?
    WHERE id = ? AND state IN ('queued','undelivered')`);
  const write = (d: Delivery) => {
    upsert.run(d.id, d.sessionId, d.seq, d.kind, JSON.stringify(d.payload), d.state, d.attempt, d.nextAt, d.lastError, d.createdAt, d.updatedAt);
  };
  return {
    async save(d) {
      write(d);
    },
    async claimSend(id, now) {
      // 单条 UPDATE 是原子的：并发两个入口只有一个能把状态翻成 sending。
      return Number(claimSend.run(now, id).changes) > 0;
    },
    async finishSending(sessionId, id, now) {
      return Number(finishSending.run(now, sessionId, id).changes) > 0;
    },
    async inFlight(sessionId) {
      const r = inFlight.get(sessionId) as Row | undefined;
      return r ? toDelivery(r) : null;
    },
    async reschedule(id, now, nextAt) {
      return Number(reschedule.run(nextAt, now, id).changes) > 0;
    },
    async claimPrompt(incoming) {
      // 读和写之间不能让出事件循环：否则两条 prompt 都会看见空队列，各派一次。
      return inTransaction(db, () => {
        const open = (pending.all(incoming.sessionId) as Row[]).map(toDelivery);
        const head = open[0];
        if (head?.state === 'undelivered') write({ ...head, state: 'queued', attempt: 0, nextAt: incoming.updatedAt, updatedAt: incoming.updatedAt });
        const ahead = (pending.all(incoming.sessionId) as Row[]).length > 0;
        const stored: Delivery = { ...incoming, state: 'queued', nextAt: ahead ? null : incoming.nextAt };
        write(stored);
        return { delivery: stored, send: !ahead };
      });
    },
    async byId(id) {
      const r = byId.get(id) as Row | undefined;
      return r ? toDelivery(r) : null;
    },
    async pendingFor(sessionId) {
      return (pending.all(sessionId) as Row[]).map(toDelivery);
    },
    async due(now) {
      return (due.all(now) as Row[]).map(toDelivery);
    },
    async held(sessionId, kind) {
      const r = held.get(sessionId, kind) as Row | undefined;
      return r ? toDelivery(r) : null;
    },
    async recent(sessionId, limit) {
      return (recent.all(sessionId, limit) as Row[]).map(toDelivery).reverse();
    },
    async deliveredBefore(cutoff, limit) {
      return (stale.all(cutoff, limit) as Row[]).map(toDelivery);
    },
    async wakeAll(now) {
      return Number(wake.run(now, now).changes);
    }
  };
}
