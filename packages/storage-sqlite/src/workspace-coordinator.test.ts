import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteWorkspaceCoordinators } from './workspace-coordinator.ts';

const record = { projectId: 'p1', workspaceId: 'w1', sessionId: 's1', createdAt: 10 };

test('占位：同一工作空间只中一次，重复占位原样返回已登记的会话', async () => {
  const registry = createSqliteWorkspaceCoordinators(new DatabaseSync(':memory:'));
  assert.deepEqual(await registry.reserve(record), { status: 'reserved', record });
  assert.deepEqual(await registry.reserve({ ...record, sessionId: 's2', createdAt: 11 }), { status: 'exists', record });
  assert.equal((await registry.get('p1', 'w1'))?.sessionId, 's1');
});

test('占位：同一会话不能被登记到第二个工作空间', async () => {
  const registry = createSqliteWorkspaceCoordinators(new DatabaseSync(':memory:'));
  await registry.reserve(record);
  await assert.rejects(
    () => registry.reserve({ ...record, workspaceId: 'w2' }),
    /主会话登记冲突：会话 s1 已登记在项目 p1 的工作空间 w1/
  );
  assert.equal(await registry.get('p1', 'w2'), null);
});

test('列表按项目过滤并按创建时间排序；释放只删对得上的那一条', async () => {
  const registry = createSqliteWorkspaceCoordinators(new DatabaseSync(':memory:'));
  await registry.reserve({ ...record, createdAt: 12 });
  await registry.reserve({ ...record, workspaceId: 'w0', sessionId: 's0', createdAt: 5 });
  await registry.reserve({ ...record, projectId: 'p2', sessionId: 's9' });

  assert.deepEqual((await registry.list('p1')).map((row) => row.workspaceId), ['w0', 'w1']);
  assert.deepEqual((await registry.list('p2')).map((row) => row.sessionId), ['s9']);

  await registry.release({ ...record, sessionId: 's0' });
  assert.equal((await registry.get('p1', 'w1'))?.sessionId, 's1');
  await registry.release(record);
  assert.equal(await registry.get('p1', 'w1'), null);
  assert.deepEqual((await registry.list('p1')).map((row) => row.workspaceId), ['w0']);
});

test('落库后重开同一个库还能读回来（登记不是进程内存）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ahub-coordinator-'));
  const file = join(dir, 'hub.db');
  try {
    const first = new DatabaseSync(file);
    await createSqliteWorkspaceCoordinators(first).reserve(record);
    first.close();

    const second = new DatabaseSync(file);
    try {
      assert.equal((await createSqliteWorkspaceCoordinators(second).get('p1', 'w1'))?.sessionId, 's1');
    } finally {
      second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('损坏的登记直接报错，不当成「没有」', async () => {
  const db = new DatabaseSync(':memory:');
  const registry = createSqliteWorkspaceCoordinators(db);
  db.exec("INSERT INTO workspace_coordinator (project_id, workspace_id, session_id, created_at) VALUES ('p1', 'w1', '', 1)");
  await assert.rejects(() => registry.get('p1', 'w1'), /主会话登记损坏/);
  await assert.rejects(() => registry.list('p1'), /主会话登记损坏/);
});
