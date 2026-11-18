import type { DatabaseSync } from 'node:sqlite';
import type { AgentMessage, Bot, BotDefinition, MessageAuditEntry, MessageStore, MessagingConfig, SpawnRecord } from '@agent-hub/domain';
import { asProjectId, asSessionId, botIdFrom } from '@agent-hub/domain';
import { upsertSql } from './upsert.ts';

type Row = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** 只留文本与开关；脏值丢掉，不让一条坏数据把整份配置读崩。 */
function sanitizeOptions(raw: unknown): Record<string, string | boolean> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, string | boolean> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item === 'string' || typeof item === 'boolean') out[key] = item;
  }
  return out;
}

/**
 * 库里的 roles 还是 JSON，历史形状是扁平的 `agentId/model/options`。
 * 读的时候两种都认：有 `ref` 用 `ref`（缺的字段回落到扁平列），没有就按扁平列拼。
 */
function toRole(raw: unknown, projectId: string, updatedAt: number): Bot {
  const value = isPlainObject(raw) ? raw : {};
  const nested = isPlainObject(value['ref']) ? value['ref'] : null;
  const { agentId, model, options, ref, ...rest } = value;
  const name = String(value['name'] ?? '');
  return {
    ...rest,
    name,
    ref: {
      runtime: String(nested?.['runtime'] ?? value['agentId'] ?? ''),
      model: String(nested?.['model'] ?? value['model'] ?? ''),
      options: sanitizeOptions(nested?.['options'] ?? value['options'])
    },
    // 旧 JSON 没有 id / 时间戳：按 (projectId, name) 算，与迁移脚本、回落路径同一个 seed。
    id: botIdFrom(`${projectId}\0${name}`),
    // 旧 roles 是项目内的配置行，团队在回落映射（botsFromLegacy）里才知道；这里给哨兵值。
    teamId: 'team_legacy',
    createdAt: updatedAt,
    updatedAt
  } as Bot;
}

