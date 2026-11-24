import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore } from './store.ts';
import { LEGACY_LOG_TEXT_MIGRATION, migrateLegacyLogText } from './migrations.ts';

/** 升级前的库：没有 schema_migrations，task_log_entries / tasks 是旧形状。 */
function seedLegacy(file: string): void {
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, summary TEXT);
    CREATE TABLE task_log_entries (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, seq INTEGER NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, links TEXT NOT NULL DEFAULT '[]', attachments TEXT NOT NULL DEFAULT '[]', session_id TEXT, created_at INTEGER NOT NULL, supersedes TEXT, superseded_by TEXT);
    INSERT INTO projects VALUES ('p', 'demo', '/tmp', 1);
    INSERT INTO tasks VALUES ('t', 'p', 't', NULL, 'todo', 1, 1, '**接好了** \`mcp\`');
    INSERT INTO task_log_entries(id, task_id, seq, author, kind, body, created_at) VALUES ('e', 't', 1, '{"kind":"system"}', 'note', '开了 grok 会话（）', 1);`);
  old.close();
}

function fixture(name: string): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), name));
  return { file: join(dir, 'hub.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('升级合成老库：清理旧文案并落一个版本标记', () => {
  const { file, cleanup } = fixture('hub-migrate-legacy-');
  try {
    seedLegacy(file);
    const store = openSqliteStore(file);
    const body = (store.db.prepare("SELECT body FROM task_log_entries WHERE id = 'e'").get() as { body: string }).body;
    const summary = (store.db.prepare("SELECT summary FROM tasks WHERE id = 't'").get() as { summary: string }).summary;
    const markers = store.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?').get(LEGACY_LOG_TEXT_MIGRATION) as { n: number };
    assert.equal(body, '开了 grok 会话');
    assert.equal(summary, '接好了 mcp');
    assert.equal(markers.n, 1);
    // 已经应用过：同一个库上再跑是空操作。
    assert.equal(migrateLegacyLogText(store.db), false);
    assert.equal(
      (store.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n,
      1
    );
    store.close();
  } finally {
    cleanup();
  }
});

test('重开不再改写标记之后写入的值', () => {
  const { file, cleanup } = fixture('hub-migrate-once-');
  try {
    const first = openSqliteStore(file);
    first.db.exec(`INSERT INTO projects(id, name, root_path, created_at) VALUES ('p', 'demo', '/tmp', 1);
      INSERT INTO tasks(id, project_id, title, status, created_at, updated_at, summary) VALUES ('t', 'p', 't', 'todo', 1, 1, '**后来的**');
      INSERT INTO task_log_entries(id, task_id, seq, author, kind, body, created_at) VALUES ('e', 't', 1, '{"kind":"system"}', 'note', '后来的 会话（）', 1);`);
    first.close();
    const second = openSqliteStore(file);
    const body = (second.db.prepare("SELECT body FROM task_log_entries WHERE id = 'e'").get() as { body: string }).body;
    const summary = (second.db.prepare("SELECT summary FROM tasks WHERE id = 't'").get() as { summary: string }).summary;
    assert.equal(body, '后来的 会话（）');
    assert.equal(summary, '**后来的**');
    second.close();
  } finally {
    cleanup();
  }
});

test('清理与标记同事务：标记写入失败时正文回滚', () => {
  const { file, cleanup } = fixture('hub-migrate-rollback-');
  try {
    seedLegacy(file);
    const seed = new DatabaseSync(file);
    // 让标记插入必然失败，验证清理没有单独提交。
    seed.exec(`CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY CHECK (version <> '${LEGACY_LOG_TEXT_MIGRATION}'),
      applied_at INTEGER NOT NULL)`);
    seed.close();
    assert.throws(() => openSqliteStore(file), /CHECK constraint failed/);

    const check = new DatabaseSync(file);
    const body = (check.prepare("SELECT body FROM task_log_entries WHERE id = 'e'").get() as { body: string }).body;
    const markers = check.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    const summary = (check.prepare("SELECT summary FROM tasks WHERE id = 't'").get() as { summary: string }).summary;
    check.close();
    assert.equal(body, '开了 grok 会话（）');
    assert.equal(summary, '**接好了** `mcp`');
    assert.equal(markers.n, 0);
  } finally {
    cleanup();
  }
});
