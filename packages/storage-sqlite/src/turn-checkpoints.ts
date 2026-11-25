import type { DatabaseSync } from 'node:sqlite';
import type { CheckpointStore, TurnCheckpoint, TurnRefStore } from '@agent-hub/domain';

/** 回合检查点（ADR 0027 D1/D2）：每轮一行，开始前 / 结束后两个提交。ref 本身在工作空间的仓库里。 */
export function createSqliteCheckpoints(db: DatabaseSync): CheckpointStore {
  db.exec(`CREATE TABLE IF NOT EXISTS turn_checkpoints (
    session_id TEXT NOT NULL, turn INTEGER NOT NULL, prompt_seq INTEGER NOT NULL,
    before_sha TEXT NOT NULL, after_sha TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
    files INTEGER, additions INTEGER, deletions INTEGER, delivery_id TEXT,
    PRIMARY KEY (session_id, turn))`);
  const columns = db.prepare('PRAGMA table_info(turn_checkpoints)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'delivery_id')) db.exec('ALTER TABLE turn_checkpoints ADD COLUMN delivery_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS turn_checkpoints_delivery ON turn_checkpoints(session_id, delivery_id) WHERE delivery_id IS NOT NULL');
  const list = db.prepare('SELECT * FROM turn_checkpoints WHERE session_id = ? ORDER BY turn');
  const begin = db.prepare('INSERT OR IGNORE INTO turn_checkpoints (session_id, turn, prompt_seq, before_sha, started_at, delivery_id) VALUES (?, ?, ?, ?, ?, ?)');
  const end = db.prepare('UPDATE turn_checkpoints SET after_sha = ?, ended_at = ?, files = ?, additions = ?, deletions = ? WHERE session_id = ? AND turn = ? AND after_sha IS NULL');
  const stale = db.prepare('SELECT session_id FROM turn_checkpoints GROUP BY session_id HAVING MAX(COALESCE(ended_at, started_at)) < ?');
  const remove = db.prepare('DELETE FROM turn_checkpoints WHERE session_id = ?');
  type Row = { session_id: string; turn: number; prompt_seq: number; before_sha: string; after_sha: string | null; started_at: number; ended_at: number | null; files: number | null; additions: number | null; deletions: number | null; delivery_id: string | null };
  const toTurn = (r: Row): TurnCheckpoint => ({
    sessionId: r.session_id, turn: r.turn, promptSeq: r.prompt_seq, before: r.before_sha, after: r.after_sha,
    startedAt: r.started_at, endedAt: r.ended_at, files: r.files, additions: r.additions, deletions: r.deletions,
    ...(r.delivery_id ? { deliveryId: r.delivery_id } : {})
  });
  return {
    async list(sessionId) {
      return (list.all(sessionId) as Row[]).map(toTurn);
    },
    async begin(row, signal) {
      // DatabaseSync.run is synchronous: an event-loop timeout cannot abort between
      // this check and the insert. Never introduce an await between them.
      if (signal?.aborted) return;
      begin.run(row.sessionId, row.turn, row.promptSeq, row.before, row.startedAt, row.deliveryId ?? null);
    },
    async end(sessionId, turn, row) {
      end.run(row.after, row.endedAt, row.files, row.additions, row.deletions, sessionId, turn);
    },
    async staleSessions(cutoff) {
      return (stale.all(cutoff) as { session_id: string }[]).map((r) => r.session_id);
    },
    async remove(sessionId) {
      remove.run(sessionId);
    }
  };
}

/** 每轮的原生标识（ADR 0028），从这里重来时原生分叉用。 */
export function createSqliteTurnRefs(db: DatabaseSync): TurnRefStore {
  db.exec(`CREATE TABLE IF NOT EXISTS turn_refs (
    session_id TEXT NOT NULL, prompt_seq INTEGER NOT NULL, turn_ref TEXT NOT NULL, delivery_id TEXT,
    PRIMARY KEY (session_id, prompt_seq))`);
  const columns = db.prepare('PRAGMA table_info(turn_refs)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'delivery_id')) db.exec('ALTER TABLE turn_refs ADD COLUMN delivery_id TEXT');
  const put = db.prepare(`INSERT INTO turn_refs (session_id, prompt_seq, turn_ref, delivery_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, prompt_seq) DO UPDATE SET turn_ref = excluded.turn_ref, delivery_id = excluded.delivery_id
    WHERE turn_refs.delivery_id IS NULL`);
  const list = db.prepare('SELECT prompt_seq, turn_ref FROM turn_refs WHERE session_id = ?');
  const verified = db.prepare('SELECT prompt_seq, turn_ref, delivery_id FROM turn_refs WHERE session_id = ? AND delivery_id IS NOT NULL AND delivery_id <> \'\'');
  return {
    async record(sessionId, promptSeq, turnRef, deliveryId) {
      if (!deliveryId || !turnRef || !Number.isSafeInteger(promptSeq) || promptSeq < 1) return;
      put.run(sessionId, promptSeq, turnRef, deliveryId);
    },
    async list(sessionId) {
      return new Map((list.all(sessionId) as { prompt_seq: number; turn_ref: string }[]).map((r) => [r.prompt_seq, r.turn_ref]));
    },
    async listVerified(sessionId) {
      return new Map((verified.all(sessionId) as { prompt_seq: number; turn_ref: string; delivery_id: string }[]).map((r) => [r.prompt_seq, { turnRef: r.turn_ref, deliveryId: r.delivery_id }]));
    }
  };
}
