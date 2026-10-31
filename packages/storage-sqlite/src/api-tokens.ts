import type { DatabaseSync } from 'node:sqlite';
import type { ApiScope, ApiToken, ApiTokenRepository } from '@agent-hub/domain';

/** 开放 API 令牌（ADR 0014）：只存哈希；明文只在创建时给一次。 */
export const API_TOKEN_SCHEMA = `
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('personal','service')),
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS api_tokens_by_team ON api_tokens(team_id);
`;

type Row = Record<string, unknown>;
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export function createSqliteApiTokens(db: DatabaseSync): ApiTokenRepository {
  db.exec(API_TOKEN_SCHEMA);
  const toToken = (row: Row): ApiToken => ({
    id: row.id as string,
    teamId: row.team_id as string,
    kind: row.kind as ApiToken['kind'],
    userId: row.user_id as string,
    name: row.name as string,
    scopes: JSON.parse(row.scopes as string) as ApiScope[],
    prefix: row.prefix as string,
    tokenHash: row.token_hash as string,
    createdBy: row.created_by as string,
    createdAt: Number(row.created_at),
    expiresAt: num(row.expires_at),
    lastUsedAt: num(row.last_used_at),
    revokedAt: num(row.revoked_at)
  });
  const upsert = db.prepare(`INSERT INTO api_tokens (id, team_id, kind, user_id, name, scopes, prefix, token_hash, created_by, created_at, expires_at, last_used_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, scopes = excluded.scopes, expires_at = excluded.expires_at,
      last_used_at = excluded.last_used_at, revoked_at = excluded.revoked_at`);
  const one = db.prepare('SELECT * FROM api_tokens WHERE id = ?');
  const hash = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?');
  const team = db.prepare('SELECT * FROM api_tokens WHERE team_id = ? ORDER BY created_at DESC');
  const touch = db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?');
  return {
    async save(t) {
      upsert.run(t.id, t.teamId, t.kind, t.userId, t.name, JSON.stringify(t.scopes), t.prefix, t.tokenHash, t.createdBy, t.createdAt, t.expiresAt, t.lastUsedAt, t.revokedAt);
    },
    async byId(id) {
      const row = one.get(id) as Row | undefined;
      return row ? toToken(row) : null;
    },
    async byHash(value) {
      const row = hash.get(value) as Row | undefined;
      return row ? toToken(row) : null;
    },
    async listByTeam(teamId) {
      return (team.all(teamId) as Row[]).map(toToken);
    },
    async touch(id, at) {
      touch.run(at, id);
    }
  };
}
