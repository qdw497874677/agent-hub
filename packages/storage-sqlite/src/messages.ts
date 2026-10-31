import type { DatabaseSync } from 'node:sqlite';
import type { AgentMessage, MessageAuditEntry, MessageStore, MessagingConfig, SpawnRecord } from '@agent-hub/domain';
import { asProjectId, asSessionId } from '@agent-hub/domain';

type Row = Record<string, unknown>;

/** agent 间通信（ADR 0018）：消息即队列（status 一列），派生记录、项目配置、按 trace 的审计。 */
export const MESSAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_session_id TEXT NOT NULL,
  on_behalf_of TEXT NOT NULL,
  to_address TEXT NOT NULL,
  target_session_id TEXT,
  role TEXT,
  reply_to TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  failure TEXT,
  failure_detail TEXT,
  reply_body TEXT,
  reply_source TEXT,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER,
  deadline_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_messages_target ON agent_messages(target_session_id, status, created_at);
CREATE INDEX IF NOT EXISTS agent_messages_from ON agent_messages(from_session_id, created_at);
CREATE INDEX IF NOT EXISTS agent_messages_trace ON agent_messages(trace_id, created_at);
CREATE INDEX IF NOT EXISTS agent_messages_project ON agent_messages(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS agent_messages_idem ON agent_messages(from_session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS agent_spawns (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  spawner_session_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_spawns_role ON agent_spawns(project_id, role);
CREATE TABLE IF NOT EXISTS agent_messaging_config (
  project_id TEXT PRIMARY KEY,
  roles TEXT NOT NULL,
  limits TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_message_audit (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  message_id TEXT,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  on_behalf_of TEXT NOT NULL,
  detail TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_message_audit_trace ON agent_message_audit(trace_id, at);
`;

const toMessage = (row: Row): AgentMessage => ({
  id: row.id as string,
  traceId: row.trace_id as string,
  depth: row.depth as number,
  projectId: asProjectId(row.project_id as string),
  kind: row.kind as AgentMessage['kind'],
  fromSessionId: asSessionId(row.from_session_id as string),
  onBehalfOf: row.on_behalf_of as string,
  to: row.to_address as string,
  targetSessionId: row.target_session_id ? asSessionId(row.target_session_id as string) : null,
  role: (row.role as string | null) ?? null,
  replyTo: (row.reply_to as string | null) ?? null,
  body: row.body as string,
  status: row.status as AgentMessage['status'],
  failure: (row.failure as AgentMessage['failure']) ?? null,
  failureDetail: (row.failure_detail as string | null) ?? null,
  replyBody: (row.reply_body as string | null) ?? null,
  replySource: (row.reply_source as AgentMessage['replySource']) ?? null,
  idempotencyKey: (row.idempotency_key as string | null) ?? null,
  createdAt: row.created_at as number,
  updatedAt: row.updated_at as number,
  deliveredAt: (row.delivered_at as number | null) ?? null,
  deadlineAt: (row.deadline_at as number | null) ?? null
});

const toSpawn = (row: Row): SpawnRecord => ({
  sessionId: asSessionId(row.session_id as string),
  projectId: asProjectId(row.project_id as string),
  role: row.role as string,
  spawnerSessionId: asSessionId(row.spawner_session_id as string),
  traceId: row.trace_id as string,
  createdAt: row.created_at as number
});

const toAudit = (row: Row): MessageAuditEntry => ({
  id: row.id as string,
  traceId: row.trace_id as string,
  messageId: (row.message_id as string | null) ?? null,
  projectId: asProjectId(row.project_id as string),
  action: row.action as MessageAuditEntry['action'],
  actor: row.actor as string,
  onBehalfOf: row.on_behalf_of as string,
  detail: row.detail as string,
  at: row.at as number
});

export function createSqliteMessageStore(db: DatabaseSync): MessageStore {
  db.exec(MESSAGE_SCHEMA);
  const upsert = db.prepare(
    `INSERT INTO agent_messages (id, trace_id, depth, project_id, kind, from_session_id, on_behalf_of, to_address, target_session_id, role, reply_to, body,
       status, failure, failure_detail, reply_body, reply_source, idempotency_key, created_at, updated_at, delivered_at, deadline_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET target_session_id = excluded.target_session_id, status = excluded.status, failure = excluded.failure,
       failure_detail = excluded.failure_detail, reply_body = excluded.reply_body, reply_source = excluded.reply_source,
       updated_at = excluded.updated_at, delivered_at = excluded.delivered_at, deadline_at = excluded.deadline_at`
  );
  const byId = db.prepare('SELECT * FROM agent_messages WHERE id = ?');
  const byIdem = db.prepare('SELECT * FROM agent_messages WHERE from_session_id = ? AND idempotency_key = ?');
  const queued = db.prepare("SELECT * FROM agent_messages WHERE target_session_id = ? AND status = 'queued' ORDER BY created_at, rowid");
  const delivered = db.prepare("SELECT * FROM agent_messages WHERE target_session_id = ? AND status = 'delivered' ORDER BY delivered_at, rowid");
  const byTrace = db.prepare('SELECT * FROM agent_messages WHERE trace_id = ? ORDER BY created_at, rowid');
  const forSession = db.prepare('SELECT * FROM agent_messages WHERE from_session_id = ? OR target_session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?');
  const awaiting = db.prepare("SELECT * FROM agent_messages WHERE project_id = ? AND status = 'awaiting_approval' ORDER BY created_at");
  const overdue = db.prepare("SELECT * FROM agent_messages WHERE kind = 'ask' AND status IN ('queued', 'delivered') AND deadline_at IS NOT NULL AND deadline_at <= ?");
  const getConfig = db.prepare('SELECT * FROM agent_messaging_config WHERE project_id = ?');
  const putConfig = db.prepare(
    `INSERT INTO agent_messaging_config (project_id, roles, limits, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET roles = excluded.roles, limits = excluded.limits, updated_at = excluded.updated_at`
  );
  const putSpawn = db.prepare('INSERT OR REPLACE INTO agent_spawns (session_id, project_id, role, spawner_session_id, trace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const spawnOf = db.prepare('SELECT * FROM agent_spawns WHERE session_id = ?');
  const spawnsForRole = db.prepare('SELECT * FROM agent_spawns WHERE project_id = ? AND role = ? ORDER BY created_at DESC');
  const putAudit = db.prepare(
    'INSERT INTO agent_message_audit (id, trace_id, message_id, project_id, action, actor, on_behalf_of, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const auditByTrace = db.prepare('SELECT * FROM agent_message_audit WHERE trace_id = ? ORDER BY at, rowid');
  return {
    async save(m) {
      upsert.run(
        m.id, m.traceId, m.depth, m.projectId, m.kind, m.fromSessionId, m.onBehalfOf, m.to, m.targetSessionId, m.role, m.replyTo, m.body,
        m.status, m.failure, m.failureDetail, m.replyBody, m.replySource, m.idempotencyKey, m.createdAt, m.updatedAt, m.deliveredAt, m.deadlineAt
      );
    },
    async byId(id) {
      const row = byId.get(id) as Row | undefined;
      return row ? toMessage(row) : null;
    },
    async byIdempotencyKey(fromSessionId, key) {
      const row = byIdem.get(fromSessionId, key) as Row | undefined;
      return row ? toMessage(row) : null;
    },
    queuedFor: async (sessionId) => (queued.all(sessionId) as Row[]).map(toMessage),
    deliveredTo: async (sessionId) => (delivered.all(sessionId) as Row[]).map(toMessage),
    byTrace: async (traceId) => (byTrace.all(traceId) as Row[]).map(toMessage),
    forSession: async (sessionId, limit) => (forSession.all(sessionId, sessionId, limit) as Row[]).map(toMessage),
    awaitingApproval: async (projectId) => (awaiting.all(projectId) as Row[]).map(toMessage),
    overdue: async (now) => (overdue.all(now) as Row[]).map(toMessage),
    async config(projectId) {
      const row = getConfig.get(projectId) as Row | undefined;
      if (!row) return null;
      return { projectId, roles: JSON.parse(row.roles as string), limits: JSON.parse(row.limits as string), updatedAt: row.updated_at as number } as MessagingConfig;
    },
    async saveConfig(config) {
      putConfig.run(config.projectId, JSON.stringify(config.roles), JSON.stringify(config.limits), config.updatedAt);
    },
    async saveSpawn(r) {
      putSpawn.run(r.sessionId, r.projectId, r.role, r.spawnerSessionId, r.traceId, r.createdAt);
    },
    async spawnOf(sessionId) {
      const row = spawnOf.get(sessionId) as Row | undefined;
      return row ? toSpawn(row) : null;
    },
    spawnsForRole: async (projectId, role) => (spawnsForRole.all(projectId, role) as Row[]).map(toSpawn),
    async audit(e) {
      putAudit.run(e.id, e.traceId, e.messageId, e.projectId, e.action, e.actor, e.onBehalfOf, e.detail, e.at);
    },
    auditByTrace: async (traceId) => (auditByTrace.all(traceId) as Row[]).map(toAudit)
  };
}
