import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteAccess } from './access.ts';

test('和 #119 共表：老的审核人表被补列，审核人行还在、能读到；显式授权 upsert / 到期 / 撤销', async () => {
  const db = new DatabaseSync(':memory:');
  // #119 上线时的表结构 + 一位审核人
  db.exec(`CREATE TABLE access_grants (subject_id TEXT NOT NULL, permission TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (subject_id, permission, resource_type, resource_id));
    INSERT INTO access_grants VALUES ('u3', 'asset.review', 'team', 't1', 5);`);
  const { grants, roles } = createSqliteAccess(db);
  createSqliteAccess(db); // 幂等
  const cols = (db.prepare('PRAGMA table_info(access_grants)').all() as { name: string }[]).map((c) => c.name);
  for (const c of ['id', 'team_id', 'reason', 'created_by', 'expires_at', 'revoked_at']) assert.ok(cols.includes(c), c);

  const reviewer = await grants.activeFor('u3', 10);
  assert.equal(reviewer.length, 1);
  assert.equal(reviewer[0]!.permission, 'asset.review');
  assert.equal(reviewer[0]!.id, 'review:u3:team:t1');
  assert.ok((await grants.listByTeam('t1')).some((g) => g.userId === 'u3'));

  const base = { id: 'g1', teamId: 't1', userId: 'u1', permission: 'session.prompt', resourceKind: 'session', resourceId: 's1', reason: 'r', createdBy: 'd', createdAt: 1, expiresAt: 100, revokedAt: null } as const;
  await grants.save(base);
  assert.equal((await grants.activeFor('u1', 50)).length, 1);
  assert.equal((await grants.activeFor('u1', 100)).length, 0, '到期');
  await grants.save({ ...base, expiresAt: null, revokedAt: 60 });
  assert.equal((await grants.byId('g1'))?.revokedAt, 60);
  assert.equal((await grants.activeFor('u1', 70)).length, 0, '撤销');
  // 同主体 × 权限 × 资源再授一次：覆盖那一行（不会撞主键）
  await grants.save({ ...base, id: 'g2', expiresAt: null });
  assert.equal((await grants.activeFor('u1', 70))[0]?.id, 'g2');
  assert.equal(await grants.byId('g1'), null);
  // 审核人行不受影响
  assert.equal((await grants.activeFor('u3', 70)).length, 1);

  await roles.save({ id: 'r1', teamId: 't1', name: '审阅员', permissions: { 'project.read': 'team' }, createdBy: 'd', createdAt: 1, updatedAt: 1 });
  assert.deepEqual((await roles.listByTeam('t1')).map((r) => r.name), ['审阅员']);
  await roles.delete('r1');
  assert.equal(await roles.byId('r1'), null);
});

test('老库 users.role 带 CHECK (owner/member)：重建去掉约束，数据和登录态都在，能存 admin / viewer / custom', async () => {
  const { migrateUserRoles, createAccountRepositories } = await import('./accounts.ts');
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys = ON;
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','member')), password_hash TEXT, email_verified_at INTEGER, disabled_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE logins (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, method TEXT NOT NULL, user_agent TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
INSERT INTO users VALUES ('david', 'd@b.co', 'David', 'owner', 'h', 1, NULL, 1);
INSERT INTO logins VALUES ('l1', 'david', 'th', 'password', NULL, 1, 1, 9999999999999);`);
  assert.throws(() => db.exec("INSERT INTO users VALUES ('x', 'x@b.co', 'X', 'viewer', NULL, 1, NULL, 1)"));
  const repos = createAccountRepositories(db);
  assert.equal(migrateUserRoles(db), false, '幂等');
  const david = await repos.users.byId('david' as never);
  assert.equal(david?.role, 'owner');
  assert.equal(david?.clusterAdmin, true, '迁移：最早的 owner 成为集群管理员');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM logins').get() as { n: number }).n, 1, '登录态没被级联删');
  for (const role of ['admin', 'viewer', 'custom:r1'] as const) await repos.users.save({ ...david!, id: `u-${role}` as never, email: `${role}@b.co`, role, clusterAdmin: false });
  assert.equal((await repos.users.byId('u-viewer' as never))?.role, 'viewer');
  assert.equal((db.prepare('PRAGMA foreign_key_check').all()).length, 0);
});
