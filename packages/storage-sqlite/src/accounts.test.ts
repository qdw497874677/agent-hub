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
