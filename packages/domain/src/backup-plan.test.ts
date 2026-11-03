import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_NAME, backupName, backupPlan } from './backup-plan.ts';

const MB = 1024 * 1024;

test('磁盘不够就不备：至少 512MB 或 2×(db+wal)', () => {
  assert.deepEqual(backupPlan({ dbBytes: 10 * MB, walBytes: 0, freeBytes: 500 * MB, existing: [] }), { ok: false, reason: 'disk', needBytes: 512 * MB, freeBytes: 500 * MB });
  const big = backupPlan({ dbBytes: 400 * MB, walBytes: 100 * MB, freeBytes: 900 * MB, existing: [] });
  assert.equal(big.ok, false);
  assert.equal(big.needBytes, 1000 * MB);
});

test('够了就备，连同新的一共留 keep 份，删最旧的', () => {
  const existing = Array.from({ length: 12 }, (_, i) => ({ name: `hub-2026110${i % 10}-00000${i % 10}.db`.replace(/^/, '') + '', mtimeMs: i }));
  const plan = backupPlan({ dbBytes: MB, walBytes: 0, freeBytes: 10_000 * MB, existing, keep: 10 });
  assert.equal(plan.ok, true);
  if (plan.ok) assert.deepEqual(plan.prune, existing.slice(0, 3).map((e) => e.name).reverse());
});

test('备份名可被识别，带上提交号', () => {
  const name = backupName(new Date(2026, 10, 2, 9, 5, 7), '0123456789abcdef');
  assert.equal(name, 'hub-20261102-090507-pre-0123456.db');
  assert.match(name, BACKUP_NAME);
  assert.doesNotMatch('hub.db', BACKUP_NAME);
  assert.equal(backupName(new Date(2026, 0, 1, 0, 0, 0)), 'hub-20260101-000000.db');
});
