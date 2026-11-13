#!/usr/bin/env node
/**
 * C3b 一次性数据迁移：把「bot 还是项目配置里的一段 JSON」迁成「bots 表 + bot: 前缀」。
 *
 * 做四件事（每件都可重跑，全部在同一个事务里）：
 *   1. 建 `bots` 表（幂等）。
 *   2. `agent_messaging_config.roles` 的每一项 → `bots` 一行。id 用与域内 `botIdFrom` 完全相同的
 *      算法（seed = `projectId + '\0' + name`），所以重复跑、回滚重跑都得到同一个 id。
 *   3. `agent_messages.to_address` 里的 `role:<name>` → `bot:<name>`（只改前缀）。
 *   4. settings 里 `role:<projectId>:<botName>` → `bot:<projectId>:<botName>`（只处理 projectId 真实存在的键；
 *      团队级的 `role:<teamId>:<role>` 是**人的角色**，不碰）。
 *
 * 用法：
 *   node scripts/migrate-bots.mjs --data-dir /root/ahub-server/data --dry-run
 *   node scripts/migrate-bots.mjs --data-dir /root/ahub-server/data
 *   node scripts/migrate-bots.mjs --data-dir /root/ahub-server/data --revert
 *
 * 安全约定（与部署脚本一致：库不自动恢复，迁移必须能退）：
 *   - 默认要求 `<data-dir>/backups` 里 10 分钟内有快照，否则拒绝执行；`--no-backup-check` 可跳过（仅供本地测试）。
 *   - `--dry-run` 只打印将要做的改动，不写库。
 *   - `--revert` 反向执行 2/3/4（删 bots 行、bot: → role:、settings 键改回）；不删表。
 */
import { readdir, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BOT_ID_PREFIX = 'bot_';
const BACKUP_WINDOW_MS = 10 * 60 * 1000;

/** 与 `packages/domain/src/bot.ts` 的 `botIdFrom` 逐字一致（改一处必须同步另一处）。 */
export function botIdFrom(seed) {
  const digest = (offset) => {
    let hash = offset >>> 0;
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  return `${BOT_ID_PREFIX}${digest(0x811c9dc5)}${digest(0x9e3779b9)}`;
}

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at === -1 ? null : (args[at + 1] ?? null);
};

const dataDir = valueOf('--data-dir') ?? process.env.HUB_DATA_DIR ?? join(homedir(), '.local', 'share', 'agent-hub');
const dryRun = has('--dry-run');
const revert = has('--revert');
const skipBackupCheck = has('--no-backup-check');
const dbPath = join(dataDir, 'hub.db');

const log = (...parts) => console.log('[migrate-bots]', ...parts);

async function assertFreshBackup() {
  if (skipBackupCheck) {
    log('⚠ 跳过备份检查（--no-backup-check）');
    return;
  }
  const dir = join(dataDir, 'backups');
  let newest = 0;
  try {
    for (const name of await readdir(dir)) {
      if (!name.startsWith('hub-') || !name.endsWith('.db')) continue;
      const info = await stat(join(dir, name));
      newest = Math.max(newest, info.mtimeMs);
    }
  } catch {
    newest = 0;
  }
  if (Date.now() - newest > BACKUP_WINDOW_MS) {
    console.error(
      `[migrate-bots] 拒绝执行：${dir} 里没有 10 分钟内的快照。先跑 \`HUB_DATA_DIR=${dataDir} node apps/server/src/main.ts backup\`。`
    );
    process.exit(1);
  }
  log('备份检查通过：最新快照', new Date(newest).toISOString());
}

/** 旧 roles JSON：容忍脏数据（坏一项不影响其它项）。 */
function parseRoles(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item) => item && typeof item === 'object' && typeof item.name === 'string' && item.name !== '');
}

/** 与 `packages/storage-sqlite/src/messages.ts` 的 `toRole` 一致：ref 缺失时回落扁平字段。 */
function normalizeRole(role) {
  const nested = role.ref && typeof role.ref === 'object' && !Array.isArray(role.ref) ? role.ref : null;
  const options = (source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
    const out = {};
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string' || typeof value === 'boolean') out[key] = value;
    }
    return out;
  };
  return {
    ref: {
      runtime: String(nested?.runtime ?? role.agentId ?? ''),
      model: String(nested?.model ?? role.model ?? ''),
      options: options(nested?.options ?? role.options)
    },
    ...(role.displayName ? { displayName: String(role.displayName) } : {}),
    ...(role.color ? { color: String(role.color) } : {}),
    description: typeof role.description === 'string' ? role.description : '',
    reuse: role.reuse === 'per-trace' || role.reuse === 'always-new' ? role.reuse : 'sticky'
  };
}

