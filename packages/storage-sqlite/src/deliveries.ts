import type { DatabaseSync } from 'node:sqlite';
import type { Delivery, DeliveryQueue } from '@agent-hub/domain';

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
  const upsert = db.prepare(`INSERT OR REPLACE INTO message_delivery
    (id, session_id, seq, kind, payload, state, attempt, next_at, last_error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const byId = db.prepare('SELECT * FROM message_delivery WHERE id = ?');
  const pending = db.prepare(`SELECT * FROM message_delivery WHERE session_id = ? AND kind = 'prompt'
    AND state IN ('queued','sending','undelivered') ORDER BY created_at, seq`);
  // 每个会话的队首：没有更早的未完成项，且自己到期
  const due = db.prepare(`SELECT * FROM message_delivery d WHERE d.kind = 'prompt' AND d.state = 'queued'
    AND NOT EXISTS (SELECT 1 FROM message_delivery e WHERE e.session_id = d.session_id AND e.kind = 'prompt'
      AND e.state IN ('queued','sending','undelivered') AND (e.created_at < d.created_at OR (e.created_at = d.created_at AND e.seq < d.seq)))
    AND COALESCE(d.next_at, 0) <= ? ORDER BY d.created_at LIMIT 50`);
  const held = db.prepare(`SELECT * FROM message_delivery WHERE session_id = ? AND kind = ? AND state = 'held' ORDER BY created_at DESC LIMIT 1`);
  const recent = db.prepare('SELECT * FROM message_delivery WHERE session_id = ? AND kind = \'prompt\' ORDER BY created_at DESC LIMIT ?');
  const wake = db.prepare(`UPDATE message_delivery SET next_at = ? WHERE kind = 'prompt' AND state = 'queued' AND COALESCE(next_at, 0) > ?`);
  const recover = db.prepare(`UPDATE message_delivery SET state = 'queued', next_at = ?, updated_at = ? WHERE state = 'sending'`);
  return {
    async save(d) {
      upsert.run(d.id, d.sessionId, d.seq, d.kind, JSON.stringify(d.payload), d.state, d.attempt, d.nextAt, d.lastError, d.createdAt, d.updatedAt);
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
    async wakeAll(now) {
      return Number(wake.run(now, now).changes);
    },
    async recoverSending(now) {
      return Number(recover.run(now, now).changes);
    }
  };
}
