import type { DatabaseSync } from 'node:sqlite';
import type { AgentTaskRequest, AgentTaskStore, ConnectorBinding, ConnectorStore, TriggerRun } from '@agent-hub/domain';

/** 连接器（ADR 0032 R1/R2）：connector_binding、trigger_run、agent_project（bot 关联项目）、agent_task_request。 */
export function createSqliteConnectors(db: DatabaseSync): { connectors: ConnectorStore; agentTasks: AgentTaskStore } {
  db.exec(`CREATE TABLE IF NOT EXISTS connector_binding (
    id TEXT PRIMARY KEY, connector TEXT NOT NULL, kind TEXT NOT NULL, agent_project_id TEXT NOT NULL, agent_name TEXT NOT NULL,
    project_id TEXT, name TEXT NOT NULL, target TEXT NOT NULL, params TEXT NOT NULL, enabled INTEGER NOT NULL, paused_reason TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER, main_session_id TEXT, created_by TEXT NOT NULL,
    time_zone TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS connector_binding_agent ON connector_binding(agent_project_id, agent_name)');
  db.exec(`CREATE TABLE IF NOT EXISTS trigger_run (
    id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, external_id TEXT NOT NULL, planned_at INTEGER, catchup INTEGER NOT NULL,
    state TEXT NOT NULL, reason TEXT, session_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(binding_id, external_id))`);
  db.exec('CREATE INDEX IF NOT EXISTS trigger_run_state ON trigger_run(state, session_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS agent_project (agent_project_id TEXT NOT NULL, agent_name TEXT NOT NULL, project_id TEXT NOT NULL,
    PRIMARY KEY (agent_project_id, agent_name, project_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_task_request (
    id TEXT PRIMARY KEY, task_id TEXT, account_id TEXT NOT NULL, agent TEXT, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
    title TEXT NOT NULL, goal TEXT NOT NULL, origin_connector TEXT, origin_external_id TEXT, wake_key TEXT, counted INTEGER NOT NULL,
    approval TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS agent_task_request_origin ON agent_task_request(project_id, origin_connector, origin_external_id)
    WHERE origin_connector IS NOT NULL AND approval NOT IN ('rejected','cancelled')`);

  type B = { id: string; connector: string; kind: string; agent_project_id: string; agent_name: string; project_id: string | null; name: string; target: string; params: string;
    enabled: number; paused_reason: string | null; consecutive_failures: number; next_run_at: number | null; main_session_id: string | null; created_by: string; time_zone: string; created_at: number; updated_at: number };
  const toB = (r: B): ConnectorBinding => ({
    id: r.id, connector: r.connector, kind: r.kind, agentProjectId: r.agent_project_id, agentName: r.agent_name, projectId: r.project_id, name: r.name,
    target: r.target === 'new' ? 'new' : 'main', params: JSON.parse(r.params) as Record<string, unknown>, enabled: r.enabled === 1, pausedReason: r.paused_reason,
    consecutiveFailures: r.consecutive_failures, nextRunAt: r.next_run_at, mainSessionId: r.main_session_id, createdBy: r.created_by, timeZone: r.time_zone, createdAt: r.created_at, updatedAt: r.updated_at
  });
  type R = { id: string; binding_id: string; external_id: string; planned_at: number | null; catchup: number; state: string; reason: string | null; session_id: string | null; text: string; created_at: number; updated_at: number };
  const toR = (r: R): TriggerRun => ({ id: r.id, bindingId: r.binding_id, externalId: r.external_id, plannedAt: r.planned_at, catchup: r.catchup === 1, state: r.state as TriggerRun['state'], reason: r.reason, sessionId: r.session_id, text: r.text, createdAt: r.created_at, updatedAt: r.updated_at });
  type Q = { id: string; task_id: string | null; account_id: string; agent: string | null; session_id: string; project_id: string; title: string; goal: string; origin_connector: string | null; origin_external_id: string | null; wake_key: string | null; counted: number; approval: string; created_at: number; updated_at: number };
  const toQ = (r: Q): AgentTaskRequest => ({ id: r.id, taskId: r.task_id, accountId: r.account_id, agent: r.agent, sessionId: r.session_id, projectId: r.project_id, title: r.title, goal: r.goal, originConnector: r.origin_connector, originExternalId: r.origin_external_id, wakeKey: r.wake_key, counted: r.counted === 1, approval: r.approval as AgentTaskRequest['approval'], createdAt: r.created_at, updatedAt: r.updated_at });

  const upsertB = db.prepare(`INSERT OR REPLACE INTO connector_binding (id, connector, kind, agent_project_id, agent_name, project_id, name, target, params, enabled, paused_reason,
    consecutive_failures, next_run_at, main_session_id, created_by, time_zone, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const runCols = '(id, binding_id, external_id, planned_at, catchup, state, reason, session_id, text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)';
  const insR = db.prepare(`INSERT OR IGNORE INTO trigger_run ${runCols}`);
  const upR = db.prepare(`INSERT OR REPLACE INTO trigger_run ${runCols}`);
  const runArgs = (r: TriggerRun) => [r.id, r.bindingId, r.externalId, r.plannedAt, r.catchup ? 1 : 0, r.state, r.reason, r.sessionId, r.text, r.createdAt, r.updatedAt] as const;
  const qCols = '(id, task_id, account_id, agent, session_id, project_id, title, goal, origin_connector, origin_external_id, wake_key, counted, approval, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
  const qArgs = (r: AgentTaskRequest) => [r.id, r.taskId, r.accountId, r.agent, r.sessionId, r.projectId, r.title, r.goal, r.originConnector, r.originExternalId, r.wakeKey, r.counted ? 1 : 0, r.approval, r.createdAt, r.updatedAt] as const;
  const insQ = db.prepare(`INSERT OR IGNORE INTO agent_task_request ${qCols}`);
  const upQ = db.prepare(`INSERT OR REPLACE INTO agent_task_request ${qCols}`);

  const connectors: ConnectorStore = {
    async saveBinding(b) { upsertB.run(b.id, b.connector, b.kind, b.agentProjectId, b.agentName, b.projectId, b.name, b.target, JSON.stringify(b.params), b.enabled ? 1 : 0, b.pausedReason, b.consecutiveFailures, b.nextRunAt, b.mainSessionId, b.createdBy, b.timeZone, b.createdAt, b.updatedAt); },
    async binding(id) { const r = db.prepare('SELECT * FROM connector_binding WHERE id = ?').get(id) as B | undefined; return r ? toB(r) : null; },
    async bindingsOf(p, n) { return (db.prepare('SELECT * FROM connector_binding WHERE agent_project_id = ? AND agent_name = ? ORDER BY created_at').all(p, n) as B[]).map(toB); },
    async bindingsFor(c) { return (db.prepare('SELECT * FROM connector_binding WHERE connector = ?').all(c) as B[]).map(toB); },
    async allBindings() { return (db.prepare('SELECT * FROM connector_binding').all() as B[]).map(toB); },
    async deleteBinding(id) { db.prepare('DELETE FROM connector_binding WHERE id = ?').run(id); },
    async advance(id, expected, next, now) {
      const r = expected === null
        ? db.prepare('UPDATE connector_binding SET next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at IS NULL').run(next, now, id)
        : db.prepare('UPDATE connector_binding SET next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at = ?').run(next, now, id, expected);
      return Number(r.changes) > 0;
    },
    async insertRun(r) { return Number(insR.run(...runArgs(r)).changes) > 0; },
    async hasRun(b, e) { return db.prepare('SELECT 1 FROM trigger_run WHERE binding_id = ? AND external_id = ? LIMIT 1').get(b, e) !== undefined; },
    async saveRun(r) { upR.run(...runArgs(r)); },
    async runs(b, limit) { return (db.prepare('SELECT * FROM trigger_run WHERE binding_id = ? ORDER BY created_at DESC LIMIT ?').all(b, limit) as R[]).map(toR); },
    async run(id) { const r = db.prepare('SELECT * FROM trigger_run WHERE id = ?').get(id) as R | undefined; return r ? toR(r) : null; },
    async runsSince(ids, since, limit) {
      if (ids.length === 0 || limit <= 0) return [];
      const marks = ids.map(() => '?').join(',');
      return (db.prepare(`SELECT * FROM trigger_run WHERE binding_id IN (${marks}) AND created_at >= ? ORDER BY created_at DESC LIMIT ?`).all(...ids, since, limit) as R[]).map(toR);
    },
    async countRunsByState(ids, since) {
      const counts: Record<TriggerRun['state'], number> = { waiting: 0, delivered: 0, done: 0, failed: 0, timeout: 0, skipped: 0 };
      if (ids.length === 0) return counts;
      const marks = ids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT state, COUNT(*) AS n FROM trigger_run WHERE binding_id IN (${marks}) AND created_at >= ? GROUP BY state`).all(...ids, since) as { state: string; n: number }[];
      for (const row of rows) if (row.state in counts) counts[row.state as TriggerRun['state']] = row.n;
      return counts;
    },
    async openRuns(b) { return (db.prepare("SELECT * FROM trigger_run WHERE binding_id = ? AND state IN ('waiting','delivered')").all(b) as R[]).map(toR); },
    async waitingRuns() { return (db.prepare("SELECT * FROM trigger_run WHERE state = 'waiting' ORDER BY created_at").all() as R[]).map(toR); },
    async deliveredRuns() { return (db.prepare("SELECT * FROM trigger_run WHERE state = 'delivered' ORDER BY created_at").all() as R[]).map(toR); },
    async deliveredRunFor(s) { const r = db.prepare("SELECT * FROM trigger_run WHERE session_id = ? AND state = 'delivered' ORDER BY created_at DESC LIMIT 1").get(s) as R | undefined; return r ? toR(r) : null; },
    async agentProjects(p, n) { return (db.prepare('SELECT project_id FROM agent_project WHERE agent_project_id = ? AND agent_name = ? ORDER BY project_id').all(p, n) as { project_id: string }[]).map((r) => r.project_id); },
    async setAgentProjects(p, n, ids) {
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM agent_project WHERE agent_project_id = ? AND agent_name = ?').run(p, n);
        const ins = db.prepare('INSERT OR IGNORE INTO agent_project (agent_project_id, agent_name, project_id) VALUES (?,?,?)');
        for (const id of ids) ins.run(p, n, id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  };
  const agentTasks: AgentTaskStore = {
    async insert(r) {
      if (Number(insQ.run(...qArgs(r)).changes) > 0) return r;
      const hit = db.prepare(`SELECT * FROM agent_task_request WHERE project_id = ? AND origin_connector = ? AND origin_external_id = ? AND approval NOT IN ('rejected','cancelled')`).get(r.projectId, r.originConnector, r.originExternalId) as Q | undefined;
      return hit ? toQ(hit) : r;
    },
    async save(r) { upQ.run(...qArgs(r)); },
    async byId(id) { const r = db.prepare('SELECT * FROM agent_task_request WHERE id = ?').get(id) as Q | undefined; return r ? toQ(r) : null; },
    async countWake(k) { return (db.prepare("SELECT COUNT(*) AS n FROM agent_task_request WHERE wake_key = ? AND counted = 1").get(k) as { n: number }).n; },
    async countSince(a, since) { return (db.prepare("SELECT COUNT(*) AS n FROM agent_task_request WHERE account_id = ? AND counted = 1 AND created_at >= ?").get(a, since) as { n: number }).n; },
    async bySession(ids, limit) {
      if (ids.length === 0) return [];
      return (db.prepare(`SELECT * FROM agent_task_request WHERE session_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ?`).all(...ids, limit) as Q[]).map(toQ);
    },
    async pendingFor(a) { return (db.prepare("SELECT * FROM agent_task_request WHERE account_id = ? AND approval = 'pending' ORDER BY created_at").all(a) as Q[]).map(toQ); },
    async byWakeKeys(keys) {
      if (keys.length === 0) return [];
      const marks = keys.map(() => '?').join(',');
      return (db.prepare(`SELECT * FROM agent_task_request WHERE wake_key IN (${marks}) ORDER BY created_at`).all(...keys) as Q[]).map(toQ);
    }
  };
  return { connectors, agentTasks };
}
