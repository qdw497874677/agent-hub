import type { DatabaseSync } from 'node:sqlite';
import type { OperationReceiptStore, TaskCreationStore } from '@agent-hub/domain';
import { plainInline } from '@agent-hub/domain';
import { SCHEMA } from './schema.ts';
import { inTransaction } from './tx.ts';
import { migrateTasksV2 } from './work-log.ts';
import { WORKSPACE_SCHEMA, migrateWorkspaces, upgradeWorkspaceTable } from './workspaces.ts';
import { createSqliteTaskCreations } from './task-creations.ts';
import { createSqliteOperationReceipts } from './operation-receipts.ts';

/**
 * 启动期 schema / 数据迁移的组合根。
 *
 * 顺序是契约：列补丁必须在建表之后、依赖它们的迁移之前；
 * task-creations / operation-receipts 的 self-migration 会在这中间补表；
 * 工作空间迁移要在 workspace 表升级之后。挪动前先看调用方依赖。
 */

/** 已执行的一次性数据迁移。只记「跑过」，不记每次启动都会跑的幂等补丁。 */
export const SCHEMA_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`;

export const LEGACY_LOG_TEXT_MIGRATION = '2026-11-legacy-log-text';

export interface StartupMigrationResult {
  readonly taskCreations: TaskCreationStore;
  readonly operationReceipts: OperationReceiptStore;
}

export function runStartupMigrations(db: DatabaseSync): StartupMigrationResult {
  db.exec(SCHEMA);
  // 老库补列：`CREATE TABLE IF NOT EXISTS` 不会给已有表加字段。
  const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'options')) {
    db.exec("ALTER TABLE sessions ADD COLUMN options TEXT NOT NULL DEFAULT '{}'");
  }
  if (!columns.some((column) => column.name === 'option_spec')) {
    db.exec("ALTER TABLE sessions ADD COLUMN option_spec TEXT NOT NULL DEFAULT '[]'");
  }
  // 多机：会话绑在哪台 worker、项目目录在哪台机器上。老数据为 NULL = 「当初就在唯一那台上」。
  if (!columns.some((column) => column.name === 'worker_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN worker_id TEXT');
  }
  if (!columns.some((column) => column.name === 'environment_revision')) {
    db.exec('ALTER TABLE sessions ADD COLUMN environment_revision TEXT');
  }
  const projectColumns = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
  if (!projectColumns.some((column) => column.name === 'worker_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN worker_id TEXT');
  }
  if (!projectColumns.some((column) => column.name === 'directories')) {
    db.exec("ALTER TABLE projects ADD COLUMN directories TEXT NOT NULL DEFAULT '{}'");
  }
  if (!projectColumns.some((column) => column.name === 'repo_url')) {
    db.exec('ALTER TABLE projects ADD COLUMN repo_url TEXT');
    db.exec('ALTER TABLE projects ADD COLUMN repo_default_branch TEXT');
  }
  // 团队与归属（ADR 0011）：只加列。NULL 的老数据在账号迁移后归到 hub 管理员的团队、算他建的。
  if (!projectColumns.some((column) => column.name === 'team_id')) db.exec('ALTER TABLE projects ADD COLUMN team_id TEXT');
  if (!projectColumns.some((column) => column.name === 'created_by')) db.exec('ALTER TABLE projects ADD COLUMN created_by TEXT');
  if (!projectColumns.some((column) => column.name === 'members')) db.exec("ALTER TABLE projects ADD COLUMN members TEXT NOT NULL DEFAULT '[]'");
  if (!projectColumns.some((column) => column.name === 'deleted_at')) db.exec('ALTER TABLE projects ADD COLUMN deleted_at INTEGER');
  if (!projectColumns.some((column) => column.name === 'description')) {
    db.exec('ALTER TABLE projects ADD COLUMN description TEXT');
  }
  // 项目级 worktree 配置（docs/design/worktree.md §3）：JSON；NULL = 没配，按 shared 处理。
  if (!projectColumns.some((column) => column.name === 'worktree_config')) {
    db.exec('ALTER TABLE projects ADD COLUMN worktree_config TEXT');
  }
  if (!projectColumns.some((column) => column.name === 'preview_port')) {
    db.exec('ALTER TABLE projects ADD COLUMN preview_port INTEGER');
  }
  // 项目声明的检查命令（issue #216 P1）：JSON 字符串数组；NULL = 老数据 / 没配，读时统一成 []。
  if (!projectColumns.some((column) => column.name === 'checks')) {
    db.exec('ALTER TABLE projects ADD COLUMN checks TEXT');
  }
  // 项目仓库清单（docs/design/multi-repo.md §11.2）：JSON 数组；NULL = 老数据，读时从 repo_url 单仓库回填。
  if (!projectColumns.some((column) => column.name === 'repos')) {
    db.exec('ALTER TABLE projects ADD COLUMN repos TEXT');
  }
  // 项目默认资产组合：JSON 字符串数组；NULL = 老数据，读时统一成 []。
  if (!projectColumns.some((column) => column.name === 'asset_set_ids')) {
    db.exec('ALTER TABLE projects ADD COLUMN asset_set_ids TEXT');
  }
  // 项目默认 Agent（runtime + 模型 + 启动选项）：JSON；NULL = 没配。
  if (!projectColumns.some((column) => column.name === 'default_agent')) {
    db.exec('ALTER TABLE projects ADD COLUMN default_agent TEXT');
  }
  // 任务默认 Agent：JSON；NULL = 没配（沿用项目默认）。
  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
  if (!taskColumns.some((column) => column.name === 'default_agent')) {
    db.exec('ALTER TABLE tasks ADD COLUMN default_agent TEXT');
  }
  // 任务归档时间：只加列；NULL = 老数据 / 未归档。归档 / 恢复只走 setArchived 的 CAS。
  if (!taskColumns.some((column) => column.name === 'archived_at')) {
    db.exec('ALTER TABLE tasks ADD COLUMN archived_at INTEGER');
  }
  // 子模块策略：NULL / 'off' = 不拉（老数据）；'recursive' = 之后新建的 clone / worktree 递归初始化。
  if (!projectColumns.some((column) => column.name === 'submodules')) {
    db.exec('ALTER TABLE projects ADD COLUMN submodules TEXT');
  }
  if (!projectColumns.some((column) => column.name === 'primary_repo_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN primary_repo_id TEXT');
  }
  if (!columns.some((column) => column.name === 'workspace_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN workspace_id TEXT');
  }
  // #243：容器会话创建时落定的来源项目；只加列，老数据保持 NULL（不从工作空间反推）。
  if (!columns.some((column) => column.name === 'origin_project_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN origin_project_id TEXT');
  }
  // ADR 0017：会话创建者（说话 / 中断只给他）。老会话从审计里的 session.start / session.fork 回填。
  const addedCreatedBy = !columns.some((column) => column.name === 'created_by');
  if (addedCreatedBy) db.exec('ALTER TABLE sessions ADD COLUMN created_by TEXT');
  // 会话名（用户可改）。NULL = 没起名。
  if (!columns.some((column) => column.name === 'title')) db.exec('ALTER TABLE sessions ADD COLUMN title TEXT');
  // 收起时间（I1）：只表示移出活跃列表，不影响状态与进程。NULL = 仍在活跃列表里。
  if (!columns.some((column) => column.name === 'settled_at')) db.exec('ALTER TABLE sessions ADD COLUMN settled_at INTEGER');
  if (!columns.some((column) => column.name === 'pinned')) db.exec('ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  if (!columns.some((column) => column.name === 'group_id')) db.exec('ALTER TABLE sessions ADD COLUMN group_id TEXT');
  // 会话类型（I4 侧聊）：老库补列；NULL = 老会话，读回时按缺省（chat）处理。
  if (!columns.some((column) => column.name === 'kind')) db.exec('ALTER TABLE sessions ADD COLUMN kind TEXT');
  if (!columns.some((column) => column.name === 'parent_session_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT');
  }
  // #221 步骤 4：会话按 id 记开它的 bot（名字仍用于 @ 解析）。NULL = 老会话或人开的。
  if (!columns.some((column) => column.name === 'bot_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN bot_id TEXT');
  }
  // 会话级资产清单（#226 会话选择）：JSON 数组；NULL = 按项目生效集。
  if (!columns.some((column) => column.name === 'asset_ids')) {
    db.exec('ALTER TABLE sessions ADD COLUMN asset_ids TEXT');
  }
  // 会话显式选的资产组合：JSON 数组；NULL = 用项目默认组合。
  if (!columns.some((column) => column.name === 'asset_set_ids')) {
    db.exec('ALTER TABLE sessions ADD COLUMN asset_set_ids TEXT');
  }
  // 按会话关掉的 MCP 服务器：JSON 字符串数组；NULL = 老数据 / 全开，读时统一成 []。
  if (!columns.some((column) => column.name === 'mcp_disabled')) {
    db.exec('ALTER TABLE sessions ADD COLUMN mcp_disabled TEXT');
  }
  // #221 步骤 7：容器会话没有任务，task_id 要允许 NULL（老库只能重建表）。
  relaxSessionsTaskId(db);
  upgradeWorkspaceTable(db);
  db.exec(WORKSPACE_SCHEMA);
  // 准备命令状态（docs/design/worktree.md §4）：老库补列；v2 表也要补（upgradeWorkspaceTable 不会再加列）。
  const workspaceColumns = db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[];
  if (!workspaceColumns.some((column) => column.name === 'setup')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN setup TEXT');
  }
  // 组合工作空间归属（docs/design/multi-repo.md §11.2）：老库补列。
  if (!workspaceColumns.some((column) => column.name === 'group_id')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN group_id TEXT');
  }
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (!sessionColumns.some((column) => column.name === 'turn')) {
    db.exec('ALTER TABLE sessions ADD COLUMN turn INTEGER NOT NULL DEFAULT 0');
  }
  const journalColumns = db.prepare('PRAGMA table_info(journal)').all() as { name: string }[];
  if (!journalColumns.some((column) => column.name === 'turn')) {
    db.exec('ALTER TABLE journal ADD COLUMN turn INTEGER');
    // 回填：按会话内 prompt 的累计条数算出每条事件属于第几轮。只跑一次。
    db.exec(
      "UPDATE journal SET turn = (SELECT COUNT(*) FROM journal p WHERE p.session_id = journal.session_id AND p.seq <= journal.seq AND p.type = 'prompt')"
    );
  }
  // sessions.turn 的修复：新建库直接带 turn（初始 0），老库补列也是 0——两种情况下
  // 已有历史的会话都要从 journal 找回当前轮次，否则下一句提问会从 1 重新数。
  // 条件只在异常行上命中，修完就是空集，可以每次启动跑。
  db.exec(
    'UPDATE sessions SET turn = COALESCE((SELECT MAX(turn) FROM journal WHERE journal.session_id = sessions.id), 0) ' +
      'WHERE sessions.turn = 0 AND sessions.last_seq > 0'
  );
  migrateTasksV2(db);
  const taskCreations = createSqliteTaskCreations(db);
  const operationReceipts = createSqliteOperationReceipts(db);
  migrateWorkspaces(db);
  migrateLegacyLogText(db);
  const layoutColumns = db.prepare('PRAGMA table_info(layout)').all() as { name: string }[];
  if (!layoutColumns.some((column) => column.name === 'sizes')) {
    db.exec("ALTER TABLE layout ADD COLUMN sizes TEXT NOT NULL DEFAULT '{}'");
  }
  return { taskCreations, operationReceipts };
}

/**
 * 老数据清理（一次性，versioned）：
 * 早期系统日志在没有模型时写成「开了 x 会话（）」；早期进展行直接截了 markdown 首行，
 * 带着 `**` 之类的记号。
 *
 * 只在首次升级到带标记表的版本时执行；清理与标记同事务，失败一起回滚，
 * 下次启动重跑。之后用户写入的正文（哪怕字面含「会话（）」或 `**`）不会再被改写。
 */
export function migrateLegacyLogText(db: DatabaseSync, now: number = Date.now()): boolean {
  db.exec(SCHEMA_MIGRATIONS_TABLE);
  const marker = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  if (marker.get(LEGACY_LOG_TEXT_MIGRATION)) return false;
  return inTransaction(db, () => {
    // 另一个进程可能在这里拿到写锁前完成迁移；锁内再读，避免重复清理。
    if (marker.get(LEGACY_LOG_TEXT_MIGRATION)) return false;
    db.exec("UPDATE task_log_entries SET body = replace(body, '会话（）', '会话') WHERE body LIKE '%会话（）%'");
    const rows = db
      .prepare("SELECT id, summary FROM tasks WHERE summary LIKE '%**%' OR summary LIKE '%`%' OR summary LIKE '%](%' OR summary LIKE '%~~%' OR summary LIKE '%\\_\\_%' ESCAPE '\\'")
      .all() as { id: string; summary: string }[];
    const update = db.prepare('UPDATE tasks SET summary = ? WHERE id = ?');
    for (const row of rows) {
      const plain = plainInline(row.summary);
      if (plain !== row.summary) update.run(plain || null, row.id);
    }
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(LEGACY_LOG_TEXT_MIGRATION, now);
    return true;
  });
}

