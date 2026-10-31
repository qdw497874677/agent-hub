import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

test('claimFirstOwner 原子：只有第一个能抢到，停用的 Owner 不算', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-accounts-'));
  try {
    const store = openSqliteStore(join(dir, 'hub.db'));
    const user = (id: string): User => ({
      id: id as User['id'], email: `${id}@b.co`, displayName: id, role: 'owner', passwordHash: 'x',
      emailVerifiedAt: null, disabledAt: null, createdAt: 1, teamId: null, clusterAdmin: false, deletedAt: null
    });
    assert.equal(await store.users.claimFirstOwner(user('a')), true);
    assert.equal(await store.users.claimFirstOwner(user('b')), false);
    assert.equal(await store.users.byId(user('b').id), null);
    await store.users.save({ ...user('a'), disabledAt: 2 });
    assert.equal(await store.users.claimFirstOwner(user('c')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('邀请：按令牌 hash 查、accept 只成功一次、过期/撤销的不算待处理', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-invites-'));
  try {
    const store = openSqliteStore(join(dir, 'hub.db'));
    const invite = (id: string, hash: string, extra: Record<string, unknown> = {}) => ({
      id, tokenHash: hash, teamId: 't1', email: `${id}@b.co`, role: 'member', invitedBy: 'u1',
      createdAt: 1, expiresAt: 100, acceptedAt: null, revokedAt: null, allowOverLimit: false, ...extra
    }) as any;
    await store.invites.save(invite('a', 'ha'));
    await store.invites.save(invite('b', 'hb', { revokedAt: 5 }));
    await store.invites.save(invite('c', 'hc', { expiresAt: 10 }));
    assert.equal((await store.invites.byTokenHash('ha'))?.email, 'a@b.co');
    assert.deepEqual((await store.invites.pending(50)).map((i) => i.id), ['a']);
    assert.ok(await store.invites.accept('ha', 60));
    assert.equal(await store.invites.accept('ha', 61), null);
    assert.equal(await store.invites.accept('hb', 61), null);
    assert.deepEqual(await store.invites.pending(50), []);
    assert.equal((await store.invites.forTeam('t1' as any)).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('审计：老库补 ip / team_id 列；按动作前缀、操作人、IP 前缀、时间、团队过滤', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'hub-audit-'));
  try {
    const path = join(dir, 'hub.db');
    // 老版本的 audit_log：没有 ip / team_id
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE audit_log (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_email TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL)");
    old.exec("INSERT INTO audit_log VALUES ('old', 'u', 'old@b.co', 'user.disable', 'x', '', 1)");
    old.close();
    const store = openSqliteStore(path);
    const entry = (id: string, extra: Record<string, unknown>) =>
      ({ id, actorId: 'u1', actorEmail: 'David@b.co', action: 'auth.login', target: 't', detail: '', at: 10, ip: null, teamId: null, ...extra }) as any;
    await store.audit.append(entry('a', { ip: '10.0.0.1', teamId: 't1', at: 10 }));
    await store.audit.append(entry('b', { action: 'auth.login_failed', ip: '192.168.1.2', teamId: 't1', at: 20 }));
    await store.audit.append(entry('c', { actorEmail: 'mia@b.co', action: 'invite.create', teamId: 't2', at: 30 }));
    const ids = async (filter: Record<string, unknown>) => (await store.audit.query({ limit: 50, ...filter })).map((e) => e.id);
    assert.deepEqual(await ids({}), ['c', 'b', 'a', 'old']);
    assert.deepEqual(await ids({ action: 'auth.' }), ['b', 'a']);
    assert.deepEqual(await ids({ actor: 'david' }), ['b', 'a']);
    assert.deepEqual(await ids({ ip: '10.0.' }), ['a']);
    assert.deepEqual(await ids({ since: 15, until: 25 }), ['b']);
    assert.deepEqual(await ids({ teamId: 't2' }), ['c']);
    assert.deepEqual(await ids({ action: '%' }), []);
    const [first] = await store.audit.query({ limit: 1, ip: '10.' });
    assert.equal(first?.ip, '10.0.0.1');
    assert.equal(first?.teamId, 't1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
