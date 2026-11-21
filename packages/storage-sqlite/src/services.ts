import type { DatabaseSync } from 'node:sqlite';
import type {
  ProjectId,
  ServiceId,
  SessionId,
  SessionService,
  SessionServiceRepository,
  TaskId,
  WorkspaceId
} from '@agent-hub/domain';
import { SERVICE_LOG_MAX } from '@agent-hub/domain';
import { inTransaction } from './tx.ts';
import { upsertSql } from './upsert.ts';

interface ServiceRow {
  id: string;
  project_id: string;
  task_id: string | null;
  workspace_id: string | null;
  session_id: string | null;
  worker_id: string;
  root: string;
  command: string;
  port: number | null;
  env_keys: string;
  restart: string;
  state: string;
  pid: number | null;
  detail: string | null;
  log_tail: string;
  started_at: number | null;
  updated_at: number;
}

const COLUMNS = [
  'id',
  'project_id',
  'task_id',
  'workspace_id',
  'session_id',
  'worker_id',
  'root',
  'command',
  'port',
  'env_keys',
  'restart',
  'state',
  'pid',
  'detail',
  'log_tail',
  'started_at',
  'updated_at'
] as const;

/** `env_keys` 列（JSON 数组）→ 键名；坏数据当空数组，不让一条烂行拖垮服务列表。 */
function keysOf(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === 'string');
  } catch {
    return [];
  }
}

/** 老库 `env` 列（JSON 对象，值是字符串）→ 键名。只给一次性迁移用。 */
function legacyEnvKeys(raw: string | null): readonly string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed)
      .filter(([, value]) => typeof value === 'string')
      .map(([key]) => key)
      .sort();
  } catch {
    return [];
  }
}

/** 每批迁移的行数：不把整表 env JSON 一次读进内存。 */
const MIGRATION_BATCH = 200;

/**
 * #233：老库 `env` 列存着完整环境变量值。读侧确认没有运行时路径从 DB 取值后，
 * 这里把老行映射成 `env_keys`，再把明文从逻辑行里清掉。
 *
 * - 幂等：每批在同一事务里同时写 `env_keys` 和把 `env` 置 `'{}'`，重复打开库不会重复处理。
 * - 有界：每批最多 `MIGRATION_BATCH` 行。
 * - 能删列就删；旧 SQLite 不支持 `DROP COLUMN` 时保留空列（值已清空），不跑 VACUUM。
 *   注意：这只清逻辑行，旧备份 / WAL / 释放页里可能仍有历史明文，不在本次修复范围内。
 */
function migrateServiceEnv(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(session_services)').all() as { name: string }[];
  const hasEnv = columns.some((column) => column.name === 'env');
  const hasKeys = columns.some((column) => column.name === 'env_keys');
  if (!hasKeys) db.exec("ALTER TABLE session_services ADD COLUMN env_keys TEXT NOT NULL DEFAULT '[]'");
  if (!hasEnv) return;

  const pending = db.prepare(
    "SELECT id, env FROM session_services WHERE env IS NULL OR env <> '{}' LIMIT ?"
  );
  const update = db.prepare("UPDATE session_services SET env_keys = ?, env = '{}' WHERE id = ?");
  for (;;) {
    const rows = inTransaction(db, () => {
      const batch = pending.all(MIGRATION_BATCH) as { id: string; env: string | null }[];
      for (const row of batch) update.run(JSON.stringify(legacyEnvKeys(row.env)), row.id);
      return batch;
    });
    if (rows.length === 0) break;
  }
  try {
    inTransaction(db, () => db.exec('ALTER TABLE session_services DROP COLUMN env'));
  } catch {
    // 旧 SQLite 没有 DROP COLUMN：保留空列，读侧已不再使用。
  }
}

const toService = (row: ServiceRow): SessionService => ({
  id: row.id as ServiceId,
  projectId: row.project_id as ProjectId,
  taskId: row.task_id as TaskId | null,
  workspaceId: row.workspace_id as WorkspaceId | null,
  sessionId: row.session_id as SessionId | null,
  workerId: row.worker_id,
  root: row.root,
  command: row.command,
  port: row.port,
  envKeys: keysOf(row.env_keys),
  restart: row.restart as SessionService['restart'],
  state: row.state as SessionService['state'],
  pid: row.pid,
  detail: row.detail,
  logTail: row.log_tail,
  startedAt: row.started_at,
  updatedAt: row.updated_at
});

