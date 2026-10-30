import type { DatabaseSync } from 'node:sqlite';
import type {
  AuditAction,
  AuditEntry,
  AuditLog,
  HubSettings,
  Login,
  LoginActivity,
  LoginRepository,
  OneTimePurpose,
  OneTimeToken,
  OneTimeTokenRepository,
  Role,
  SettingsRepository,
  Team,
  TeamRepository,
  User,
  UserRepository
} from '@agent-hub/domain';
import { DEFAULT_SETTINGS, asLoginId, asTeamId, asUserId } from '@agent-hub/domain';

/** 账号两张表。邮箱唯一；登录态只存令牌哈希（docs/design/accounts.md §13）。 */
export const ACCOUNT_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('owner','member')),
  password_hash     TEXT,
  email_verified_at INTEGER,
  disabled_at       INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS logins (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  method       TEXT NOT NULL,
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS logins_by_user ON logins(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT NOT NULL,
  detail      TEXT NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_by_time ON audit_log(at DESC);
`;

/** 一次性令牌（验证邮箱、重置密码）：只存哈希，用过记 used_at（§13）。 */
const ONE_TIME_SCHEMA = `
CREATE TABLE IF NOT EXISTS one_time_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify-email','reset-password')),
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS one_time_by_user ON one_time_tokens(user_id, purpose);
`;

const tableExists = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/**
 * 账号 P3 的迁移，幂等：
 * - logins 加 ip 列；
 * - 第一次建 one_time_tokens 表时（= 第一次跑上带邮箱验证的版本），把已有账号都标为已验证，
 *   免得升级后老用户被「去验证邮箱」挡在门外。之后注册的人照常走验证。
 */
export function migrateAccountsP3(db: DatabaseSync): { markedVerified: number } {
  const loginColumns = new Set((db.prepare('PRAGMA table_info(logins)').all() as { name: string }[]).map((c) => c.name));
  if (!loginColumns.has('ip')) db.exec('ALTER TABLE logins ADD COLUMN ip TEXT');
  if (tableExists(db, 'one_time_tokens')) return { markedVerified: 0 };
  db.exec('BEGIN');
  try {
    db.exec(ONE_TIME_SCHEMA);
    const result = db.prepare('UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL').run();
    db.exec('COMMIT');
    return { markedVerified: Number(result.changes) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 团队（ADR 0011）的迁移，幂等、只加列不删列（老版本照样能读这个库）：
 * - 建 teams 表；users 加 team_id / hub_admin / deleted_at；
 * - 还没有 hub 管理员时，最早的未停用 Owner（没有就最早的账号）成为 hub 管理员；
 * - hub 管理员没有团队就给他建一个；所有还没团队的账号并进 hub 管理员的团队（= 老数据都归 David 的团队）。
 */
export function migrateTeams(db: DatabaseSync, now: number = Date.now()): { hubTeamId: string | null } {
  db.exec(`CREATE TABLE IF NOT EXISTS teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);`);
  const columns = new Set((db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name));
  if (!columns.has('team_id')) db.exec('ALTER TABLE users ADD COLUMN team_id TEXT');
  if (!columns.has('hub_admin')) db.exec('ALTER TABLE users ADD COLUMN hub_admin INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('deleted_at')) db.exec('ALTER TABLE users ADD COLUMN deleted_at INTEGER');
  db.exec('BEGIN IMMEDIATE');
  try {
    type AdminRow = { id: string; team_id: string | null; display_name: string };
    let admin = db.prepare('SELECT id, team_id, display_name FROM users WHERE hub_admin = 1 ORDER BY created_at ASC LIMIT 1').get() as
      | AdminRow
      | undefined;
    if (!admin) {
      admin = (db
        .prepare("SELECT id, team_id, display_name FROM users WHERE role = 'owner' AND disabled_at IS NULL ORDER BY created_at ASC LIMIT 1")
        .get() ?? db.prepare('SELECT id, team_id, display_name FROM users ORDER BY created_at ASC LIMIT 1').get()) as AdminRow | undefined;
      if (admin) db.prepare('UPDATE users SET hub_admin = 1 WHERE id = ?').run(admin.id);
    }
    let hubTeamId: string | null = admin?.team_id ?? null;
    if (admin && hubTeamId === null) {
      hubTeamId = `team-${admin.id}`;
      db.prepare('INSERT OR IGNORE INTO teams(id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').run(hubTeamId, `${admin.display_name} 的团队`, admin.id, now);
      db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(hubTeamId, admin.id);
    }
    if (hubTeamId !== null) db.prepare('UPDATE users SET team_id = ? WHERE team_id IS NULL').run(hubTeamId);
    db.exec('COMMIT');
    return { hubTeamId };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  password_hash: string | null;
  email_verified_at: number | null;
  disabled_at: number | null;
  created_at: number;
  team_id: string | null;
  hub_admin: number;
  deleted_at: number | null;
}

interface LoginRow {
  id: string;
  user_id: string;
  token_hash: string;
  method: string;
  user_agent: string | null;
  ip: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

const toUser = (row: UserRow): User => ({
  id: asUserId(row.id),
  email: row.email,
  displayName: row.display_name,
  role: row.role as Role,
  passwordHash: row.password_hash,
  emailVerifiedAt: row.email_verified_at,
  disabledAt: row.disabled_at,
  createdAt: row.created_at,
  teamId: row.team_id === null ? null : asTeamId(row.team_id),
  hubAdmin: row.hub_admin === 1,
  deletedAt: row.deleted_at ?? null
});

const toTeam = (row: { id: string; name: string; owner_id: string; created_at: number }): Team => ({
  id: asTeamId(row.id),
  name: row.name,
  ownerId: asUserId(row.owner_id),
  createdAt: row.created_at
});

const toLogin = (row: LoginRow): Login => ({
  id: asLoginId(row.id),
  userId: asUserId(row.user_id),
  tokenHash: row.token_hash,
  method: row.method as Login['method'],
  userAgent: row.user_agent,
  ip: row.ip ?? null,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  expiresAt: row.expires_at
});

export interface AccountRepositories {
  readonly users: UserRepository;
  readonly logins: LoginRepository;
  readonly settings: SettingsRepository;
  readonly audit: AuditLog;
  readonly oneTimeTokens: OneTimeTokenRepository;
  readonly teams: TeamRepository;
}

export function createAccountRepositories(db: DatabaseSync): AccountRepositories {
  db.exec(ACCOUNT_SCHEMA);
  migrateAccountsP3(db);
  migrateTeams(db);

  const upsertUser = db.prepare(
    'INSERT INTO users(id, email, display_name, role, password_hash, email_verified_at, disabled_at, created_at, team_id, hub_admin, deleted_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, ' +
      'display_name = excluded.display_name, role = excluded.role, password_hash = excluded.password_hash, ' +
      'email_verified_at = excluded.email_verified_at, disabled_at = excluded.disabled_at, team_id = excluded.team_id, ' +
      'hub_admin = excluded.hub_admin, deleted_at = excluded.deleted_at'
  );
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const userByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const firstWithRole = db.prepare(
    'SELECT * FROM users WHERE role = ? AND disabled_at IS NULL ORDER BY created_at ASC LIMIT 1'
  );
  const claimOwner = db.prepare(
    'INSERT INTO users(id, email, display_name, role, password_hash, email_verified_at, disabled_at, created_at, team_id, hub_admin) ' +
      "SELECT ?, ?, ?, 'owner', ?, ?, ?, ?, ?, 1 " +
      'WHERE NOT EXISTS (SELECT 1 FROM users WHERE hub_admin = 1 AND disabled_at IS NULL AND deleted_at IS NULL)'
  );
  const allUsers = db.prepare('SELECT * FROM users ORDER BY created_at ASC');
  const hubAdminRow = db.prepare('SELECT * FROM users WHERE hub_admin = 1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1');
  const insertTeam = db.prepare('INSERT INTO teams(id, name, owner_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, owner_id = excluded.owner_id');
  const teamById = db.prepare('SELECT * FROM teams WHERE id = ?');
  const allTeams = db.prepare('SELECT * FROM teams ORDER BY created_at ASC');

  const insertLogin = db.prepare(
    'INSERT INTO logins(id, user_id, token_hash, method, user_agent, ip, created_at, last_seen_at, expires_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const loginByHash = db.prepare('SELECT * FROM logins WHERE token_hash = ?');
  const touchLogin = db.prepare('UPDATE logins SET last_seen_at = ?, expires_at = ? WHERE id = ?');
  const deleteLogin = db.prepare('DELETE FROM logins WHERE id = ?');
  const deleteLoginsOf = db.prepare('DELETE FROM logins WHERE user_id = ?');
  const deleteLoginsOfExcept = db.prepare('DELETE FROM logins WHERE user_id = ? AND id <> ?');
  const loginsOfUser = db.prepare('SELECT * FROM logins WHERE user_id = ? ORDER BY last_seen_at DESC');
  const insertOneTime = db.prepare(
    'INSERT INTO one_time_tokens(token_hash, purpose, user_id, email, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  // 一条 UPDATE … RETURNING 完成「检查 + 用掉」：并发点同一个链接只有一个能改到这一行。
  const consumeOneTime = db.prepare(
    'UPDATE one_time_tokens SET used_at = ? WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? RETURNING *'
  );
  const revokeOneTime = db.prepare(
    'UPDATE one_time_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL'
  );
  const deleteStaleOneTime = db.prepare('DELETE FROM one_time_tokens WHERE expires_at < ?');
  const recentLogins = db.prepare('SELECT * FROM logins ORDER BY created_at DESC LIMIT ?');
  const loginActivity = db.prepare(
    'SELECT user_id, MAX(last_seen_at) AS last_seen_at, SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END) AS active ' +
      'FROM logins GROUP BY user_id'
  );
  const getSetting = db.prepare("SELECT value FROM settings WHERE key = 'hub'");
  const putSetting = db.prepare(
    "INSERT INTO settings(key, value) VALUES ('hub', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const insertAudit = db.prepare(
    'INSERT INTO audit_log(id, actor_id, actor_email, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const recentAudit = db.prepare('SELECT * FROM audit_log ORDER BY at DESC, rowid DESC LIMIT ?');
  const deleteExpired = db.prepare('DELETE FROM logins WHERE expires_at < ?');

  const users: UserRepository = {
    async save(user) {
      upsertUser.run(
        user.id,
        user.email,
        user.displayName,
        user.role,
        user.passwordHash,
        user.emailVerifiedAt,
        user.disabledAt,
        user.createdAt,
        user.teamId ?? null,
        user.hubAdmin ? 1 : 0,
        user.deletedAt ?? null
      );
    },
    async hubAdmin() {
      const row = hubAdminRow.get() as UserRow | undefined;
      return row ? toUser(row) : null;
    },
    async byId(id) {
      const row = userById.get(id) as UserRow | undefined;
      return row ? toUser(row) : null;
    },
    async byEmail(email) {
      const row = userByEmail.get(email) as UserRow | undefined;
      return row ? toUser(row) : null;
    },
    async firstWithRole(role) {
      const row = firstWithRole.get(role) as UserRow | undefined;
      return row ? toUser(row) : null;
    },
    async claimFirstOwner(user) {
      const result = claimOwner.run(
        user.id,
        user.email,
        user.displayName,
        user.passwordHash,
        user.emailVerifiedAt,
        user.disabledAt,
        user.createdAt,
        user.teamId ?? null
      );
      return Number(result.changes) === 1;
    },
    async list() {
      return (allUsers.all() as unknown as UserRow[]).map(toUser);
    }
  };

  const logins: LoginRepository = {
    async save(login) {
      // 顺手清掉过期的：表不会无限长，也不必另起定时任务。
      deleteExpired.run(login.createdAt);
      insertLogin.run(
        login.id,
        login.userId,
        login.tokenHash,
        login.method,
        login.userAgent,
        login.ip,
        login.createdAt,
        login.lastSeenAt,
        login.expiresAt
      );
    },
    async byTokenHash(hash) {
      const row = loginByHash.get(hash) as LoginRow | undefined;
      return row ? toLogin(row) : null;
    },
    async touch(id, lastSeenAt, expiresAt) {
      touchLogin.run(lastSeenAt, expiresAt, id);
    },
    async remove(id) {
      deleteLogin.run(id);
    },
    async removeForUser(userId, keep) {
      if (keep) deleteLoginsOfExcept.run(userId, keep);
      else deleteLoginsOf.run(userId);
    },
    async forUser(userId) {
      return (loginsOfUser.all(userId) as unknown as LoginRow[]).map(toLogin);
    },
    async recent(limit) {
      return (recentLogins.all(limit) as unknown as LoginRow[]).map(toLogin);
    },
    async activity(now) {
      const rows = loginActivity.all(now) as unknown as { user_id: string; last_seen_at: number; active: number }[];
      return rows.map(
        (row): LoginActivity => ({ userId: asUserId(row.user_id), lastSeenAt: row.last_seen_at, active: row.active })
      );
    }
  };

  const settings: SettingsRepository = {
    async get() {
      const row = getSetting.get() as { value: string } | undefined;
      // 合并默认值：以后加新开关，老库读出来也是完整的。
      return row ? { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<HubSettings>) } : DEFAULT_SETTINGS;
    },
    async save(next) {
      putSetting.run(JSON.stringify(next));
    }
  };

  const audit: AuditLog = {
    async append(entry) {
      insertAudit.run(entry.id, entry.actorId, entry.actorEmail, entry.action, entry.target, entry.detail, entry.at);
    },
    async recent(limit) {
      const rows = recentAudit.all(limit) as unknown as {
        id: string;
        actor_id: string;
        actor_email: string;
        action: string;
        target: string;
        detail: string;
        at: number;
      }[];
      return rows.map(
        (row): AuditEntry => ({
          id: row.id,
          actorId: asUserId(row.actor_id),
          actorEmail: row.actor_email,
          action: row.action as AuditAction,
          target: row.target,
          detail: row.detail,
          at: row.at
        })
      );
    }
  };

  const oneTimeTokens: OneTimeTokenRepository = {
    async save(token) {
      // 过期一天以上的顺手清掉
      deleteStaleOneTime.run(token.createdAt - 24 * 60 * 60 * 1000);
      insertOneTime.run(token.tokenHash, token.purpose, token.userId, token.email, token.createdAt, token.expiresAt, token.usedAt);
    },
    async consume(hash, purpose, now) {
      const row = consumeOneTime.get(now, hash, purpose, now) as
        | { token_hash: string; purpose: string; user_id: string; email: string; created_at: number; expires_at: number; used_at: number }
        | undefined;
      if (!row) return null;
      const token: OneTimeToken = {
        tokenHash: row.token_hash,
        purpose: row.purpose as OneTimePurpose,
        userId: asUserId(row.user_id),
        email: row.email,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedAt: row.used_at
      };
      return token;
    },
    async revokeForUser(userId, purpose, now) {
      revokeOneTime.run(now, userId, purpose);
    }
  };

  const teams: TeamRepository = {
    async save(team) {
      insertTeam.run(team.id, team.name, team.ownerId, team.createdAt);
    },
    async byId(id) {
      const row = teamById.get(id) as { id: string; name: string; owner_id: string; created_at: number } | undefined;
      return row ? toTeam(row) : null;
    },
    async list() {
      return (allTeams.all() as unknown as { id: string; name: string; owner_id: string; created_at: number }[]).map(toTeam);
    }
  };

  return { users, logins, settings, audit, oneTimeTokens, teams };
}
