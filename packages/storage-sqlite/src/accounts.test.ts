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
      emailVerifiedAt: null, disabledAt: null, createdAt: 1, teamId: null, hubAdmin: false, deletedAt: null
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
