import type { DatabaseSync } from 'node:sqlite';
import type { ApiScope, ApiToken, ApiTokenRepository } from '@agent-hub/domain';

/** 表体（建表 / 重建共用）。bot 凭据用 bot_project_id + bot_name 记归属（C1）。 */
const TABLE_BODY = `
  id             TEXT PRIMARY KEY,
  team_id        TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('personal','service','bot')),
  user_id        TEXT NOT NULL,
  bot_project_id TEXT,
  bot_name       TEXT,
  name           TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  prefix         TEXT NOT NULL,
  token_hash     TEXT NOT NULL UNIQUE,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER,
  last_used_at   INTEGER,
  revoked_at     INTEGER
`;

/** 开放 API 令牌（ADR 0015）：只存哈希；明文只在创建时给一次。 */
export const API_TOKEN_SCHEMA = `
CREATE TABLE IF NOT EXISTS api_tokens (${TABLE_BODY});
CREATE INDEX IF NOT EXISTS api_tokens_by_team ON api_tokens(team_id);
`;

type Row = Record<string, unknown>;
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

const columnsOf = (db: DatabaseSync, table: string): Set<string> =>
  new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));

/**
 * 迁移（C1）：
 * - 老库的 kind CHECK 只允许 personal / service。SQLite 改不了 CHECK，只能重建表再搬数据；
 * - 已经允许 bot（或由本版本建的表）但缺 bot 列的，用 ALTER TABLE 补，PRAGMA table_info 判重。
 */
function migrate(db: DatabaseSync): void {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_tokens'").get() as { sql?: string } | undefined;
  if (!existing) {
    db.exec(API_TOKEN_SCHEMA);
    return;
  }
  if (!/'bot'/.test(existing.sql ?? '')) {
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE api_tokens_new (${TABLE_BODY})`);
      db.exec(`INSERT INTO api_tokens_new (id, team_id, kind, user_id, bot_project_id, bot_name, name, scopes, prefix, token_hash, created_by, created_at, expires_at, last_used_at, revoked_at)
        SELECT id, team_id, kind, user_id, NULL, NULL, name, scopes, prefix, token_hash, created_by, created_at, expires_at, last_used_at, revoked_at FROM api_tokens`);
      db.exec('DROP TABLE api_tokens');
      db.exec('ALTER TABLE api_tokens_new RENAME TO api_tokens');
      db.exec('CREATE INDEX IF NOT EXISTS api_tokens_by_team ON api_tokens(team_id)');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return;
  }
  const columns = columnsOf(db, 'api_tokens');
  if (!columns.has('bot_project_id')) db.exec('ALTER TABLE api_tokens ADD COLUMN bot_project_id TEXT');
  if (!columns.has('bot_name')) db.exec('ALTER TABLE api_tokens ADD COLUMN bot_name TEXT');
}

export function createSqliteApiTokens(db: DatabaseSync): ApiTokenRepository {
  migrate(db);
  const toToken = (row: Row): ApiToken => {
    const botProjectId = row.bot_project_id;
    return {
      id: row.id as string,
      teamId: row.team_id as string,
      kind: row.kind as ApiToken['kind'],
      userId: row.user_id as string,
      ...(typeof botProjectId === 'string' ? { bot: { projectId: botProjectId, name: (row.bot_name as string | null) ?? '' } } : {}),
      name: row.name as string,
      scopes: JSON.parse(row.scopes as string) as ApiScope[],
      prefix: row.prefix as string,
      tokenHash: row.token_hash as string,
      createdBy: row.created_by as string,
      createdAt: Number(row.created_at),
      expiresAt: num(row.expires_at),
      lastUsedAt: num(row.last_used_at),
      revokedAt: num(row.revoked_at)
    };
  };
  const upsert = db.prepare(`INSERT INTO api_tokens (id, team_id, kind, user_id, bot_project_id, bot_name, name, scopes, prefix, token_hash, created_by, created_at, expires_at, last_used_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, scopes = excluded.scopes, expires_at = excluded.expires_at,
      bot_project_id = excluded.bot_project_id, bot_name = excluded.bot_name,
      last_used_at = excluded.last_used_at, revoked_at = excluded.revoked_at`);
  const one = db.prepare('SELECT * FROM api_tokens WHERE id = ?');
  const hash = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?');
  const team = db.prepare('SELECT * FROM api_tokens WHERE team_id = ? ORDER BY created_at DESC');
  const bots = db.prepare("SELECT * FROM api_tokens WHERE kind = 'bot' AND bot_project_id = ? ORDER BY created_at DESC");
  const touch = db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?');
  return {
    async save(t) {
      upsert.run(
        t.id,
        t.teamId,
        t.kind,
        t.userId,
        t.bot?.projectId ?? null,
        t.bot?.name ?? null,
        t.name,
        JSON.stringify(t.scopes),
        t.prefix,
        t.tokenHash,
        t.createdBy,
        t.createdAt,
        t.expiresAt,
        t.lastUsedAt,
        t.revokedAt
      );
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
    async listBotsByProject(projectId) {
      return (bots.all(projectId) as Row[]).map(toToken);
    },
    async touch(id, at) {
      touch.run(at, id);
    }
  };
}
