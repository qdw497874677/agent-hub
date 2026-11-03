import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupArgs, runBackup } from './backup.ts';

test('backup：VACUUM INTO 出一份过了 integrity_check 的快照，并只清理自己命名的旧备份', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-backup-'));
  const data = join(root, 'data');
  const dir = join(root, 'backups');
  mkdirSync(data);
  const db = new DatabaseSync(join(data, 'hub.db'));
  db.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1)");
  db.close();
  mkdirSync(dir);
  writeFileSync(join(dir, 'hub-20200101-000000.db'), '');
  writeFileSync(join(dir, 'manual.db'), '');
  const result = runBackup({ dataDir: data, dir, keep: 1, commit: 'abcdef1234567', now: new Date(2026, 10, 2, 1, 2, 3) });
  assert.equal(result.code, 0, JSON.stringify(result.report));
  assert.equal(result.report.integrity, 'ok');
  assert.deepEqual(readdirSync(dir).sort(), ['hub-20261102-010203-pre-abcdef1.db', 'manual.db']);
  const copy = new DatabaseSync(join(dir, 'hub-20261102-010203-pre-abcdef1.db'));
  assert.equal(copy.prepare('SELECT x FROM t').get()?.x, 1);
  copy.close();
});

test('backup 参数', () => {
  assert.deepEqual(backupArgs(['--keep', '3', '--dir', '/x']), { keep: 3, dir: '/x' });
});
