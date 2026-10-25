import type { DatabaseSync } from 'node:sqlite';
import type { LogAuthor, LogKind, LogLink, TaskId, WorkLogDraft, WorkLogEntry, WorkLogQuery, WorkLogRepository } from '@agent-hub/domain';
import { asSessionId, asTaskId } from '@agent-hub/domain';

type Row = Record<string, unknown>;

/**
 * 任务 v2 迁移（tasks-and-capabilities.md §2.4）：补列 + 老状态 `open` 回填。
 * 有过会话的 → in_progress，否则 → todo。幂等：跑完库里不再有 `open`。
 */
export function migrateTasksV2(db: DatabaseSync): void {
  const columns = new Set((db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name));
  if (!columns.has('owner_id')) db.exec('ALTER TABLE tasks ADD COLUMN owner_id TEXT');
  if (!columns.has('branch')) db.exec('ALTER TABLE tasks ADD COLUMN branch TEXT');
  if (!columns.has('summary')) db.exec('ALTER TABLE tasks ADD COLUMN summary TEXT');
  if (!columns.has('log_seq')) db.exec('ALTER TABLE tasks ADD COLUMN log_seq INTEGER NOT NULL DEFAULT 0');
  db.exec(
    "UPDATE tasks SET status = CASE WHEN EXISTS (SELECT 1 FROM sessions WHERE sessions.task_id = tasks.id) " +
      "THEN 'in_progress' ELSE 'todo' END WHERE status = 'open'"
  );
}

function parseJson<T>(raw: unknown, fallback: T): T {
  try {
    return typeof raw === 'string' ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function toEntry(row: Row): WorkLogEntry {
  const session = row.session_id as string | null;
  return {
    id: row.id as string,
    taskId: asTaskId(row.task_id as string),
    seq: row.seq as number,
    author: parseJson<LogAuthor>(row.author, { kind: 'system' }),
    kind: row.kind as LogKind,
    body: row.body as string,
    links: parseJson<LogLink[]>(row.links, []),
    attachments: parseJson<string[]>(row.attachments, []),
    sessionId: session ? asSessionId(session) : null,
    createdAt: row.created_at as number,
    supersedes: (row.supersedes as string | null) ?? null,
    supersededBy: (row.superseded_by as string | null) ?? null
  };
}

export function createWorkLogRepository(db: DatabaseSync): WorkLogRepository {
  // seq 在同一条 INSERT 里算出来：单写者 + 单语句，天然原子；UNIQUE(task_id, seq) 兜底。
  const insert = db.prepare(
    'INSERT INTO task_log_entries(id, task_id, seq, author, kind, body, links, attachments, session_id, created_at, supersedes) ' +
      'VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM task_log_entries WHERE task_id = ?), ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const markSuperseded = db.prepare('UPDATE task_log_entries SET superseded_by = ? WHERE id = ?');
  const byId = db.prepare('SELECT * FROM task_log_entries WHERE id = ?');

  return {
    async append(draft: WorkLogDraft): Promise<WorkLogEntry> {
      db.exec('BEGIN IMMEDIATE');
      try {
        insert.run(
          draft.id,
          draft.taskId,
          draft.taskId,
          JSON.stringify(draft.author),
          draft.kind,
          draft.body,
          JSON.stringify(draft.links),
          JSON.stringify(draft.attachments),
          draft.sessionId,
          draft.createdAt,
          draft.supersedes
        );
        if (draft.supersedes) markSuperseded.run(draft.id, draft.supersedes);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return toEntry(byId.get(draft.id) as Row);
    },
    async byId(id: string): Promise<WorkLogEntry | null> {
      const row = byId.get(id) as Row | undefined;
      return row ? toEntry(row) : null;
    },
    async list(taskId: TaskId, query: WorkLogQuery): Promise<WorkLogEntry[]> {
      const where = ['task_id = ?'];
      const params: (string | number)[] = [taskId];
      if (!query.includeSuperseded) where.push('superseded_by IS NULL');
      if (query.beforeSeq !== undefined) {
        where.push('seq < ?');
        params.push(query.beforeSeq);
      }
      if (query.kinds && query.kinds.length > 0) {
        where.push(`kind IN (${query.kinds.map(() => '?').join(', ')})`);
        params.push(...query.kinds);
      }
      params.push(Math.max(1, Math.min(query.limit, 200)));
      const rows = db.prepare(`SELECT * FROM task_log_entries WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`).all(...params);
      return (rows as Row[]).map(toEntry);
    },
    async latestHandoff(taskId: TaskId): Promise<WorkLogEntry | null> {
      return (await this.list(taskId, { limit: 1, kinds: ['handoff'] }))[0] ?? null;
    }
  };
}