/**
 * 会话服务（docs/design/session-service.md §3）。环境变量只存键名（`env_keys` JSON 数组），
 * 值只走创建请求 → Worker；`log_tail` 只留 Worker 推来的尾巴。
 */
export function createSqliteSessionServices(db: DatabaseSync): SessionServiceRepository {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_services (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      workspace_id TEXT,
      session_id TEXT,
      worker_id TEXT NOT NULL,
      root TEXT NOT NULL,
      command TEXT NOT NULL,
      port INTEGER,
      env_keys TEXT NOT NULL DEFAULT '[]',
      restart TEXT NOT NULL,
      state TEXT NOT NULL,
      pid INTEGER,
      detail TEXT,
      log_tail TEXT NOT NULL DEFAULT '',
      started_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);
  // 老库没有 log_tail（表刚加过列）时补上，别让「升级后读一次就炸」。
  const columns = db.prepare('PRAGMA table_info(session_services)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'log_tail')) {
    db.exec("ALTER TABLE session_services ADD COLUMN log_tail TEXT NOT NULL DEFAULT ''");
  }
  migrateServiceEnv(db);
  db.exec('CREATE INDEX IF NOT EXISTS session_services_task ON session_services(task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS session_services_session ON session_services(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS session_services_worker ON session_services(worker_id)');

  const byId = db.prepare('SELECT * FROM session_services WHERE id = ?');
  const byTask = db.prepare('SELECT * FROM session_services WHERE task_id = ? ORDER BY updated_at DESC');
  const bySession = db.prepare('SELECT * FROM session_services WHERE session_id = ? ORDER BY updated_at DESC');
  const byWorker = db.prepare('SELECT * FROM session_services WHERE worker_id = ? ORDER BY updated_at DESC');
  const upsert = db.prepare(upsertSql('session_services', COLUMNS));
  /**
   * 状态 / 日志帧只按列更新：整行 upsert 会把 env_keys、command 一起写回去，两个 Worker 帧并发时
   * 互相覆盖别人刚写的列。`updated_at <= ?` 让晚到的旧帧写不进去。
   */
  const updateStateStmt = db.prepare(
    `UPDATE session_services
        SET state = ?, pid = ?, detail = ?, port = ?, started_at = ?, updated_at = ?
      WHERE id = ? AND updated_at <= ?`
  );
  /**
   * 日志帧只追加：`log_tail || ?` 在 SQL 里拿当前值再拼，只留最后 SERVICE_LOG_MAX 个字符。
   * 先读整段再覆盖会让并发帧（或创建失败时的旧快照 save）互相丢日志（#233）。
   */
  const appendLogStmt = db.prepare(
    `UPDATE session_services
        SET log_tail = substr(log_tail || ?, -${SERVICE_LOG_MAX}), updated_at = ?
      WHERE id = ?`
  );
  const remove = db.prepare('DELETE FROM session_services WHERE id = ?');

  const one = (row: unknown): SessionService | null => (row ? toService(row as ServiceRow) : null);
  const many = (rows: unknown[]): readonly SessionService[] => rows.map((row) => toService(row as ServiceRow));

  return {
    async byId(id) {
      return one(byId.get(id));
    },
    async listByTask(taskId) {
      return many(byTask.all(taskId));
    },
    async listBySession(sessionId) {
      return many(bySession.all(sessionId));
    },
    async listByWorker(workerId) {
      return many(byWorker.all(workerId));
    },
    async save(service) {
      upsert.run(
        service.id,
        service.projectId,
        service.taskId,
        service.workspaceId,
        service.sessionId,
        service.workerId,
        service.root,
        service.command,
        service.port,
        JSON.stringify(service.envKeys),
        service.restart,
        service.state,
        service.pid,
        service.detail,
        service.logTail,
        service.startedAt,
        service.updatedAt
      );
    },
    async updateState(service) {
      const result = updateStateStmt.run(
        service.state,
        service.pid,
        service.detail,
        service.port,
        service.startedAt,
        service.updatedAt,
        service.id,
        service.updatedAt
      );
      return Number(result.changes) > 0;
    },
    async appendLogTail(id, chunk, updatedAt) {
      appendLogStmt.run(chunk, updatedAt, id);
    },
    async remove(id) {
      remove.run(id);
    }
  };
}
