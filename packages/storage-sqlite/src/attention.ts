import type { DatabaseSync } from 'node:sqlite';
import type { AttentionAck, AttentionStore, Phase } from '@agent-hub/domain';

/** 「人已看过」（ADR 0031 D1 attention_ack）：按 (账号, 会话, 阶段, 进入时刻) 记一条，重复看不重复记。 */
export function createSqliteAttention(db: DatabaseSync): AttentionStore {
  db.exec(`CREATE TABLE IF NOT EXISTS attention_ack (
    account_id TEXT NOT NULL, session_id TEXT NOT NULL, phase TEXT NOT NULL, since INTEGER NOT NULL, acked_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, session_id, phase, since))`);
  const insert = db.prepare('INSERT OR IGNORE INTO attention_ack (account_id, session_id, phase, since, acked_at) VALUES (?,?,?,?,?)');
  const list = db.prepare('SELECT session_id, phase, since FROM attention_ack WHERE account_id = ? AND acked_at > ?');
  return {
    async ack(accountId, a, at) {
      insert.run(accountId, a.sessionId, a.phase, a.since, at);
    },
    async acks(accountId) {
      return (list.all(accountId, Date.now() - 30 * 24 * 3600_000) as { session_id: string; phase: string; since: number }[])
        .map((r): AttentionAck => ({ sessionId: r.session_id, phase: r.phase as Phase, since: r.since }));
    }
  };
}
