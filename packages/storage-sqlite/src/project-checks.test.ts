import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { asProjectId } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

test('检查命令（issue #216 P1）：老库缺列能迁移；写入 / 读回一致；空数组读回 []', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-checks-'));
  const file = join(dir, 'hub.db');
  // 模拟 W1 之前的老库：projects 只有最少的列，没有 checks。
  const raw = new DatabaseSync(file);
  raw.exec(
    'CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, created_at INTEGER NOT NULL)'
  );
  raw.exec("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'old', '', 1)");
  raw.close();

  const store = openSqliteStore(file);
  try {
    const migrated = await store.projects.byId(asProjectId('p1'));
    assert.ok(migrated);
    assert.deepEqual(migrated.checks, []);

    await store.projects.save({ ...migrated, checks: ['npm run typecheck', 'npm test'] });
    const written = await store.projects.byId(asProjectId('p1'));
    assert.deepEqual(written?.checks, ['npm run typecheck', 'npm test']);
    assert.deepEqual((await store.projects.list())[0]?.checks, ['npm run typecheck', 'npm test']);

    assert.ok(written);
    await store.projects.save({ ...written, checks: [] });
    assert.deepEqual((await store.projects.byId(asProjectId('p1')))?.checks, []);
  } finally {
    store.close();
  }

  // 手改过的库：坏 JSON / 非数组 / 非字符串 / 空串 / 超 5 条，读回都要稳定成合法形状。
  const raw2 = new DatabaseSync(file);
  raw2.exec("UPDATE projects SET checks = 'not json' WHERE id = 'p1'");
  raw2.close();
  let reopened = openSqliteStore(file);
  assert.deepEqual((await reopened.projects.byId(asProjectId('p1')))?.checks, []);
  reopened.close();

  const raw3 = new DatabaseSync(file);
  raw3.exec(`UPDATE projects SET checks = '${JSON.stringify([' a ', 7, '', 'b', 'c', 'd', 'e', 'f', 'g'])}' WHERE id = 'p1'`);
  raw3.close();
  reopened = openSqliteStore(file);
  assert.deepEqual((await reopened.projects.byId(asProjectId('p1')))?.checks, ['a', 'b', 'c', 'd', 'e']);
  reopened.close();

  rmSync(dir, { recursive: true, force: true });
});
