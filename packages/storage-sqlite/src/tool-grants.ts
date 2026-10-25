import type { DatabaseSync } from 'node:sqlite';
import type { SessionId, ToolCallRecord, ToolGrant, ToolGrantRepository, ToolScope } from '@agent-hub/domain';
import { asSessionId, asTaskId } from '@agent-hub/domain';

type Row = Record<string, unknown>;

export const TOOL_SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_grants (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  worker_id TEXT,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS tool_grants_session ON tool_grants(session_id);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  version INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_at ON tool_calls(at);
`;

const toGrant = (row: Row): ToolGrant => ({
  id: row.id as string,
  tokenHash: row.token_hash as string,
  taskId: asTaskId(row.task_id as string),
  sessionId: asSessionId(row.session_id as string),
  workerId: (row.worker_id as string | null) ?? null,
  scopes: JSON.parse(row.scopes as string) as ToolScope[],
  createdAt: row.created_at as number,
  expiresAt: row.expires_at as number,
  revokedAt: (row.revoked_at as number | null) ?? null
});

const toCall = (row: Row): ToolCallRecord => ({
  id: row.id as string,
  grantId: row.grant_id as string,
  taskId: asTaskId(row.task_id as string),
  sessionId: asSessionId(row.session_id as string),
  tool: row.tool as string,
  version: row.version as number,
  ok: row.ok === 1,
  detail: row.detail as string,
  latencyMs: row.latency_ms as number,
  at: row.at as number
});

export function createToolGrantRepository(db: DatabaseSync): ToolGrantRepository {
  db.exec(TOOL_SCHEMA);
  const upsert = db.prepare(
    `INSERT INTO tool_grants (id, token_hash, task_id, session_id, worker_id, scopes, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET revoked_at = excluded.revoked_at, expires_at = excluded.expires_at`
  );
  const byHash = db.prepare('SELECT * FROM tool_grants WHERE token_hash = ?');
  const revoke = db.prepare('UPDATE tool_grants SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL');
  const activeRows = db.prepare('SELECT id, session_id FROM tool_grants WHERE revoked_at IS NULL');
  const revokeOne = db.prepare('UPDATE tool_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL');
  const insertCall = db.prepare(
    `INSERT INTO tool_calls (id, grant_id, task_id, session_id, tool, version, ok, detail, latency_ms, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const recent = db.prepare('SELECT * FROM tool_calls ORDER BY at DESC, rowid DESC LIMIT ?');
  const recentBySession = db.prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY at DESC, rowid DESC LIMIT ?');
  return {
    async save(grant) {
      upsert.run(
        grant.id,
        grant.tokenHash,
        grant.taskId,
        grant.sessionId,
        grant.workerId,
        JSON.stringify(grant.scopes),
        grant.createdAt,
        grant.expiresAt,
        grant.revokedAt
      );
    },
    async byTokenHash(hash) {
      const row = byHash.get(hash) as Row | undefined;
      return row ? toGrant(row) : null;
    },
    async revokeAllExcept(keep, now) {
      // keep 一般只有几条运行中的会话；整表扫一遍有效授权即可
      const active = activeRows.all() as Row[];
      let count = 0;
      for (const row of active) {
        if (keep.includes(row.session_id as SessionId)) continue;
        count += Number(revokeOne.run(now, row.id as string).changes);
      }
      return count;
    },
    async revokeSession(sessionId: SessionId, now: number) {
      return Number(revoke.run(now, sessionId).changes);
    },
    async recordCall(record) {
      insertCall.run(
        record.id,
        record.grantId,
        record.taskId,
        record.sessionId,
        record.tool,
        record.version,
        record.ok ? 1 : 0,
        record.detail,
        record.latencyMs,
        record.at
      );
    },
    async recentCalls(limit, sessionId) {
      const rows = (sessionId ? recentBySession.all(sessionId, limit) : recent.all(limit)) as Row[];
      return rows.map(toCall);
    }
  };
}
