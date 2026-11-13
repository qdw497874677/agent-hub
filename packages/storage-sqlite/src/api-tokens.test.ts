import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { asProjectId } from '@agent-hub/domain';
import type { ApiToken } from '@agent-hub/domain';
import { createSqliteApiTokens } from './api-tokens.ts';

/** 老库（C1 之前）的表：kind CHECK 只允许 personal / service，没有 bot 两列。 */
const LEGACY_SCHEMA = `
CREATE TABLE api_tokens (
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
CREATE INDEX api_tokens_by_team ON api_tokens(team_id);
`;

const tokenOf = (patch: Partial<ApiToken> & Pick<ApiToken, 'id'>): ApiToken => ({
  teamId: 'team-1',
  kind: 'bot',
  userId: 'owner',
  bot: { projectId: 'p1', name: 'reviewer' },
  name: 'reviewer',
  scopes: ['projects:read', 'sessions:write'],
  prefix: 'ahb_secret',
  tokenHash: `hash-${patch.id}`,
  createdBy: 'owner',
  createdAt: 1,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  ...patch
});

test('老库（无 bot 列、CHECK 不含 bot）打开后能读能写 bot 令牌', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(LEGACY_SCHEMA);
  db.exec(`INSERT INTO api_tokens (id, team_id, kind, user_id, name, scopes, prefix, token_hash, created_by, created_at)
    VALUES ('old', 'team-1', 'personal', 'owner', '旧令牌', '["projects:read"]', 'ahp_old', 'hash-old', 'owner', 1)`);

  const repo = createSqliteApiTokens(db);
  const old = await repo.byId('old');
  assert.equal(old?.name, '旧令牌');
  assert.equal(old?.bot, undefined);

  await repo.save(tokenOf({ id: 'bot-1' }));
  const bot = await repo.byId('bot-1');
  assert.deepEqual(bot?.bot, { projectId: 'p1', name: 'reviewer' });
  assert.equal(bot?.kind, 'bot');
  assert.deepEqual(
    (await repo.listBotsByProject(asProjectId('p1'))).map((row) => row.id),
    ['bot-1']
  );
  assert.deepEqual(await repo.listBotsByProject(asProjectId('p2')), []);
  // 老行仍能通过 team 查回来
  assert.deepEqual(
    (await repo.listByTeam('team-1')).map((row) => row.id).sort(),
    ['bot-1', 'old']
  );
});

test('表已允许 bot 但缺两列时用 ALTER TABLE 补齐', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE api_tokens (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('personal','service','bot')),
      user_id TEXT NOT NULL, name TEXT NOT NULL, scopes TEXT NOT NULL, prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER, last_used_at INTEGER, revoked_at INTEGER
    );
  `);
  const repo = createSqliteApiTokens(db);
  await repo.save(tokenOf({ id: 'bot-2', bot: { projectId: 'p1', name: 'helper' } }));
  assert.deepEqual((await repo.byId('bot-2'))?.bot, { projectId: 'p1', name: 'helper' });
});
