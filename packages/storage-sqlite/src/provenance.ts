import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { SessionProvenance, ProvenanceStore } from '@agent-hub/domain';

/**
 * 任务来历（ADR 0031 D3）：只 INSERT，不 UPDATE。触发器挡住任何 UPDATE，
 * 以后有人顺手写了 UPDATE 也改不动。老会话在建表时按 origin 回填，标 backfilled。
 */
export function createSqliteProvenance(db: DatabaseSync): ProvenanceStore {
  db.exec(`CREATE TABLE IF NOT EXISTS session_provenance (
    session_id TEXT PRIMARY KEY, id TEXT NOT NULL, task_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
    via TEXT NOT NULL, parent_session TEXT, parent_seq INTEGER,
    authority TEXT NOT NULL, backfilled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS session_provenance_immutable BEFORE UPDATE ON session_provenance
    BEGIN SELECT RAISE(ABORT, 'session_provenance is immutable'); END`);
  backfill(db);
  type Row = { session_id: string; id: string; task_id: string; actor_kind: string; actor_id: string; actor_name: string; via: string;
    parent_session: string | null; parent_seq: number | null; authority: string; backfilled: number; created_at: number };
  const insert = db.prepare(`INSERT OR IGNORE INTO session_provenance
    (session_id, id, task_id, actor_kind, actor_id, actor_name, via, parent_session, parent_seq, authority, backfilled, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const byId = db.prepare('SELECT * FROM session_provenance WHERE session_id = ?');
  return {
    async record(p) {
      const r = insert.run(p.sessionId, p.id, p.taskId, p.actor.kind, p.actor.id, p.actor.name, p.via,
        p.parent?.sessionId ?? null, p.parent?.atSeq ?? null, JSON.stringify(p.authority), p.backfilled ? 1 : 0, p.createdAt);
      return Number(r.changes) > 0;
    },
    async get(sessionId) {
      const r = byId.get(sessionId) as Row | undefined;
      if (!r) return null;
      return {
        id: r.id, sessionId: r.session_id, taskId: r.task_id,
        actor: { kind: r.actor_kind as SessionProvenance['actor']['kind'], id: r.actor_id, name: r.actor_name },
        via: r.via as SessionProvenance['via'],
        parent: r.parent_session ? { sessionId: r.parent_session, ...(r.parent_seq !== null ? { atSeq: r.parent_seq } : {}) } : null,
        authority: JSON.parse(r.authority) as SessionProvenance['authority'],
        backfilled: r.backfilled === 1,
        createdAt: r.created_at
      };
    }
  };
}

/** 迁移：没有来历的老会话按 origin 回填（via=fork|web，actor=system(legacy)，补录）。只加不改。 */
function backfill(db: DatabaseSync): void {
  const rows = db.prepare(`SELECT s.id, s.task_id, s.origin_kind, s.origin_session, s.origin_seq, s.created_at FROM sessions s
    WHERE NOT EXISTS (SELECT 1 FROM session_provenance p WHERE p.session_id = s.id)`).all() as
    { id: string; task_id: string; origin_kind: string; origin_session: string | null; origin_seq: number | null; created_at: number }[];
  if (!rows.length) return;
  const insert = db.prepare(`INSERT OR IGNORE INTO session_provenance
    (session_id, id, task_id, actor_kind, actor_id, actor_name, via, parent_session, parent_seq, authority, backfilled, created_at)
    VALUES (?,?,?,'system','legacy','系统（补录）',?,?,?,'{"role":"unknown"}',1,?)`);
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const fork = r.origin_kind === 'fork' && r.origin_session;
      insert.run(r.id, randomUUID(), r.task_id, fork ? 'fork' : 'web', fork ? r.origin_session : null, fork ? r.origin_seq : null, r.created_at);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
