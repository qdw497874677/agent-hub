#!/usr/bin/env node
/**
 * 一次性修复：把「模型留空」的 bot 会话上被钉住的模型清掉。
 *
 * 背景：以前 hub 会把 agent 启动时解析出的默认模型写进 session.model / options.model。
 * 机器上换了 opencode 配置或插件之后，这个旧值会继续覆盖运行时的真实默认
 * （典型症状：bot 没配模型，却被钉在一个额度已尽的免费模型上）。
 * 现在留空 = 每次启动由运行时决定；这个脚本把历史数据对齐到新语义。
 *
 * 用法：
 *   node scripts/repair-pinned-models.mjs --db /path/hub.db            # 只看
 *   node scripts/repair-pinned-models.mjs --db /path/hub.db --write --backup-dir /path/backups
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dbPath = value('--db');
const write = args.includes('--write');
const backupDir = value('--backup-dir');
if (!dbPath) {
  console.error('用法：node scripts/repair-pinned-models.mjs --db <hub.db> [--write --backup-dir <dir>]');
  process.exit(2);
}
if (write && !backupDir) {
  console.error('--write 必须带 --backup-dir：先备份再改正式库');
  process.exit(2);
}

const db = new DatabaseSync(resolve(dbPath));
// 两类都要修：bot 直接开的会话（按 bot_id）、群角色会话（按 agent_group_sessions 的成员关系）。
// 老会话可能没写 bot_id，所以不能只按 bot_id 关联。
const rows = db
  .prepare(
    `SELECT s.id, s.model, s.options, b.name AS bot, b.doc
       FROM sessions s LEFT JOIN bots b ON b.id = s.bot_id
      WHERE s.model <> ''
        AND (
          (b.doc IS NOT NULL AND s.bot_id IS NOT NULL)
          OR EXISTS (SELECT 1 FROM agent_group_sessions g WHERE g.session_id = s.id)
        )`
  )
  .all()
  // 只有「模型留空」的 bot 才该跟随运行时；群角色会话托管在某个 bot 上，按成员关系找它的 bot。
  .filter((row) => {
    try {
      if (row.doc !== null) return (JSON.parse(row.doc)?.ref?.model ?? '') === '';
      const member = db
        .prepare(
          `SELECT b.doc FROM agent_group_sessions g JOIN bots b ON b.name = g.role
            WHERE g.session_id = ? LIMIT 1`
        )
        .get(row.id);
      return member === undefined || (JSON.parse(member.doc)?.ref?.model ?? '') === '';
    } catch {
      return false;
    }
  });

if (rows.length === 0) {
  console.log('没有需要修复的会话');
  process.exit(0);
}
for (const row of rows) {
  console.log(`- ${row.id}  bot=${row.bot}  被钉在 ${row.model}`);
}
if (!write) {
  console.log(`\n共 ${rows.length} 条。加 --write --backup-dir <dir> 才会修改。`);
  process.exit(0);
}

mkdirSync(backupDir, { recursive: true });
const target = resolve(backupDir, `hub-before-pinned-models-${Date.now()}.db`);
copyFileSync(resolve(dbPath), target);
console.log(`已备份：${target}`);

const update = db.prepare('UPDATE sessions SET model = \'\', options = ? WHERE id = ?');
db.exec('BEGIN IMMEDIATE');
try {
  for (const row of rows) {
    let options = {};
    try {
      options = JSON.parse(row.options ?? '{}');
    } catch {
      options = {};
    }
    delete options.model;
    update.run(JSON.stringify(options), row.id);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
console.log(`已修复 ${rows.length} 条会话`);
