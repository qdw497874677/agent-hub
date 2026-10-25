import type { DatabaseSync } from 'node:sqlite';
import type { Login, LoginRepository, Role, User, UserRepository } from '@agent-hub/domain';
import { asLoginId, asUserId } from '@agent-hub/domain';

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
`;

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  password_hash: string | null;
  email_verified_at: number | null;
  disabled_at: number | null;
  created_at: number;
}

interface LoginRow {
  id: string;
  user_id: string;
  token_hash: string;
  method: string;
  user_agent: string | null;
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
  createdAt: row.created_at
});

const toLogin = (row: LoginRow): Login => ({
  id: asLoginId(row.id),
  userId: asUserId(row.user_id),
  tokenHash: row.token_hash,
  method: row.method as Login['method'],
  userAgent: row.user_agent,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  expiresAt: row.expires_at
});

export function createAccountRepositories(db: DatabaseSync): { users: UserRepository; logins: LoginRepository } {
  db.exec(ACCOUNT_SCHEMA);

  const upsertUser = db.prepare(
    'INSERT INTO users(id, email, display_name, role, password_hash, email_verified_at, disabled_at, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, ' +
      'display_name = excluded.display_name, role = excluded.role, password_hash = excluded.password_hash, ' +
      'email_verified_at = excluded.email_verified_at, disabled_at = excluded.disabled_at'
  );
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const userByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const firstWithRole = db.prepare(
    'SELECT * FROM users WHERE role = ? AND disabled_at IS NULL ORDER BY created_at ASC LIMIT 1'
  );
  const allUsers = db.prepare('SELECT * FROM users ORDER BY created_at ASC');

  const insertLogin = db.prepare(
    'INSERT INTO logins(id, user_id, token_hash, method, user_agent, created_at, last_seen_at, expires_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const loginByHash = db.prepare('SELECT * FROM logins WHERE token_hash = ?');
  const touchLogin = db.prepare('UPDATE logins SET last_seen_at = ?, expires_at = ? WHERE id = ?');
  const deleteLogin = db.prepare('DELETE FROM logins WHERE id = ?');
  const deleteLoginsOf = db.prepare('DELETE FROM logins WHERE user_id = ?');
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
        user.createdAt
      );
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
    async removeForUser(userId) {
      deleteLoginsOf.run(userId);
    }
  };

  return { users, logins };
}
