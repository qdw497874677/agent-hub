import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { asProjectId, asSessionId, asTaskId, createTask, type Task } from '@agent-hub/domain';
import { openSqliteStore, type SqliteStore } from './store.ts';
import { createSqliteTaskCreations, migrateTaskCreationSchema } from './task-creations.ts';
import { toTaskWithParent } from './task-mappers.ts';

const now = 1_700_000_000_000;

function tempWorld(oldTasksTable = false): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-task-creations-'));
  const file = join(dir, 'hub.db');
  if (oldTasksTable) {
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT, status TEXT NOT NULL,
        owner_id TEXT, branch TEXT, base_branch TEXT, summary TEXT, log_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO projects VALUES ('p1', 'old', '/tmp', 1);
      INSERT INTO tasks VALUES ('old-task', 'p1', '旧任务', NULL, 'todo', NULL, NULL, NULL, NULL, 0, 1, 1);`);
    raw.close();
  }
  return { dir, file };
}

function seedProject(store: SqliteStore): void {
  store.db.exec("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'demo', '/tmp', 1)");
}

function makeTask(over: Partial<Pick<Task, 'id' | 'title' | 'parentTaskId'>> = {}, id?: string): Task {
  const task = createTask({
    projectId: asProjectId('p1'),
    title: over.title ?? '任务',
    now,
    id: id ? asTaskId(id) : undefined
  });
  assert.ok(task.ok);
  return { ...task.value, ...(over.parentTaskId !== undefined ? { parentTaskId: over.parentTaskId } : {}) };
}

const intent = (task: Task, key = 'k1', fingerprint = 'f1') => ({
  key,
  fingerprint,
  actorId: 'u1',
  sourceSessionId: asSessionId('s1'),
  projectId: asProjectId('p1'),
  operation: 'task.create',
  task
});

test('创建 + 同键回放：重开后仍回放原任务，不会重复插入', async () => {
  const { dir, file } = tempWorld();
  try {
    const first = openSqliteStore(file);
    seedProject(first);
    const parent = makeTask({ title: '父任务' });
    const child = makeTask({ title: '子任务', parentTaskId: parent.id });
    const creations = createSqliteTaskCreations(first.db);
    assert.equal((await creations.createWithReplay(intent(parent, 'k-parent', 'fp-parent'))).status, 'created');
    const created = await creations.createWithReplay(intent(child, 'k-child', 'fp-child'));
    assert.equal(created.status, 'created');
    first.close();

    const second = openSqliteStore(file);
    try {
      const creations2 = createSqliteTaskCreations(second.db);
      const replayed = await creations2.createWithReplay(intent(child, 'k-child', 'fp-child'));
      assert.equal(replayed.status, 'replayed');
      assert.equal(replayed.status === 'replayed' ? replayed.task.id : null, child.id);
      // 回放没有执行第二次插入。
      const count = second.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
      assert.equal(count.n, 2);
      // 子任务读回父关系；父任务保持无父级。
      const children = await creations2.listByParent(asProjectId('p1'), parent.id);
      assert.deepEqual(children.map((task) => task.id), [child.id]);
      assert.equal(children[0]!.parentTaskId, parent.id);
      const raw = second.db.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get(parent.id) as { parent_task_id: string | null };
      assert.equal(raw.parent_task_id, null);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同键异参：conflict，不覆盖回执、不插任务', async () => {
  const { dir, file } = tempWorld();
  try {
    const store = openSqliteStore(file);
    seedProject(store);
    const creations = createSqliteTaskCreations(store.db);
    const task = makeTask({ title: '原任务' });
    assert.equal((await creations.createWithReplay(intent(task, 'k1', 'f1'))).status, 'created');

    const other = makeTask({ title: '换了参数' });
    const outcome = await creations.createWithReplay(intent(other, 'k1', 'f2'));
    assert.equal(outcome.status, 'conflict');
    const count = store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    assert.equal(count.n, 1);
    const receipt = store.db.prepare('SELECT fingerprint, result FROM request_receipts WHERE key = ?').get(
      intent(task, 'k1', 'f1').key
    ) as { fingerprint: string; result: string };
    assert.equal(receipt.fingerprint, 'f1');
    assert.equal(JSON.parse(receipt.result).title, '原任务');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('任务插入失败时回执一起回滚：同键重试仍会真正执行', async () => {
  const { dir, file } = tempWorld();
  try {
    const store = openSqliteStore(file);
    seedProject(store);
    const creations = createSqliteTaskCreations(store.db);
    const task = makeTask({ title: '占位' }, 'dup-id');
    assert.equal((await creations.createWithReplay(intent(task, 'k1', 'f1'))).status, 'created');

    // 第二个键、同一个任务 id：INSERT 撞主键，事务必须把 k2 的回执一起回滚。
    await assert.rejects(creations.createWithReplay(intent(task, 'k2', 'f2')));
    const receipts = store.db.prepare('SELECT COUNT(*) AS n FROM request_receipts').get() as { n: number };
    assert.equal(receipts.n, 1);
    const tasks = store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    assert.equal(tasks.n, 1);

    // 换一个合法 id 用 k2 重试：没有残留回执挡住创建。
    const fresh = makeTask({ title: '重试' }, 'fresh-id');
    assert.equal((await creations.createWithReplay(intent(fresh, 'k2', 'f2'))).status, 'created');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧库兼容：补 parent 列幂等；旧任务读为无父任务', async () => {
  const { dir, file } = tempWorld(true);
  try {
    const store = openSqliteStore(file);
    migrateTaskCreationSchema(store.db);
    migrateTaskCreationSchema(store.db); // 幂等
    const columns = store.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    assert.ok(columns.some((column) => column.name === 'parent_task_id'));

    const row = store.db.prepare('SELECT * FROM tasks WHERE id = ?').get('old-task') as Record<string, unknown>;
    const mapped = toTaskWithParent(row);
    assert.equal(mapped.title, '旧任务');
    assert.equal(mapped.parentTaskId, null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('子任务 mapper 输出 parentTaskId，可被任务列表直接序列化', () => {
  const row = {
    id: 'child',
    project_id: 'p1',
    title: '子任务',
    goal: null,
    status: 'todo',
    owner_id: null,
    branch: null,
    base_branch: null,
    parent_task_id: 'parent',
    summary: null,
    default_agent: null,
    log_seq: 0,
    created_at: now,
    updated_at: now
  };
  const mapped = toTaskWithParent(row);
  assert.equal(mapped.parentTaskId, 'parent');
  assert.equal(JSON.parse(JSON.stringify(mapped)).parentTaskId, 'parent');
});
