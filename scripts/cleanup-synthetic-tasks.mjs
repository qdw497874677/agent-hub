#!/usr/bin/env node
/**
 * #221 步骤 7 的存量迁移：把群角色 / bot 常驻会话从「合成任务」里摘出来。
 *
 * 以前常驻会话必须挂在一条任务下，于是群与 bot 各有一条 goal 为空的假任务。
 * 现在 container 会话的 task_id 可以是 NULL —— 这个脚本把老库里那些会话的 task_id 置空，
 * 并报告因此变空的候选任务，**不自动删任务**（删之前让人看一眼）。
 *
 * 用法：
 *   node scripts/cleanup-synthetic-tasks.mjs --db /root/ahub-server/data/hub.db            # 只报告
 *   node scripts/cleanup-synthetic-tasks.mjs --db ... --write --backup-dir /root/backups  # 真写，先备份
 */

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dbPath = value('--db');
if (!dbPath) {
  console.error('要指定 --db <hub.db>（不会猜路径，避免误碰生产库）');
  process.exit(2);
}
const write = flag('--write');
const backupDir = value('--backup-dir');
if (write && !backupDir) {
  console.error('--write 必须同时给 --backup-dir（写之前先整库备份）');
  process.exit(2);
}
if (write) {
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const copy = join(backupDir, `${dbPath.split('/').pop()}-pre-cleanup-${stamp}.db`);
  copyFileSync(dbPath, copy);
  console.log(`[cleanup] 已备份 → ${copy}`);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');

// 老库的 sessions.task_id 还是 NOT NULL；新版本 hub 启动时会重建表放宽它。
// 这里不重复实现那次迁移，避免两处 DDL 漂移。
const taskIdColumn = db.prepare('PRAGMA table_info(sessions)').all().find((c) => c.name === 'task_id');
if (taskIdColumn && taskIdColumn.notnull === 1) {
  console.error('[cleanup] sessions.task_id 还是 NOT NULL：先用新版本 hub 启动一次（会自动迁移），再跑这个脚本。');
  process.exit(3);
}

const has = (table) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
const containerIds = new Set();
if (has('agent_group_sessions')) {
  for (const row of db.prepare('SELECT session_id FROM agent_group_sessions').all()) containerIds.add(row.session_id);
}
if (has('session_provenance')) {
  for (const row of db.prepare("SELECT session_id FROM session_provenance WHERE via IN ('group','bot','connector')").all()) containerIds.add(row.session_id);
}

const rows = [...containerIds]
  .map((id) => db.prepare('SELECT id, task_id, status FROM sessions WHERE id = ?').get(id))
  .filter((row) => row && row.task_id !== null && row.task_id !== '');
console.log(`[cleanup] 常驻会话 ${containerIds.size} 条，其中仍挂在任务下的 ${rows.length} 条`);

const touchedTasks = new Set(rows.map((row) => row.task_id));
for (const taskId of touchedTasks) {
  const task = db.prepare('SELECT id, title, goal FROM tasks WHERE id = ?').get(taskId);
  const siblings = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE task_id = ?').get(taskId).n;
  const freed = rows.filter((row) => row.task_id === taskId).length;
  console.log(`  task ${taskId}「${task?.title ?? '?'}」 goal=${JSON.stringify(task?.goal ?? null)}  会话 ${siblings}（摘出 ${freed}）`);
}

if (!write) {
  console.log('[cleanup] 只报告，没有写库。确认后加 --write --backup-dir <dir> 再跑。');
  process.exit(0);
}

db.exec('BEGIN IMMEDIATE');
try {
  const clear = db.prepare('UPDATE sessions SET task_id = NULL WHERE id = ?');
  for (const row of rows) clear.run(row.id);
  db.exec('COMMIT');
  console.log(`[cleanup] 已把 ${rows.length} 条常驻会话的 task_id 置空`);
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

// 变空的任务只报告，不删：里面可能还有 PR/资产/审计引用。
for (const taskId of touchedTasks) {
  const left = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE task_id = ?').get(taskId).n;
  if (left === 0) console.log(`[cleanup] 候选任务（已无会话，请人工确认是否删除）：${taskId}`);
}
db.close();
