import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { asTaskId, createProject, createTask, draftLogEntry } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

const now = 1_700_000_000_000;

test('老库迁移：补 v2 列；open 按有无会话回填成 in_progress / todo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-v2-'));
  const file = join(dir, 'hub.db');
  try {
    // 造一个 v1 形状的库
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO projects VALUES ('p', 'demo', '/tmp', 1);
      INSERT INTO tasks VALUES ('busy', 'p', '有会话', NULL, 'open', 1, 1);
      INSERT INTO tasks VALUES ('idle', 'p', '没会话', NULL, 'open', 1, 1);
      INSERT INTO tasks VALUES ('gone', 'p', '放弃了', NULL, 'abandoned', 1, 1);`);
    old.close();
    const first = openSqliteStore(file);
    first.db.exec(
      "INSERT INTO sessions(id, task_id, agent_id, model, origin_kind, status, last_seq, created_at, updated_at) VALUES ('s', 'busy', 'a', 'm', 'derive', 'stopped', 0, 1, 1)"
    );
    first.close();
    // 会话是迁移后才插进来的：把 busy 改回 open 模拟「迁移前就有会话」，再开一次
    const again = new DatabaseSync(file);
    again.exec("UPDATE tasks SET status = 'open' WHERE id = 'busy'");
    again.close();
    const store = openSqliteStore(file);
    const status = (id: string) => (store.db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }).status;
    assert.equal(status('busy'), 'in_progress');
    assert.equal(status('idle'), 'todo');
    assert.equal(status('gone'), 'abandoned');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('工作日志往返：seq 原子分配、修订链、分页与排除系统条目', async () => {
  const store = openSqliteStore(':memory:');
  const project = createProject({ name: 'demo', rootPath: '/tmp/demo', directoryExists: true, now });
  assert.ok(project.ok);
  await store.projects.save(project.value);
  const task = createTask({ projectId: project.value.id, title: 't', now });
  assert.ok(task.ok);
  await store.tasks.save({ ...task.value, summary: 's', logSeq: 3, branch: 'agent-hub/t' });
  const back = await store.tasks.byId(task.value.id);
  assert.equal(back?.summary, 's');
  assert.equal(back?.logSeq, 3);
  assert.equal(back?.branch, 'agent-hub/t');

  const draft = (id: string, system: boolean, body: string, supersedes: string | null = null) => {
    const d = draftLogEntry({
      id,
      taskId: asTaskId(task.value.id),
      author: system ? { kind: 'system' } : { kind: 'agent', sessionId: 's1', agentId: 'grok', model: 'm' },
      body,
      links: [{ kind: 'commit', ref: 'abc123' }],
      supersedes,
      now
    });
    assert.ok(d.ok);
    return d.value;
  };
  const one = await Promise.all([store.workLog.append(draft('a', false, '一')), store.workLog.append(draft('b', false, '二'))]);
  assert.deepEqual(one.map((e) => e.seq).sort(), [1, 2]);
  const c = await store.workLog.append(draft('c', false, '三', 'a'));
  assert.equal(c.seq, 3);
  assert.equal((await store.workLog.byId('a'))?.supersededBy, 'c');
  assert.deepEqual(c.author, { kind: 'agent', sessionId: 's1', agentId: 'grok', model: 'm' });
  assert.deepEqual(c.links, [{ kind: 'commit', ref: 'abc123' }]);

  assert.deepEqual((await store.workLog.list(task.value.id, { limit: 10 })).map((e) => e.id), ['c', 'b']);
  assert.deepEqual((await store.workLog.list(task.value.id, { limit: 10, includeSuperseded: true })).map((e) => e.id), ['c', 'b', 'a']);
  assert.deepEqual((await store.workLog.list(task.value.id, { limit: 1, beforeSeq: 3 })).map((e) => e.id), ['b']);
  assert.equal((await store.workLog.latestNote(task.value.id))?.id, 'c');
  await store.workLog.append(draft('d', true, '会话结束'));
  assert.equal((await store.workLog.latestNote(task.value.id))?.id, 'c');
  assert.deepEqual((await store.workLog.list(task.value.id, { limit: 10, excludeSystem: true })).map((e) => e.id), ['c', 'b']);
  // 任务保存不会让 logSeq 倒退（并发追加时以大者为准）
  await store.tasks.save({ ...task.value, logSeq: 1 });
  assert.equal((await store.tasks.byId(task.value.id))?.logSeq, 3);
  store.close();
});

test('老数据清理：系统条目里的空「（）」和进展行里的 markdown 记号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-clean-'));
  const file = join(dir, 'hub.db');
  try {
    const first = openSqliteStore(file);
    first.db.exec(`INSERT INTO projects(id, name, root_path, created_at) VALUES ('p', 'demo', '/tmp', 1);
      INSERT INTO tasks(id, project_id, title, status, created_at, updated_at, summary) VALUES ('t', 'p', 't', 'todo', 1, 1, '**接好了** \`mcp\`');
      INSERT INTO task_log_entries(id, task_id, seq, author, kind, body, created_at) VALUES ('e', 't', 1, '{"kind":"system"}', 'note', '开了 grok 会话（）', 1);`);
    first.close();
    const store = openSqliteStore(file);
    const body = (store.db.prepare("SELECT body FROM task_log_entries WHERE id = 'e'").get() as { body: string }).body;
    const summary = (store.db.prepare("SELECT summary FROM tasks WHERE id = 't'").get() as { summary: string }).summary;
    assert.equal(body, '开了 grok 会话');
    assert.equal(summary, '接好了 mcp');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
