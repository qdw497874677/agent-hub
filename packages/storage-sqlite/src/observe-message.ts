import type { DatabaseSync } from 'node:sqlite';

export interface MessageObserveRecord {
  readonly id: string;
  readonly projectId: string;
  readonly fromSessionId: string;
  readonly targetSessionId: string;
  readonly replyTo: string | null;
  readonly state: string;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
  readonly readAt: number | null;
  readonly handoffOrigin: string | null;
}

export interface MessageObserveListInput {
  readonly projectIds: readonly string[];
  readonly since: number;
  readonly limit: number;
}

type Row = { id: string; project_id: string; from_session_id: string; target_session_id: string; reply_to: string | null; status: string; created_at: number; delivered_at: number | null; read_at: number | null; handoff_origin: string | null };
const mapRow = (r: Row): MessageObserveRecord => ({ id: r.id, projectId: r.project_id, fromSessionId: r.from_session_id, targetSessionId: r.target_session_id, replyTo: r.reply_to, state: r.status, createdAt: r.created_at, deliveredAt: r.delivered_at, readAt: r.read_at, handoffOrigin: r.handoff_origin });

// Both endpoints must resolve to the message's current canonical project; no address,
// body, parts, trace, error, actor or token column is selected.
const binding = (s: string, t: string) => `(( ${s}.task_id IS NOT NULL AND ${t}.id IS NOT NULL AND ${t}.project_id = m.project_id AND (${s}.origin_project_id IS NULL OR ${s}.origin_project_id = m.project_id)) OR (${s}.task_id IS NULL AND ${s}.origin_project_id = m.project_id))`;
const select = (ordered: boolean) => `SELECT m.id, m.project_id, m.from_session_id, m.target_session_id, m.reply_to, m.status, m.created_at, m.delivered_at, m.read_at, m.handoff_origin
  FROM agent_messages m ${ordered ? 'INDEXED BY agent_messages_observe_time' : ''}
  ${ordered ? 'CROSS JOIN' : 'JOIN'} projects p ON p.id = m.project_id AND p.deleted_at IS NULL
  ${ordered ? 'CROSS JOIN' : 'JOIN'} sessions f ON f.id = m.from_session_id
  ${ordered ? 'CROSS JOIN' : 'JOIN'} sessions d ON d.id = m.target_session_id
  LEFT JOIN tasks ft ON ft.id = f.task_id
  LEFT JOIN tasks dt ON dt.id = d.task_id
  WHERE substr(m.from_session_id, 1, 9) <> 'external:' AND substr(m.target_session_id, 1, 9) <> 'external:'
    AND ${binding('f', 'ft')} AND ${binding('d', 'dt')}
    AND m.status IN ('queued','awaiting_approval','held','delivered','answered','done','failed','denied')`;

// Keep the message index as the outer loop: SQLite otherwise prefers the competing
// project/status index and sorts the entire matching history before applying LIMIT.
export const MESSAGE_OBSERVE_LIST_SQL = `${select(true)} AND m.created_at >= ? AND m.project_id IN (SELECT value FROM json_each(?)) ORDER BY m.created_at DESC, m.id DESC LIMIT ?`;
export const MESSAGE_OBSERVE_BY_ID_SQL = `${select(false)} AND m.id = ?`;

export function createSqliteMessageObserve(db: DatabaseSync) {
  db.exec('CREATE INDEX IF NOT EXISTS agent_messages_observe_time ON agent_messages(created_at DESC, id DESC)');
  const list = db.prepare(MESSAGE_OBSERVE_LIST_SQL);
  const byId = db.prepare(MESSAGE_OBSERVE_BY_ID_SQL);
  return {
    list(input: MessageObserveListInput): readonly MessageObserveRecord[] {
      if (!Array.isArray(input.projectIds) || input.projectIds.length === 0) return [];
      const since = Number.isFinite(input.since) ? Math.trunc(input.since) : 0;
      const limit = Math.max(1, Math.min(501, Number.isFinite(input.limit) ? Math.trunc(input.limit) : 501));
      return (list.all(since, JSON.stringify(input.projectIds), limit) as Row[]).map(mapRow);
    },
    byId(id: string): MessageObserveRecord | null {
      const row = byId.get(id) as Row | undefined;
      return row ? mapRow(row) : null;
    }
  };
}
