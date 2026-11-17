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
  env: string;
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
  'env',
  'restart',
  'state',
  'pid',
  'detail',
  'log_tail',
  'started_at',
  'updated_at'
] as const;

function envOf(raw: string): Readonly<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') env[key] = value;
    }
    return env;
  } catch {
    return {};
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
  env: envOf(row.env),
  restart: row.restart as SessionService['restart'],
  state: row.state as SessionService['state'],
  pid: row.pid,
  detail: row.detail,
  logTail: row.log_tail,
  startedAt: row.started_at,
  updatedAt: row.updated_at
});

/** 会话服务（docs/design/session-service.md §3）。env 存 JSON；log_tail 只留 Worker 推来的尾巴。 */
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
      env TEXT NOT NULL DEFAULT '{}',
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
  db.exec('CREATE INDEX IF NOT EXISTS session_services_task ON session_services(task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS session_services_session ON session_services(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS session_services_worker ON session_services(worker_id)');

  const byId = db.prepare('SELECT * FROM session_services WHERE id = ?');
  const byTask = db.prepare('SELECT * FROM session_services WHERE task_id = ? ORDER BY updated_at DESC');
  const bySession = db.prepare('SELECT * FROM session_services WHERE session_id = ? ORDER BY updated_at DESC');
  const byWorker = db.prepare('SELECT * FROM session_services WHERE worker_id = ? ORDER BY updated_at DESC');
  const upsert = db.prepare(upsertSql('session_services', COLUMNS));
  /**
   * 状态 / 日志帧只按列更新：整行 upsert 会把 env、command 一起写回去，两个 Worker 帧并发时
   * 互相覆盖别人刚写的列。`updated_at <= ?` 让晚到的旧帧写不进去。
   */
  const updateStateStmt = db.prepare(
    `UPDATE session_services
        SET state = ?, pid = ?, detail = ?, port = ?, started_at = ?, updated_at = ?
      WHERE id = ? AND updated_at <= ?`
  );
  const appendLogStmt = db.prepare('UPDATE session_services SET log_tail = ?, updated_at = ? WHERE id = ?');
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
        JSON.stringify(service.env),
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
    async appendLogTail(id, logTail, updatedAt) {
      appendLogStmt.run(logTail, updatedAt, id);
    },
    async remove(id) {
      remove.run(id);
    }
  };
}
