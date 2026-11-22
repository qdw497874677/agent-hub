import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asProjectId, asSessionId, type ProjectSessionGrant } from '@agent-hub/domain';
import { createSqliteProjectSessionGrants } from './project-session-grant.ts';

const grant = (over: Partial<ProjectSessionGrant> = {}): ProjectSessionGrant => ({
  id: 'g1',
  accountId: 'u1',
  sessionId: asSessionId('s1'),
  projectId: asProjectId('p1'),
  scopes: ['task:write', 'worktree:open'],
  createdBy: 'u1',
  createdAt: 100,
  expiresAt: null,
  revokedAt: null,
  revokedBy: null,
  ...over
});

test('项目授权：同账号/会话/项目一条；重授权替换 scope 与有效期并保留 id、创建时间', async () => {
  const store = createSqliteProjectSessionGrants(new DatabaseSync(':memory:'));
  assert.equal(await store.byKey('u1', asSessionId('s1'), asProjectId('p1')), null);

  const first = await store.save(grant());
  assert.deepEqual(first.scopes, ['task:write', 'worktree:open']);
  assert.equal((await store.byKey('u1', asSessionId('s1'), asProjectId('p1')))?.id, 'g1');

  const replaced = await store.save(grant({ id: 'g2', scopes: ['project:read'], expiresAt: 900, createdAt: 200 }));
  assert.equal(replaced.id, 'g1', '重复授权不换身份');
  assert.equal(replaced.createdAt, 100);
  assert.deepEqual(replaced.scopes, ['project:read']);
  assert.equal(replaced.expiresAt, 900);
  assert.equal((await store.listBySession(asSessionId('s1'))).length, 1);

  // 不同账号 / 项目是不同记录
  await store.save(grant({ id: 'g3', accountId: 'u2' }));
  await store.save(grant({ id: 'g4', projectId: asProjectId('p2') }));
  assert.equal((await store.listBySession(asSessionId('s1'))).length, 3);
  assert.equal((await store.listByAccount('u1')).length, 2);
});

test('项目授权：撤销单条 / 整个会话；重复撤销返回 false；重授权清除撤销状态', async () => {
  const store = createSqliteProjectSessionGrants(new DatabaseSync(':memory:'));
  await store.save(grant());

  assert.equal(await store.revoke('g1', 300, 'u1'), true);
  assert.equal(await store.revoke('g1', 301, 'u1'), false, '已撤销不再计数');
  const revoked = await store.byId('g1');
  assert.equal(revoked?.revokedAt, 300);
  assert.equal(revoked?.revokedBy, 'u1');

  await store.save(grant({ scopes: ['task:write'] }));
  assert.equal((await store.byId('g1'))?.revokedAt, null, '重新授权清除撤销');
  assert.equal((await store.revokeSession('u1', asSessionId('s1'), 400, 'u1')), 1);
  assert.equal((await store.revokeSession('u1', asSessionId('s1'), 401, 'u1')), 0);
  assert.equal((await store.byId('g1'))?.revokedAt, 400);
});

test('项目授权：重启（重开数据库文件）后记录与撤销状态都在；未知 scope 被丢弃', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-project-grant-'));
  const file = join(dir, 'hub.db');
  try {
    const first = createSqliteProjectSessionGrants(new DatabaseSync(file));
    await first.save(grant());
    await first.save(grant({ id: 'g2', projectId: asProjectId('p2'), scopes: ['message:send'] }));
    await first.revoke('g2', 500, 'u1');

    const reopened = createSqliteProjectSessionGrants(new DatabaseSync(file));
    const kept = await reopened.byKey('u1', asSessionId('s1'), asProjectId('p1'));
    assert.deepEqual(kept?.scopes, ['task:write', 'worktree:open']);
    const revoked = await reopened.byKey('u1', asSessionId('s1'), asProjectId('p2'));
    assert.equal(revoked?.revokedAt, 500);
    assert.equal(revoked?.revokedBy, 'u1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('项目授权：库里混入未知 scope 时读取按已知项过滤，不放大权限', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createSqliteProjectSessionGrants(db);
  await store.save(grant());
  db.prepare('UPDATE project_session_grants SET scopes = ? WHERE id = ?').run(
    JSON.stringify(['task:write', 'root:everything', 42]),
    'g1'
  );
  const row = await store.byId('g1');
  assert.deepEqual(row?.scopes, ['task:write']);

  db.prepare('UPDATE project_session_grants SET scopes = ? WHERE id = ?').run('not json', 'g1');
  assert.deepEqual((await store.byId('g1'))?.scopes, []);
});