/** 写回老形状（agentId/model/options）：老版本代码、老备份都还能读。 */
function fromRole(role: BotDefinition): Record<string, unknown> {
  // 只写定义字段：id / projectId / 时间戳属于 bots 表，不塞回旧 roles JSON。
  return {
    name: role.name,
    ...(role.displayName !== undefined ? { displayName: role.displayName } : {}),
    ...(role.color !== undefined ? { color: role.color } : {}),
    description: role.description,
    reuse: role.reuse,
    agentId: role.ref.runtime,
    model: role.ref.model,
    ...(Object.keys(role.ref.options).length > 0 ? { options: role.ref.options } : {})
  };
}

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
  deadline_at INTEGER,
  parts TEXT,
  wake INTEGER NOT NULL DEFAULT 1,
  reply_status TEXT,
  reply_parts TEXT,
  read_at INTEGER,
  hold_reason TEXT,
  from_label TEXT
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
CREATE TABLE IF NOT EXISTS agent_session_handles (
  session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_session_handles_task ON agent_session_handles(task_id, handle);
`;

/** 会话通信 P1a 给老库补的列（新库 CREATE TABLE 里已经有）。 */
const MESSAGE_COLUMNS: readonly [string, string][] = [
  ['parts', 'TEXT'],
  ['wake', 'INTEGER NOT NULL DEFAULT 1'],
  ['reply_status', 'TEXT'],
  ['reply_parts', 'TEXT'],
  ['read_at', 'INTEGER'],
  ['hold_reason', 'TEXT'],
  ['from_label', 'TEXT']
];

const parseParts = (raw: unknown): AgentMessage['parts'] => {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as AgentMessage['parts']) : [];
  } catch {
    return [];
  }
};

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
  deadlineAt: (row.deadline_at as number | null) ?? null,
  parts: parseParts(row.parts),
  wake: row.wake === undefined || row.wake === null ? true : Number(row.wake) !== 0,
  replyStatus: (row.reply_status as AgentMessage['replyStatus']) ?? null,
  replyParts: parseParts(row.reply_parts),
  readAt: (row.read_at as number | null) ?? null,
  holdReason: (row.hold_reason as AgentMessage['holdReason']) ?? null,
  fromLabel: (row.from_label as string | null) ?? null
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
  const existing = new Set((db.prepare('PRAGMA table_info(agent_messages)').all() as Row[]).map((column) => column.name as string));
  for (const [name, type] of MESSAGE_COLUMNS) if (!existing.has(name)) db.exec(`ALTER TABLE agent_messages ADD COLUMN ${name} ${type}`);
  const configColumns = new Set((db.prepare('PRAGMA table_info(agent_messaging_config)').all() as Row[]).map((column) => column.name as string));
  // 会话通信 P1f：项目是否信任同伴（guarded → auto 不拦）
  if (!configColumns.has('trust_peers')) db.exec('ALTER TABLE agent_messaging_config ADD COLUMN trust_peers INTEGER NOT NULL DEFAULT 0');
  const upsert = db.prepare(
    `INSERT INTO agent_messages (id, trace_id, depth, project_id, kind, from_session_id, on_behalf_of, to_address, target_session_id, role, reply_to, body,
       status, failure, failure_detail, reply_body, reply_source, idempotency_key, created_at, updated_at, delivered_at, deadline_at,
       parts, wake, reply_status, reply_parts, read_at, hold_reason, from_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET target_session_id = excluded.target_session_id, status = excluded.status, failure = excluded.failure,
       failure_detail = excluded.failure_detail, reply_body = excluded.reply_body, reply_source = excluded.reply_source,
       updated_at = excluded.updated_at, delivered_at = excluded.delivered_at, deadline_at = excluded.deadline_at,
       reply_status = excluded.reply_status, reply_parts = excluded.reply_parts, read_at = excluded.read_at, hold_reason = excluded.hold_reason`
  );
  const toAddress = db.prepare('SELECT * FROM agent_messages WHERE to_address = ? AND created_at > ? ORDER BY created_at, rowid LIMIT ?');
  const pendingTargets = db.prepare("SELECT DISTINCT target_session_id FROM agent_messages WHERE status IN ('queued', 'held') AND target_session_id IS NOT NULL");
  const putHandle = db.prepare(
    `INSERT INTO agent_session_handles (session_id, task_id, handle, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET task_id = excluded.task_id, handle = excluded.handle, updated_at = excluded.updated_at`
  );
  const handleOf = db.prepare('SELECT handle FROM agent_session_handles WHERE session_id = ?');
  const byHandle = db.prepare('SELECT session_id FROM agent_session_handles WHERE task_id = ? AND handle = ?');
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
    `INSERT INTO agent_messaging_config (project_id, roles, limits, trust_peers, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET roles = excluded.roles, limits = excluded.limits, trust_peers = excluded.trust_peers, updated_at = excluded.updated_at`
  );
  const spawnFields = ['session_id', 'project_id', 'role', 'spawner_session_id', 'trace_id', 'created_at'] as const;
  const putSpawn = db.prepare(upsertSql('agent_spawns', spawnFields, 'session_id'));
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
        m.status, m.failure, m.failureDetail, m.replyBody, m.replySource, m.idempotencyKey, m.createdAt, m.updatedAt, m.deliveredAt, m.deadlineAt,
        m.parts && m.parts.length > 0 ? JSON.stringify(m.parts) : null, m.wake === false ? 0 : 1, m.replyStatus ?? null,
        m.replyParts && m.replyParts.length > 0 ? JSON.stringify(m.replyParts) : null, m.readAt ?? null, m.holdReason ?? null,
        m.fromLabel ?? null
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
      const roles = JSON.parse(row.roles as string) as unknown;
      return {
        projectId,
        roles: Array.isArray(roles) ? roles.map((role) => toRole(role, projectId, row.updated_at as number)) : [],
        limits: JSON.parse(row.limits as string),
        trustPeers: row.trust_peers === 1,
        updatedAt: row.updated_at as number
      } as MessagingConfig;
    },
    async saveConfig(config) {
      putConfig.run(
        config.projectId,
        JSON.stringify(config.roles.map(fromRole)),
        JSON.stringify(config.limits),
        config.trustPeers === true ? 1 : 0,
        config.updatedAt
      );
    },
    async saveSpawn(r) {
      putSpawn.run(r.sessionId, r.projectId, r.role, r.spawnerSessionId, r.traceId, r.createdAt);
    },
    async spawnOf(sessionId) {
      const row = spawnOf.get(sessionId) as Row | undefined;
      return row ? toSpawn(row) : null;
    },
    spawnsForRole: async (projectId, role) => (spawnsForRole.all(projectId, role) as Row[]).map(toSpawn),
    pendingTargets: async () => (pendingTargets.all() as Row[]).map((row) => asSessionId(row.target_session_id as string)),
    async setHandle(record) {
      const taken = byHandle.get(record.taskId, record.handle) as Row | undefined;
      if (taken && taken.session_id !== record.sessionId) return false;
      putHandle.run(record.sessionId, record.taskId, record.handle, record.updatedAt);
      return true;
    },
    toAddress: async (address, after, limit) => (toAddress.all(address, after, limit) as Row[]).map(toMessage),
    async handleOf(sessionId) {
      const row = handleOf.get(sessionId) as Row | undefined;
      return row ? (row.handle as string) : null;
    },
    async sessionByHandle(taskId, handle) {
      const row = byHandle.get(taskId, handle) as Row | undefined;
      return row ? asSessionId(row.session_id as string) : null;
    },
    async audit(e) {
      putAudit.run(e.id, e.traceId, e.messageId, e.projectId, e.action, e.actor, e.onBehalfOf, e.detail, e.at);
    },
    auditByTrace: async (traceId) => (auditByTrace.all(traceId) as Row[]).map(toAudit)
  };
}