function ensureBotsTable(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  doc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS bots_project ON bots(project_id);
`);
}

function migrateBots(db, report) {
  ensureBotsTable(db);
  const rows = db.prepare('SELECT project_id, roles, updated_at FROM agent_messaging_config').all();
  const insert = db.prepare(
    `INSERT INTO bots (id, project_id, name, doc, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`
  );
  for (const row of rows) {
    const projectId = String(row.project_id);
    const at = Number(row.updated_at ?? Date.now());
    for (const role of parseRoles(row.roles)) {
      const name = String(role.name).trim();
      if (name === '') continue;
      const id = botIdFrom(`${projectId}\0${name}`);
      const doc = JSON.stringify(normalizeRole(role));
      insert.run(id, projectId, name, doc, at, at);
      report.bots += 1;
    }
  }
}

function migrateAddresses(db, report, direction = 'forward') {
  const from = direction === 'forward' ? 'role:' : 'bot:';
  const to = direction === 'forward' ? 'bot:' : 'role:';
  const rows = db.prepare('SELECT rowid, to_address FROM agent_messages WHERE to_address LIKE ?').all(`${from}%`);
  const update = db.prepare('UPDATE agent_messages SET to_address = ? WHERE rowid = ?');
  for (const row of rows) {
    update.run(`${to}${String(row.to_address).slice(from.length)}`, row.rowid);
    report.addresses += 1;
  }
}

function projectIds(db) {
  return new Set(db.prepare('SELECT id FROM projects').all().map((row) => String(row.id)));
}

function migrateSettingsKeys(db, report, direction) {
  const from = direction === 'forward' ? 'role:' : 'bot:';
  const to = direction === 'forward' ? 'bot:' : 'role:';
  const ids = projectIds(db);
  const rows = db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all(`${from}%`);
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const row of rows) {
    const key = String(row.key);
    const rest = key.slice(from.length);
    const at = rest.indexOf(':');
    if (at <= 0) continue;
    const projectId = rest.slice(0, at);
    // 只搬项目级的 bot 键；团队级 role:<teamId>:<role> 是人的角色，跳过。
    if (!ids.has(projectId)) continue;
    const next = `${to}${rest}`;
    put.run(next, String(row.value));
    del.run(key);
    report.settings += 1;
  }
}

function revertBots(db, report) {
  // roles JSON 是迁移前的真相，原样还在；这里只删迁移写入的 bot 行，不动 agent_messaging_config。
  const rows = db.prepare('SELECT id FROM bots').all();
  const del = db.prepare('DELETE FROM bots WHERE id = ?');
  for (const row of rows) {
    del.run(String(row.id));
    report.bots += 1;
  }
}

/** 迁移 id 必须和域内算法一致；用固定向量自检，防止两边改动后悄悄分叉。 */
const SELF_CHECK_VECTORS = [
  ['prj_1\0reviewer', 'bot_6ae4eb1ee01cdbf2'],
  ['prj_abc\0fixer', 'bot_2c5e1f00d3c7b7e4'],
  ['中文项目\0bot-1', 'bot_e9ef2df9ed83727d']
];

function selfCheck() {
  const wrong = SELF_CHECK_VECTORS.filter(([seed, expected]) => botIdFrom(seed) !== expected);
  if (wrong.length === 0) {
    log('自检通过：botIdFrom 与域内实现一致');
    return true;
  }
  for (const [seed, expected] of wrong) {
    console.error(`[migrate-bots] 自检失败：${JSON.stringify(seed)} 期望 ${expected}，实际 ${botIdFrom(seed)}`);
  }
  return false;
}

async function main() {
  if (!selfCheck()) process.exit(1);
  log(`库：${dbPath}${dryRun ? '（dry-run）' : ''}${revert ? '（revert）' : ''}`);
  await assertFreshBackup();

  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch (error) {
    console.error(`[migrate-bots] 打不开 ${dbPath}：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const report = { bots: 0, addresses: 0, settings: 0 };
  try {
    db.exec('BEGIN');
    if (revert) {
      revertBots(db, report);
      migrateAddresses(db, report, 'backward');
      migrateSettingsKeys(db, report, 'backward');
    } else {
      migrateBots(db, report);
      migrateAddresses(db, report);
      migrateSettingsKeys(db, report, 'forward');
    }
    if (dryRun) db.exec('ROLLBACK');
    else db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 事务可能已结束 */
    }
    console.error('[migrate-bots] 失败，已回滚：', error);
    process.exit(1);
  } finally {
    db.close();
  }

  log(
    `${dryRun ? '将要' : '已'}迁移：bot ${report.bots} 条、消息地址 ${report.addresses} 条、设置键 ${report.settings} 个`
  );
  if (dryRun) log('dry-run 未写入；去掉 --dry-run 再跑一次。');
}

const invokedDirectly = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (invokedDirectly) await main();
