import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteWorkspaceSweeps } from './workspace-sweeps.ts';

test('清理规则 upsert；清理记录按项目新的在前', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createSqliteWorkspaceSweeps(db);
  assert.equal(await store.policy('project', 'p1'), null);
  await store.savePolicy('project', 'p1', { prMerged: true, taskEndedClean: false, idleDays: null }, 1);
  await store.savePolicy('project', 'p1', { prMerged: false, taskEndedClean: false, idleDays: 7 }, 2);
  assert.deepEqual(await store.policy('project', 'p1'), { prMerged: false, taskEndedClean: false, idleDays: 7 });
  const item = { runId: 'r1', projectId: 'p1', workspaceId: 'w1', path: '/x/.worktrees/r/a', branch: 'b', action: 'removed' as const, reason: '任务已完成', sizeBytes: 2048, at: 10 };
  await store.saveRun({ id: 'r1', trigger: 'manual', startedAt: 10, removed: 1, kept: 1, failed: 0 }, [item, { ...item, workspaceId: 'w2', action: 'kept', reason: '有未提交的改动', sizeBytes: null, at: 11 }]);
  const rows = await store.itemsOfProject('p1', 10);
  assert.deepEqual(rows.map((r) => r.workspaceId), ['w2', 'w1']);
  assert.equal(rows[1]?.sizeBytes, 2048);
  assert.deepEqual(await store.itemsOfProject('p2', 10), []);
  createSqliteWorkspaceSweeps(db); // 再建一次不报错
});
