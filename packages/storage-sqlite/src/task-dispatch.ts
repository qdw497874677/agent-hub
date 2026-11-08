import type { DatabaseSync } from 'node:sqlite';
import type { TaskDispatch, TaskDispatchStore } from '@agent-hub/domain';

/** 调度队列（ADR 0032 R3）：task_dispatch，一个任务只入队一次。 */
export function createSqliteTaskDispatch(db: DatabaseSync): TaskDispatchStore {
  db.exec(`CREATE TABLE IF NOT EXISTS task_dispatch (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL, project_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
    human INTEGER NOT NULL, notify_session_id TEXT, agent_id TEXT, model TEXT, origin_connector TEXT, origin_external_id TEXT,
    state TEXT NOT NULL, worker_id TEXT, session_id TEXT, wait_reason TEXT, result TEXT, notified INTEGER NOT NULL,
    created_at INTEGER NOT NULL, started_at INTEGER, updated_at INTEGER NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS task_dispatch_state ON task_dispatch(state)');
  db.exec('CREATE INDEX IF NOT EXISTS task_dispatch_session ON task_dispatch(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS task_dispatch_account ON task_dispatch(account_id, created_at)');
  type D = { id: string; task_id: string; account_id: string; project_id: string; title: string; goal: string; human: number; notify_session_id: string | null;
    agent_id: string | null; model: string | null; origin_connector: string | null; origin_external_id: string | null; state: string; worker_id: string | null;
    session_id: string | null; wait_reason: string | null; result: string | null; notified: number; created_at: number; started_at: number | null; updated_at: number };
  const to = (r: D): TaskDispatch => ({
    id: r.id, taskId: r.task_id, accountId: r.account_id, projectId: r.project_id, title: r.title, goal: r.goal, human: r.human === 1,
    notifySessionId: r.notify_session_id, agentId: r.agent_id, model: r.model, originConnector: r.origin_connector, originExternalId: r.origin_external_id,
    state: r.state as TaskDispatch['state'], workerId: r.worker_id, sessionId: r.session_id, waitReason: r.wait_reason, result: r.result,
    notified: r.notified === 1, createdAt: r.created_at, startedAt: r.started_at, updatedAt: r.updated_at
  });
  const cols = `(id, task_id, account_id, project_id, title, goal, human, notify_session_id, agent_id, model, origin_connector, origin_external_id,
    state, worker_id, session_id, wait_reason, result, notified, created_at, started_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const args = (d: TaskDispatch) => [d.id, d.taskId, d.accountId, d.projectId, d.title, d.goal, d.human ? 1 : 0, d.notifySessionId, d.agentId, d.model,
    d.originConnector, d.originExternalId, d.state, d.workerId, d.sessionId, d.waitReason, d.result, d.notified ? 1 : 0, d.createdAt, d.startedAt, d.updatedAt] as const;
  const ins = db.prepare(`INSERT OR IGNORE INTO task_dispatch ${cols}`);
  const up = db.prepare(`INSERT OR REPLACE INTO task_dispatch ${cols}`);
  const one = (sql: string, ...a: (string | number)[]) => { const r = db.prepare(sql).get(...a) as D | undefined; return r ? to(r) : null; };
  const many = (sql: string, ...a: (string | number)[]) => (db.prepare(sql).all(...a) as D[]).map(to);
  return {
    async insert(d) { ins.run(...args(d)); return one('SELECT * FROM task_dispatch WHERE task_id = ?', d.taskId)!; },
    async save(d) { up.run(...args(d)); },
    async byId(id) { return one('SELECT * FROM task_dispatch WHERE id = ?', id); },
    async bySession(s) { return one('SELECT * FROM task_dispatch WHERE session_id = ? ORDER BY created_at DESC LIMIT 1', s); },
    async active() { return many("SELECT * FROM task_dispatch WHERE state IN ('queued','running') ORDER BY created_at"); },
    async unnotified() { return many("SELECT * FROM task_dispatch WHERE notified = 0 AND state IN ('done','failed') ORDER BY updated_at"); },
    async recent(a, limit) { return many("SELECT * FROM task_dispatch WHERE account_id = ? ORDER BY CASE WHEN state IN ('queued','running') THEN 0 ELSE 1 END, updated_at DESC LIMIT ?", a, limit); },
    async byTaskIds(ids) {
      if (ids.length === 0) return [];
      const marks = ids.map(() => '?').join(',');
      return many(`SELECT * FROM task_dispatch WHERE task_id IN (${marks}) ORDER BY created_at`, ...ids);
    }
  };
}
