import type { DatabaseSync } from 'node:sqlite';
import type { AgentTaskRequest, AgentTaskStore, ChannelOutboxMessage, ConnectorBinding, ConnectorStore, OutboxStore, TriggerRun } from '@agent-hub/domain';
import { upsertSql } from './upsert.ts';

/** 连接器（ADR 0032 R1/R2）：connector_binding、trigger_run、agent_project（bot 关联项目）、agent_task_request、channel_outbox（#221 C2b）。 */
export function createSqliteConnectors(db: DatabaseSync): { connectors: ConnectorStore; agentTasks: AgentTaskStore; outbox: OutboxStore } {
  db.exec(`CREATE TABLE IF NOT EXISTS connector_binding (
    id TEXT PRIMARY KEY, connector TEXT NOT NULL, kind TEXT NOT NULL, agent_project_id TEXT NOT NULL, agent_name TEXT NOT NULL,
    project_id TEXT, name TEXT NOT NULL, target TEXT NOT NULL, params TEXT NOT NULL, enabled INTEGER NOT NULL, paused_reason TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER, main_session_id TEXT, created_by TEXT NOT NULL,
    time_zone TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    target_kind TEXT, group_id TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS connector_binding_agent ON connector_binding(agent_project_id, agent_name)');
  db.exec(`CREATE TABLE IF NOT EXISTS trigger_run (
    id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, external_id TEXT NOT NULL, planned_at INTEGER, catchup INTEGER NOT NULL,
    state TEXT NOT NULL, reason TEXT, session_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    external_conversation_id TEXT, external_thread_id TEXT, post_id TEXT,
    UNIQUE(binding_id, external_id))`);
  db.exec('CREATE INDEX IF NOT EXISTS trigger_run_state ON trigger_run(state, session_id)');
  // 收敛设计 C1（docs/design/channel-convergence.md）：外部会话 → 目标。只建表，暂不接读写路径。
  db.exec(`CREATE TABLE IF NOT EXISTS channel_conversation (
    binding_id TEXT NOT NULL, external_conversation_id TEXT NOT NULL, external_thread_id TEXT,
    thread_key TEXT NOT NULL DEFAULT '', target_kind TEXT NOT NULL, session_id TEXT, group_id TEXT,
    last_inbound_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (binding_id, external_conversation_id, thread_key))`);
  // 出站队列（#221 步骤 6 / 设计 C2b）：租约 + 重试 + 回声比对。状态机见 domain/channel-outbox.ts。
  db.exec(`CREATE TABLE IF NOT EXISTS channel_outbox (
    id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, body TEXT NOT NULL,
    author_kind TEXT NOT NULL, author_name TEXT NOT NULL, reply_to_external_id TEXT,
    external_conversation_id TEXT, external_thread_id TEXT, state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, next_attempt_at INTEGER NOT NULL,
    external_message_id TEXT, origin TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS channel_outbox_due ON channel_outbox(state, next_attempt_at)');
  db.exec('CREATE INDEX IF NOT EXISTS channel_outbox_target ON channel_outbox(target_kind, target_id, updated_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS agent_project (agent_project_id TEXT NOT NULL, agent_name TEXT NOT NULL, project_id TEXT NOT NULL,
    PRIMARY KEY (agent_project_id, agent_name, project_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_task_request (
    id TEXT PRIMARY KEY, task_id TEXT, account_id TEXT NOT NULL, agent TEXT, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
    title TEXT NOT NULL, goal TEXT NOT NULL, origin_connector TEXT, origin_external_id TEXT, wake_key TEXT, counted INTEGER NOT NULL,
    approval TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS agent_task_request_origin ON agent_task_request(project_id, origin_connector, origin_external_id)
    WHERE origin_connector IS NOT NULL AND approval NOT IN ('rejected','cancelled')`);

  // 旧库补列：只加列，不迁移数据（ADR 约定）。
  const bindingColumns = db.prepare('PRAGMA table_info(connector_binding)').all() as { name: string }[];
  if (!bindingColumns.some((c) => c.name === 'target_kind')) db.exec('ALTER TABLE connector_binding ADD COLUMN target_kind TEXT');
  if (!bindingColumns.some((c) => c.name === 'group_id')) db.exec('ALTER TABLE connector_binding ADD COLUMN group_id TEXT');
  const runColumns = db.prepare('PRAGMA table_info(trigger_run)').all() as { name: string }[];
  if (!runColumns.some((c) => c.name === 'external_conversation_id')) db.exec('ALTER TABLE trigger_run ADD COLUMN external_conversation_id TEXT');
  if (!runColumns.some((c) => c.name === 'external_thread_id')) db.exec('ALTER TABLE trigger_run ADD COLUMN external_thread_id TEXT');
  if (!runColumns.some((c) => c.name === 'post_id')) db.exec('ALTER TABLE trigger_run ADD COLUMN post_id TEXT');

  type B = { id: string; connector: string; kind: string; agent_project_id: string; agent_name: string; project_id: string | null; name: string; target: string; params: string;
    enabled: number; paused_reason: string | null; consecutive_failures: number; next_run_at: number | null; main_session_id: string | null; created_by: string; time_zone: string; created_at: number; updated_at: number;
    target_kind: string | null; group_id: string | null };
  const toB = (r: B): ConnectorBinding => ({
    id: r.id, connector: r.connector, kind: r.kind, agentProjectId: r.agent_project_id, agentName: r.agent_name, projectId: r.project_id, name: r.name,
    // C1：先看 target_kind，只有它为空才回落旧的 target（旧库里的 group 不会被压成 main）。
    target: r.target === 'new' ? 'new' : 'main',
    targetKind: r.target_kind === 'group' ? 'group' : 'session', groupId: r.group_id ?? null, params: JSON.parse(r.params) as Record<string, unknown>, enabled: r.enabled === 1, pausedReason: r.paused_reason,
    consecutiveFailures: r.consecutive_failures, nextRunAt: r.next_run_at, mainSessionId: r.main_session_id, createdBy: r.created_by, timeZone: r.time_zone, createdAt: r.created_at, updatedAt: r.updated_at
  });
  type R = { id: string; binding_id: string; external_id: string; planned_at: number | null; catchup: number; state: string; reason: string | null; session_id: string | null; text: string; created_at: number; updated_at: number;
    external_conversation_id: string | null; external_thread_id: string | null; post_id: string | null };
  const toR = (r: R): TriggerRun => ({ id: r.id, bindingId: r.binding_id, externalId: r.external_id, plannedAt: r.planned_at, catchup: r.catchup === 1, state: r.state as TriggerRun['state'], reason: r.reason, sessionId: r.session_id, text: r.text,
    externalConversationId: r.external_conversation_id ?? null, externalThreadId: r.external_thread_id ?? null, postId: r.post_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at });
  type Q = { id: string; task_id: string | null; account_id: string; agent: string | null; session_id: string; project_id: string; title: string; goal: string; origin_connector: string | null; origin_external_id: string | null; wake_key: string | null; counted: number; approval: string; created_at: number; updated_at: number };
  const toQ = (r: Q): AgentTaskRequest => ({ id: r.id, taskId: r.task_id, accountId: r.account_id, agent: r.agent, sessionId: r.session_id, projectId: r.project_id, title: r.title, goal: r.goal, originConnector: r.origin_connector, originExternalId: r.origin_external_id, wakeKey: r.wake_key, counted: r.counted === 1, approval: r.approval as AgentTaskRequest['approval'], createdAt: r.created_at, updatedAt: r.updated_at });
  type O = { id: string; target_kind: string; target_id: string; body: string; author_kind: string; author_name: string; reply_to_external_id: string | null;
    external_conversation_id: string | null; external_thread_id: string | null; state: string; attempts: number; lease_until: number | null;
    next_attempt_at: number; external_message_id: string | null; origin: string; created_at: number; updated_at: number };
  const toO = (r: O): ChannelOutboxMessage => ({
    id: r.id, target: { kind: r.target_kind as ChannelOutboxMessage['target']['kind'], id: r.target_id }, body: r.body,
    author: { kind: r.author_kind as ChannelOutboxMessage['author']['kind'], name: r.author_name },
    replyToExternalId: r.reply_to_external_id ?? null, externalConversationId: r.external_conversation_id ?? null, externalThreadId: r.external_thread_id ?? null,
    state: r.state as ChannelOutboxMessage['state'], attempts: r.attempts, leaseUntil: r.lease_until ?? null, nextAttemptAt: r.next_attempt_at,
    externalMessageId: r.external_message_id ?? null, origin: r.origin as ChannelOutboxMessage['origin'], createdAt: r.created_at, updatedAt: r.updated_at
  });

  const bindingFields = ['id', 'connector', 'kind', 'agent_project_id', 'agent_name', 'project_id', 'name', 'target', 'params', 'enabled', 'paused_reason',
    'consecutive_failures', 'next_run_at', 'main_session_id', 'created_by', 'time_zone', 'created_at', 'updated_at', 'target_kind', 'group_id'] as const;
  const upsertB = db.prepare(upsertSql('connector_binding', bindingFields));
  const runFields = ['id', 'binding_id', 'external_id', 'planned_at', 'catchup', 'state', 'reason', 'session_id', 'text', 'created_at', 'updated_at', 'external_conversation_id', 'external_thread_id', 'post_id'] as const;
  const runCols = `(${runFields.join(', ')}) VALUES (${runFields.map(() => '?').join(',')})`;
  const insR = db.prepare(`INSERT OR IGNORE INTO trigger_run ${runCols}`);
  const upR = db.prepare(upsertSql('trigger_run', runFields));
  const runArgs = (r: TriggerRun) => [r.id, r.bindingId, r.externalId, r.plannedAt, r.catchup ? 1 : 0, r.state, r.reason, r.sessionId, r.text, r.createdAt, r.updatedAt,
    r.externalConversationId ?? null, r.externalThreadId ?? null, r.postId ?? null] as const;
  const qColumns = ['id', 'task_id', 'account_id', 'agent', 'session_id', 'project_id', 'title', 'goal', 'origin_connector', 'origin_external_id', 'wake_key', 'counted', 'approval', 'created_at', 'updated_at'] as const;
  const qCols = `(${qColumns.join(', ')}) VALUES (${qColumns.map(() => '?').join(',')})`;
  const qArgs = (r: AgentTaskRequest) => [r.id, r.taskId, r.accountId, r.agent, r.sessionId, r.projectId, r.title, r.goal, r.originConnector, r.originExternalId, r.wakeKey, r.counted ? 1 : 0, r.approval, r.createdAt, r.updatedAt] as const;
  const insQ = db.prepare(`INSERT OR IGNORE INTO agent_task_request ${qCols}`);
  const upQ = db.prepare(upsertSql('agent_task_request', qColumns));
  const outboxFields = ['id', 'target_kind', 'target_id', 'body', 'author_kind', 'author_name', 'reply_to_external_id', 'external_conversation_id',
    'external_thread_id', 'state', 'attempts', 'lease_until', 'next_attempt_at', 'external_message_id', 'origin', 'created_at', 'updated_at'] as const;
  const upO = db.prepare(upsertSql('channel_outbox', outboxFields));
  const oArgs = (m: ChannelOutboxMessage) => [m.id, m.target.kind, m.target.id, m.body, m.author.kind, m.author.name, m.replyToExternalId,
    m.externalConversationId, m.externalThreadId, m.state, m.attempts, m.leaseUntil, m.nextAttemptAt, m.externalMessageId, m.origin, m.createdAt, m.updatedAt] as const;

  const connectors: ConnectorStore = {
    async saveBinding(b) { upsertB.run(b.id, b.connector, b.kind, b.agentProjectId, b.agentName, b.projectId, b.name, b.target, JSON.stringify(b.params), b.enabled ? 1 : 0, b.pausedReason, b.consecutiveFailures, b.nextRunAt, b.mainSessionId, b.createdBy, b.timeZone, b.createdAt, b.updatedAt,
      b.targetKind ?? 'session', b.groupId ?? null); },
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
  const outbox: OutboxStore = {
    /**
     * CAS 认领：一条 UPDATE 里完成「选一条到期行 + 置 sending + 写租约」。
     * 子查询和 WHERE 各判一次 `state/lease/next_attempt_at`，保证并发调用同一行只有一个
     * 能把 WHERE 命中（SQLite 单条语句原子），另一个拿到 0 行 / undefined。
     */
    async claim(due, now, leaseMs) {
      if (due.kinds.length === 0) return null;
      const marks = due.kinds.map(() => '?').join(',');
      const leaseUntil = now + Math.max(0, leaseMs);
      const row = db.prepare(`UPDATE channel_outbox SET state = 'sending', lease_until = ?, updated_at = ?
        WHERE id = (SELECT id FROM channel_outbox
          WHERE state IN ('queued','sending') AND (lease_until IS NULL OR lease_until <= ?)
            AND next_attempt_at <= ? AND target_kind IN (${marks})
          ORDER BY next_attempt_at, created_at LIMIT 1)
          AND state IN ('queued','sending') AND (lease_until IS NULL OR lease_until <= ?) AND next_attempt_at <= ?
        RETURNING *`).get(leaseUntil, now, now, now, ...due.kinds, now, now) as O | undefined;
      return row ? toO(row) : null;
    },
    async save(m) { upO.run(...oArgs(m)); },
    async expiring(now) {
      return (db.prepare("SELECT * FROM channel_outbox WHERE state = 'sending' AND lease_until IS NOT NULL AND lease_until <= ? ORDER BY lease_until").all(now) as O[]).map(toO);
    },
    async requeue(now) {
      // 只回收过期的 sending；attempts 不在这里加（真正的失败计数在 pump 的 settle 里）。
      return Number(db.prepare("UPDATE channel_outbox SET state = 'queued', lease_until = NULL, next_attempt_at = ?, updated_at = ? WHERE state = 'sending' AND lease_until IS NOT NULL AND lease_until <= ?").run(now, now, now).changes);
    },
    async echoCandidates(target, since) {
      return (db.prepare("SELECT * FROM channel_outbox WHERE target_kind = ? AND target_id = ? AND state IN ('sending','sent') AND updated_at >= ? ORDER BY updated_at").all(target.kind, target.id, since) as O[]).map(toO);
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
  return { connectors, agentTasks, outbox };
}
