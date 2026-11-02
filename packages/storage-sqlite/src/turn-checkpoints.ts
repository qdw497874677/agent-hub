import type { DatabaseSync } from 'node:sqlite';
import type { CheckpointStore, TurnCheckpoint } from '@agent-hub/domain';

/** 回合检查点（ADR 0027 D1/D2）：每轮一行，开始前 / 结束后两个提交。ref 本身在工作空间的仓库里。 */
export function createSqliteCheckpoints(db: DatabaseSync): CheckpointStore {
  db.exec(`CREATE TABLE IF NOT EXISTS turn_checkpoints (
    session_id TEXT NOT NULL, turn INTEGER NOT NULL, prompt_seq INTEGER NOT NULL,
    before_sha TEXT NOT NULL, after_sha TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
    files INTEGER, additions INTEGER, deletions INTEGER,
    PRIMARY KEY (session_id, turn))`);
  const list = db.prepare('SELECT * FROM turn_checkpoints WHERE session_id = ? ORDER BY turn');
  const begin = db.prepare('INSERT OR REPLACE INTO turn_checkpoints (session_id, turn, prompt_seq, before_sha, started_at) VALUES (?, ?, ?, ?, ?)');
  const end = db.prepare('UPDATE turn_checkpoints SET after_sha = ?, ended_at = ?, files = ?, additions = ?, deletions = ? WHERE session_id = ? AND turn = ?');
  const stale = db.prepare('SELECT session_id FROM turn_checkpoints GROUP BY session_id HAVING MAX(COALESCE(ended_at, started_at)) < ?');
  const remove = db.prepare('DELETE FROM turn_checkpoints WHERE session_id = ?');
  type Row = { session_id: string; turn: number; prompt_seq: number; before_sha: string; after_sha: string | null; started_at: number; ended_at: number | null; files: number | null; additions: number | null; deletions: number | null };
  const toTurn = (r: Row): TurnCheckpoint => ({
    sessionId: r.session_id, turn: r.turn, promptSeq: r.prompt_seq, before: r.before_sha, after: r.after_sha,
    startedAt: r.started_at, endedAt: r.ended_at, files: r.files, additions: r.additions, deletions: r.deletions
  });
  return {
    async list(sessionId) {
      return (list.all(sessionId) as Row[]).map(toTurn);
    },
    async begin(row) {
      begin.run(row.sessionId, row.turn, row.promptSeq, row.before, row.startedAt);
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
