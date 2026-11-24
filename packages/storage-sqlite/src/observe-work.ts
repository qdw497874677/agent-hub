import type { DatabaseSync } from 'node:sqlite';

export type WorkObserveKind = 'dispatch' | 'delegation';
export interface WorkObserveRecord {
  readonly id: string;
  readonly accountId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string | null;
  readonly state: string;
  readonly createdAt: number;
  /** Dispatch notification marker; it is not a receipt or proof a target existed. */
  readonly notified: boolean | null;
}
export interface WorkObserveListInput {
  readonly accountId: string;
  readonly projectIds: readonly string[];
  readonly since: number;
  readonly limit: number;
}

type Row = { id: string; account_id: string; project_id: string; task_id: string; session_id: string | null; state: string; created_at: number; notified: number | null };
const mapRow = (r: Row): WorkObserveRecord => ({ id: r.id, accountId: r.account_id, projectId: r.project_id, taskId: r.task_id, sessionId: r.session_id, state: r.state, createdAt: r.created_at, notified: r.notified === null ? null : r.notified === 1 });

/** SQL performs owner, live task/project and project-scope filtering before the bound. */
export function createSqliteWorkObserve(db: DatabaseSync) {
  // Stores provision both tables first; these indexes let LIMIT stop an owner/time ordered scan
  // without a temporary sort, including when many records belong to other accounts.
  db.exec(`CREATE INDEX IF NOT EXISTS task_dispatch_observe_owner_time ON task_dispatch(account_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS workspace_delegation_observe_owner_time ON workspace_delegation(account_id, created_at DESC, id DESC)`);
  const select = (kind: WorkObserveKind) => {
    const table = kind === 'dispatch' ? 'task_dispatch' : 'workspace_delegation';
    const session = kind === 'dispatch' ? 'w.session_id' : 'w.execution_session_id';
    const notified = kind === 'dispatch' ? 'w.notified' : 'NULL';
    const states = kind === 'dispatch' ? "'queued','running','done','failed','cancelled'" : "'pending','preparing','prepared','failed','uncertain','cancelled'";
    return `SELECT w.id, w.account_id, w.project_id, w.task_id, ${session} AS session_id, w.state, w.created_at, ${notified} AS notified
      FROM ${table} w JOIN tasks t ON t.id = w.task_id AND t.project_id = w.project_id
      JOIN projects p ON p.id = w.project_id AND p.deleted_at IS NULL
      WHERE w.account_id = ? AND w.state IN (${states})`;
  };
  const statements = Object.fromEntries((['dispatch', 'delegation'] as const).map((kind) => [kind, {
    list: db.prepare(`${select(kind)} AND w.created_at >= ? AND w.project_id IN (SELECT value FROM json_each(?)) ORDER BY w.created_at DESC, w.id DESC LIMIT ?`),
    byId: db.prepare(`${select(kind)} AND w.id = ?`)
  }])) as Record<WorkObserveKind, { list: ReturnType<DatabaseSync['prepare']>; byId: ReturnType<DatabaseSync['prepare']> }>;
  return {
    list(kind: WorkObserveKind, input: WorkObserveListInput): readonly WorkObserveRecord[] {
      if (!input.accountId || !input.projectIds.length) return [];
      const since = Number.isFinite(input.since) ? Math.trunc(input.since) : 0;
      const limit = Math.max(1, Math.min(501, Number.isFinite(input.limit) ? Math.trunc(input.limit) : 501));
      return (statements[kind].list.all(input.accountId, since, JSON.stringify(input.projectIds), limit) as Row[]).map(mapRow);
    },
    byId(kind: WorkObserveKind, id: string, accountId: string): WorkObserveRecord | null {
      if (!accountId) return null;
      const row = statements[kind].byId.get(accountId, id) as Row | undefined;
      return row ? mapRow(row) : null;
    }
  };
}
