import type { DatabaseSync } from 'node:sqlite';
import {
  PROJECT_SESSION_GRANT_SCOPES,
  asProjectId,
  asSessionId,
  type ProjectSessionGrant,
  type ProjectSessionGrantRepository,
  type ProjectSessionGrantScope
} from '@agent-hub/domain';

/**
 * 项目会话显式授权的持久化（docs/design/project-session-mcp.md §27-§29）。
 * 同一 (账号, 会话, 项目) 只有一条；重新授权替换 scope 与有效期并清除撤销状态。
 */
export function createSqliteProjectSessionGrants(db: DatabaseSync): ProjectSessionGrantRepository {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_session_grants (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      scopes TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      revoked_by TEXT,
      UNIQUE (account_id, session_id, project_id)
    );
    CREATE INDEX IF NOT EXISTS project_session_grants_by_session
      ON project_session_grants (session_id);
    CREATE INDEX IF NOT EXISTS project_session_grants_by_account
      ON project_session_grants (account_id);
  `);

  const selectRow = db.prepare('SELECT * FROM project_session_grants WHERE account_id = ? AND session_id = ? AND project_id = ?');
  const selectById = db.prepare('SELECT * FROM project_session_grants WHERE id = ?');
  const selectBySession = db.prepare('SELECT * FROM project_session_grants WHERE session_id = ? ORDER BY created_at, id');
  const selectByAccount = db.prepare('SELECT * FROM project_session_grants WHERE account_id = ? ORDER BY created_at, id');
  const insert = db.prepare(`
    INSERT INTO project_session_grants
      (id, account_id, session_id, project_id, scopes, created_by, created_at, expires_at, revoked_at, revoked_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const replace = db.prepare(`
    UPDATE project_session_grants
       SET scopes = ?, expires_at = ?, revoked_at = NULL, revoked_by = NULL, created_by = ?
     WHERE account_id = ? AND session_id = ? AND project_id = ?
  `);
  const revokeOne = db.prepare(
    'UPDATE project_session_grants SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL'
  );
  const revokeSession = db.prepare(
    'UPDATE project_session_grants SET revoked_at = ?, revoked_by = ? WHERE account_id = ? AND session_id = ? AND revoked_at IS NULL'
  );

  const scopesOf = (raw: unknown): readonly ProjectSessionGrantScope[] => {
    if (typeof raw !== 'string') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const known = new Set<string>(PROJECT_SESSION_GRANT_SCOPES);
    return [...new Set(parsed.filter((scope): scope is string => typeof scope === 'string' && known.has(scope)))] as ProjectSessionGrantScope[];
  };

  const toDomain = (row: Record<string, unknown>): ProjectSessionGrant => ({
    id: String(row.id),
    accountId: String(row.account_id),
    sessionId: asSessionId(String(row.session_id)),
    projectId: asProjectId(String(row.project_id)),
    scopes: scopesOf(row.scopes),
    createdBy: String(row.created_by),
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    revokedBy: row.revoked_by === null ? null : String(row.revoked_by)
  });

  return {
    async save(grant) {
      const existing = selectRow.get(grant.accountId, grant.sessionId, grant.projectId) as Record<string, unknown> | undefined;
      if (existing) {
        // 重新授权保留原 id 与首次签发时间，界面上不会出现“同一条授权换了身份”。
        replace.run(JSON.stringify(grant.scopes), grant.expiresAt, grant.accountId, grant.accountId, grant.sessionId, grant.projectId);
        return toDomain(selectById.get(String(existing.id)) as Record<string, unknown>);
      }
      insert.run(
        grant.id,
        grant.accountId,
        grant.sessionId,
        grant.projectId,
        JSON.stringify(grant.scopes),
        grant.createdBy,
        grant.createdAt,
        grant.expiresAt,
        grant.revokedAt,
        grant.revokedBy
      );
      return toDomain(selectById.get(grant.id) as Record<string, unknown>);
    },

    async byKey(accountId, sessionId, projectId) {
      const row = selectRow.get(accountId, sessionId, projectId) as Record<string, unknown> | undefined;
      return row ? toDomain(row) : null;
    },

    async byId(id) {
      const row = selectById.get(id) as Record<string, unknown> | undefined;
      return row ? toDomain(row) : null;
    },

    async listBySession(sessionId) {
      return (selectBySession.all(sessionId) as Record<string, unknown>[]).map(toDomain);
    },

    async listByAccount(accountId) {
      return (selectByAccount.all(accountId) as Record<string, unknown>[]).map(toDomain);
    },

    async revoke(id, at, by) {
      return Number(revokeOne.run(at, by, id).changes) > 0;
    },

    async revokeSession(accountId, sessionId, at, by) {
      return Number(revokeSession.run(at, by, accountId, sessionId).changes);
    }
  };
}
