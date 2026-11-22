import type { DatabaseSync } from 'node:sqlite';
import type { CoordinatorRecord, CoordinatorReservation, WorkspaceCoordinatorRegistry } from '@agent-hub/domain';

/**
 * 项目主会话登记（docs/design/workspace-delegation.md §A2）：和 hub 共用同一个 SQLite 库。
 * 主键 `(project_id, workspace_id)` 就是「一条工作空间只能有一条主会话」的原子约束；
 * `session_id` 唯一，防止同一个会话被登记到别的项目/工作空间。
 *
 * 这里只存身份，不存状态：会话本身是否还对得上由调用方复核。
 * 读到的行不做「静默丢弃」——列类型不对（NULL / 空串）直接抛，避免把损坏的登记当成没有。
 */
export function createSqliteWorkspaceCoordinators(db: DatabaseSync): WorkspaceCoordinatorRegistry {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_coordinator (
    project_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, workspace_id),
    UNIQUE (session_id)
  )`);

  type Row = { project_id: string; workspace_id: string; session_id: string; created_at: number };

  const parse = (row: Row | undefined): CoordinatorRecord | null => {
    if (!row) return null;
    if (
      typeof row.project_id !== 'string' || row.project_id === '' ||
      typeof row.workspace_id !== 'string' || row.workspace_id === '' ||
      typeof row.session_id !== 'string' || row.session_id === '' ||
      !Number.isFinite(row.created_at)
    ) {
      throw new Error(`主会话登记损坏：${JSON.stringify(row)}`);
    }
    return {
      projectId: row.project_id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      createdAt: row.created_at
    };
  };

  const byPair = db.prepare('SELECT * FROM workspace_coordinator WHERE project_id = ? AND workspace_id = ?');
  const bySession = db.prepare('SELECT * FROM workspace_coordinator WHERE session_id = ?');
  const byProject = db.prepare('SELECT * FROM workspace_coordinator WHERE project_id = ? ORDER BY created_at, workspace_id');
  const insert = db.prepare(
    'INSERT OR IGNORE INTO workspace_coordinator (project_id, workspace_id, session_id, created_at) VALUES (?, ?, ?, ?)'
  );
  const remove = db.prepare('DELETE FROM workspace_coordinator WHERE project_id = ? AND workspace_id = ? AND session_id = ?');

  const get = (projectId: string, workspaceId: string): CoordinatorRecord | null =>
    parse(byPair.get(projectId, workspaceId) as Row | undefined);

  return {
    async get(projectId, workspaceId) {
      return get(projectId, workspaceId);
    },
    async list(projectId) {
      return (byProject.all(projectId) as Row[]).map((row) => {
        const record = parse(row);
        if (!record) throw new Error(`主会话登记损坏：${JSON.stringify(row)}`);
        return record;
      });
    },
    async reserve(record) {
      // 同键/同会话的并发写只有一个能命中主键；INSERT OR IGNORE 之后一律以库里的事实为准。
      const result = insert.run(record.projectId, record.workspaceId, record.sessionId, record.createdAt);
      if (Number(result.changes) > 0) return { status: 'reserved', record } satisfies CoordinatorReservation;
      const stored = get(record.projectId, record.workspaceId);
      if (stored) return { status: 'exists', record: stored } satisfies CoordinatorReservation;
      const owner = parse(bySession.get(record.sessionId) as Row | undefined);
      if (owner) {
        throw new Error(
          `主会话登记冲突：会话 ${record.sessionId} 已登记在项目 ${owner.projectId} 的工作空间 ${owner.workspaceId}`
        );
      }
      throw new Error(`主会话登记未能落库：${record.projectId}/${record.workspaceId}`);
    },
    async release(record) {
      remove.run(record.projectId, record.workspaceId, record.sessionId);
    }
  };
}
