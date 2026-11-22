import type { DatabaseSync } from 'node:sqlite';
import type { ProjectId, Task, TaskCreationOutcome, TaskCreationStore, TaskId } from '@agent-hub/domain';
import { inTransaction } from './tx.ts';
import { toTaskWithParent } from './task-mappers.ts';

/**
 * 任务创建 + 请求回执的存储（docs/design/project-session-mcp.md）。
 *
 * 两个不变量：
 * 1. 回执与任务同事务：任务插失败（例如 id 重复）时回执一起回滚，重试仍会真正执行。
 * 2. 同键异参绝不覆盖：已存在回执且指纹不同直接返回 conflict，不写任何东西。
 */

/** 老库 self-migration：parent 列 + 回执表。幂等；可在 migrateTasksV2 之后调用。 */
export function migrateTaskCreationSchema(db: DatabaseSync): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tasks', 'request_receipts')")
    .all() as { name: string }[];
  if (tables.some((table) => table.name === 'tasks')) {
    const columns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'parent_task_id')) {
      db.exec('ALTER TABLE tasks ADD COLUMN parent_task_id TEXT');
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS request_receipts (
    key TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    source_session_id TEXT,
    project_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS request_receipts_by_project ON request_receipts(project_id, created_at)');
}

interface ReceiptRow {
  readonly fingerprint: string;
  readonly result: string;
}

interface TaskRow extends Record<string, unknown> {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly goal: string | null;
  readonly status: string;
  readonly owner_id: string | null;
  readonly branch: string | null;
  readonly base_branch: string | null;
  readonly parent_task_id: string | null;
  readonly summary: string | null;
  readonly default_agent: string | null;
  readonly log_seq: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export function createSqliteTaskCreations(db: DatabaseSync): TaskCreationStore {
  migrateTaskCreationSchema(db);

  const selectReceipt = db.prepare('SELECT fingerprint, result FROM request_receipts WHERE key = ?');
  const insertReceipt = db.prepare(
    'INSERT INTO request_receipts(key, actor_id, source_session_id, project_id, operation, fingerprint, result, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  // 纯 INSERT，不做 upsert：任务 id 冲突要抛错并连带回滚回执。
  const insertTask = db.prepare(
    'INSERT INTO tasks(id, project_id, title, goal, status, owner_id, branch, base_branch, parent_task_id, summary, default_agent, log_seq, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const selectChildren = db.prepare(
    'SELECT * FROM tasks WHERE project_id = ? AND parent_task_id = ? ORDER BY created_at, id'
  );

  return {
    async createWithReplay(intent): Promise<TaskCreationOutcome> {
      return inTransaction(db, (): TaskCreationOutcome => {
        const existing = selectReceipt.get(intent.key) as ReceiptRow | undefined;
        if (existing) {
          if (existing.fingerprint !== intent.fingerprint) return { status: 'conflict' };
          return { status: 'replayed', task: JSON.parse(existing.result) as Task };
        }
        const task = intent.task;
        insertTask.run(
          task.id,
          task.projectId,
          task.title,
          task.goal,
          task.status,
          task.ownerId,
          task.branch,
          task.baseBranch,
          task.parentTaskId ?? null,
          task.summary,
          task.defaultAgent ? JSON.stringify(task.defaultAgent) : null,
          task.logSeq,
          task.createdAt,
          task.updatedAt
        );
        insertReceipt.run(
          intent.key,
          intent.actorId,
          intent.sourceSessionId,
          intent.projectId,
          intent.operation,
          intent.fingerprint,
          JSON.stringify(task),
          task.createdAt
        );
        return { status: 'created', task };
      });
    },

    async listByParent(projectId: ProjectId, parentTaskId: TaskId): Promise<Task[]> {
      const rows = selectChildren.all(projectId, parentTaskId) as TaskRow[];
      return rows.map((row) => toTaskWithParent(row));
    }
  };
}
