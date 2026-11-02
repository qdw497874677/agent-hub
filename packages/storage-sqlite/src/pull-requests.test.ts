import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecretKey } from './secrets.ts';
import { createSqliteGitHostTokens, createSqlitePullRequests } from './pull-requests.ts';

test('任务 PR：保存 / 更新 / 按任务和工作空间查 / 待同步', () => {
  const db = new DatabaseSync(':memory:');
  const prs = createSqlitePullRequests(db);
  const link = { id: 'p1', taskId: 't1', workspaceId: 'w1', sessionId: 's1', provider: 'github' as const, via: 'gh' as const, repo: 'o/r', number: 3, url: 'https://github.com/o/r/pull/3', branch: 'feat/x', base: 'main', state: 'open' as const, headSha: 'abc', mergedAt: null, createdBy: 'u1', createdAt: 1, lastSyncedAt: 1 };
  return (async () => {
    await prs.save(link);
    assert.deepEqual(await prs.byTask('t1'), [link]);
    assert.equal((await prs.byWorkspace('w1')).length, 1);
    assert.equal((await prs.openSyncedBefore(10, 5)).length, 1);
    await prs.save({ ...link, state: 'merged', mergedAt: 9, lastSyncedAt: 20 });
    assert.equal((await prs.byTask('t1'))[0]?.state, 'merged');
    assert.equal((await prs.openSyncedBefore(100, 5)).length, 0);
  })();
});

test('团队 GitHub token：落库是密文，状态只给末 4 位', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-gh-'));
  try {
    const key = await loadSecretKey({ file: join(dir, 'k') });
    const path = join(dir, 'hub.db');
    const db = new DatabaseSync(path);
    const tokens = createSqliteGitHostTokens(db, key);
    assert.deepEqual(await tokens.status('team'), { configured: false, last4: null, updatedAt: null });
    await tokens.put('team', 'ghp_abcdefghijklmnopqrstWXYZ', 7);
    assert.deepEqual(await tokens.status('team'), { configured: true, last4: 'WXYZ', updatedAt: 7 });
    assert.equal(await tokens.reveal('team'), 'ghp_abcdefghijklmnopqrstWXYZ');
    assert.equal(await tokens.reveal('other'), null);
    db.close();
    assert.ok(!readFileSync(path).includes(Buffer.from('ghp_abcdefghijklmnopqrst')));
    const again = createSqliteGitHostTokens(new DatabaseSync(path), key);
    await again.remove('team');
    assert.equal((await again.status('team')).configured, false);
    assert.equal(await again.reveal('team'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