/**
 * #221 步骤 7：容器会话（群角色 / bot P2P）不属于任何任务，sessions.task_id 要允许 NULL。
 * 旧库那一列是 NOT NULL，SQLite 不能原地改列约束 —— 按「建新表 → 复制 → 换名 → 重建索引」重建。
 * 幂等：notnull 已经是 0 就直接返回。PRAGMA foreign_keys 只能在事务外改，所以临时关掉，
 * 否则 DROP TABLE sessions 会被 artifacts 等子表的外键挡住。
 */
function relaxSessionsTaskId(db: DatabaseSync): void {
  type Column = {
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly dflt_value: string | null;
    readonly pk: number;
  };
  const info = db.prepare('PRAGMA table_info(sessions)').all() as Column[];
  const taskId = info.find((column) => column.name === 'task_id');
  if (!taskId || taskId.notnull === 0) return;
  const names = info.map((column) => `"${column.name}"`).join(', ');
  // 除 task_id 去掉 NOT NULL 外，其它列按原样重建（类型 / 主键 / 默认值都不变）。
  const definitions = info.map((column) => {
    if (column.name === 'task_id') return 'task_id TEXT REFERENCES tasks(id)';
    const parts = [`"${column.name}" ${column.type}`];
    if (column.pk === 1) parts.push('PRIMARY KEY');
    if (column.notnull === 1) parts.push('NOT NULL');
    if (column.dflt_value !== null) parts.push(`DEFAULT ${column.dflt_value}`);
    return parts.join(' ');
  });
  const indexes = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions' AND sql IS NOT NULL")
    .all() as { sql: string }[];
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    inTransaction(db, () => {
      db.exec(`CREATE TABLE sessions_rebuild (${definitions.join(', ')})`);
      db.exec(`INSERT INTO sessions_rebuild (${names}) SELECT ${names} FROM sessions`);
      db.exec('DROP TABLE sessions');
      db.exec('ALTER TABLE sessions_rebuild RENAME TO sessions');
      for (const index of indexes) db.exec(index.sql);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
