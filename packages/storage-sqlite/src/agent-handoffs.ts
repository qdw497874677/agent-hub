import type { DatabaseSync } from 'node:sqlite';
import { applyEvent, isUnknownOutcomeEnded, UNKNOWN_OUTCOME_MARKER, type Delivery, type JournalEntry, type Session, type SessionEvent, type AgentHandoffDeliveryEvidence, type AgentHandoffFirst, type AgentHandoffRecord, type AgentHandoffReservation, type AgentHandoffStartup, type AgentHandoffStore } from '@agent-hub/domain';
import { installAgentHandoffSourceIndexes, prepareAgentHandoffSource } from './agent-handoff-source.ts';
import { toSession } from './mappers.ts';
import { inTransaction } from './tx.ts';

/** Explicit, unregistered setup; dependencies must already have been installed. */
export function ensureAgentHandoffTable(db: DatabaseSync): void {
  installAgentHandoffSourceIndexes(db);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_handoff (
    target_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, source_id TEXT NOT NULL,
    request_key TEXT NOT NULL, semantic_hash TEXT NOT NULL, reservation TEXT NOT NULL,
    source_agent TEXT NOT NULL, first_request_key TEXT, first_hash TEXT, first_seq INTEGER,
    first_delivery_id TEXT, startup_state TEXT NOT NULL DEFAULT 'pending', startup_attempt TEXT,
    startup_worker TEXT, startup_connection TEXT, updated_at INTEGER NOT NULL,
    UNIQUE(actor_id, source_id, request_key)
  )`);
  // Pre-connection claims cannot safely be settled or reclaimed after upgrading.
  const columns = db.prepare('PRAGMA table_info(agent_handoff)').all() as { name: string }[];
  if (!columns.some(c => c.name === 'startup_connection')) db.exec('ALTER TABLE agent_handoff ADD COLUMN startup_connection TEXT');
  if (!columns.some(c => c.name === 'first_seq')) db.exec('ALTER TABLE agent_handoff ADD COLUMN first_seq INTEGER');
  if (!columns.some(c => c.name === 'first_delivery_id')) db.exec('ALTER TABLE agent_handoff ADD COLUMN first_delivery_id TEXT');
  // Upgrade prerelease receipts without retaining duplicated prompt bodies. Invalid old
  // receipts remain incomplete and are rejected rather than treated as unadmitted.
  if (columns.some(c => c.name === 'first_event') && columns.some(c => c.name === 'first_delivery')) db.exec(`UPDATE agent_handoff SET
    first_seq=COALESCE(CASE WHEN json_valid(first_delivery) THEN json_extract(first_delivery,'$.seq') END, -1),
    first_delivery_id=CASE WHEN json_valid(first_delivery) THEN json_extract(first_delivery,'$.id') END,
    first_event=NULL, first_delivery=NULL WHERE first_event IS NOT NULL OR first_delivery IS NOT NULL`);
}

type Row = { target_id: string; actor_id: string; source_id: string; request_key: string; semantic_hash: string; reservation: string; source_agent: string; first_request_key: string | null; first_hash: string | null; first_seq: number | null; first_delivery_id: string | null; startup_state: AgentHandoffRecord['startup']['state']; startup_attempt: string | null; startup_worker: string | null; startup_connection: string | null };
/** Below the projection's own 2,000-row / 2 MiB limits, including metadata overhead. */
export const AGENT_HANDOFF_HISTORY_ROWS = 512;
export const AGENT_HANDOFF_HISTORY_BYTES = 256 * 1024;
const small = (s: string) => typeof s === 'string' && s.trim().length > 0 && Buffer.byteLength(s) <= 512;
const usableNativeRef = (v: unknown): v is string => typeof v === 'string' && small(v) && v.trim().toLowerCase() !== 'pending' && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const MAX_RESERVATION_BYTES = 64 * 1024;
// Runtime metadata is untrusted; bound both individual fields and total size.
const boundedText = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= 4096;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
const optionalText = (v: unknown) => v === undefined || boundedText(v);
const stringList = (v: unknown) => Array.isArray(v) && v.length <= 256 && v.every(boundedText);
function validOptionValue(v: unknown): boolean {
  if (!object(v) || !only(v, ['value','label','description','metadata']) || !boundedText(v.value) || !boundedText(v.label) || !optionalText(v.description)) return false;
  if (v.metadata === undefined) return true;
  const m = v.metadata;
  if (!object(m) || !only(m, ['contextWindow','maxTokens','defaultThinking','aliases','selectable','tags'])) return false;
  return (m.contextWindow === undefined || (Number.isSafeInteger(m.contextWindow) && (m.contextWindow as number) > 0))
    && (m.maxTokens === undefined || (Number.isSafeInteger(m.maxTokens) && (m.maxTokens as number) > 0))
    && optionalText(m.defaultThinking) && (m.aliases === undefined || stringList(m.aliases))
    && (m.tags === undefined || stringList(m.tags)) && (m.selectable === undefined || typeof m.selectable === 'boolean');
}
function serializeOptions(value: unknown): string | null {
  try {
    if (!Array.isArray(value) || value.length > 128) return null;
    const ids = new Set<string>();
    for (const v of value) {
      if (!object(v) || !only(v, ['id','label','description','category','kind','current','choices']) || !small(v.id as string) || ids.has(v.id as string) || !boundedText(v.label) || !optionalText(v.description)
        || typeof v.category !== 'string' || !['model','agent','mode','model_config','thought_level','custom'].includes(v.category)
        || (v.kind !== 'select' && v.kind !== 'boolean') || !Array.isArray(v.choices) || v.choices.length > 256
        || (v.kind === 'boolean' ? typeof v.current !== 'boolean' || v.choices.length !== 0 : !boundedText(v.current))) return null;
      ids.add(v.id as string);
      for (const choice of v.choices) {
        if (!object(choice)) return null;
        if (choice.kind === 'value') { if (!only(choice, ['kind','value']) || !validOptionValue(choice.value)) return null; }
        else if (choice.kind === 'group') { if (!only(choice, ['kind','label','values']) || !boundedText(choice.label) || !Array.isArray(choice.values) || choice.values.length > 256 || !choice.values.every(validOptionValue)) return null; }
        else return null;
      }
    }
    const json = JSON.stringify(value);
    return Buffer.byteLength(json) <= 64 * 1024 ? json : null;
  } catch { return null; }
}
class Rejected extends Error {}

export function createSqliteAgentHandoffs(db: DatabaseSync, saveSession: (session: Session) => void): AgentHandoffStore {
  const byTarget = db.prepare('SELECT * FROM agent_handoff WHERE target_id = ?');
  const byKey = db.prepare('SELECT * FROM agent_handoff WHERE actor_id = ? AND source_id = ? AND request_key = ?');
  const sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const convert = (r: Row): AgentHandoffRecord => {
    let first: AgentHandoffRecord['first'] = null;
    const fields = [r.first_request_key, r.first_hash, r.first_seq, r.first_delivery_id];
    if (fields.some(v => v !== null)) {
      if (!small(r.first_request_key ?? '') || !small(r.first_hash ?? '') || r.first_seq !== 1 || !small(r.first_delivery_id ?? '')) throw new Rejected('Incomplete handoff receipt');
      const j = db.prepare('SELECT type, payload FROM journal WHERE session_id=? AND seq=?').get(r.target_id, r.first_seq) as { type: string; payload: string } | undefined;
      const d = db.prepare('SELECT * FROM message_delivery WHERE id=? AND session_id=? AND seq=?').get(r.first_delivery_id!, r.target_id, r.first_seq) as { id: string; session_id: string; seq: number; kind: string; payload: string; state: Delivery['state']; attempt: number; next_at: number | null; last_error: string | null; created_at: number; updated_at: number } | undefined;
      try {
        if (!j || j.type !== 'prompt' || !d || d.kind !== 'prompt' || !['queued','sending','delivered','undelivered','cancelled','held'].includes(d.state) || !Number.isSafeInteger(d.attempt) || d.attempt < 0) throw new Error();
        const event = JSON.parse(j.payload) as SessionEvent;
        const payload = JSON.parse(d.payload) as { text?: unknown; parts?: unknown } | null;
        if (!event || event.kind !== 'prompt' || typeof event.text !== 'string' || event.promptActor !== 'account' || !small(event.clientMessageId ?? '') || !payload || typeof payload.text !== 'string' || !Array.isArray(payload.parts) || payload.parts.length !== 0) throw new Error();
        const delivery: Delivery = { id: d.id, sessionId: d.session_id, seq: d.seq, kind: 'prompt', payload, state: d.state, attempt: d.attempt, nextAt: d.next_at, lastError: d.last_error, createdAt: d.created_at, updatedAt: d.updated_at };
        first = { requestKey: r.first_request_key!, semanticHash: r.first_hash!, event, delivery };
      } catch { throw new Rejected('Invalid handoff receipt'); }
    } else if (r.startup_state !== 'pending') throw new Rejected('Missing handoff receipt');
    return { reservation: JSON.parse(r.reservation) as AgentHandoffReservation, sourceAgent: r.source_agent, first,
      startup: { state: r.startup_state, attemptId: r.startup_attempt, workerId: r.startup_worker, connectionId: r.startup_connection } };
  };
  const get = (id: string) => byTarget.get(id) as Row | undefined;
  const session = (id: string) => { const r = sessionRow.get(id); return r ? toSession(r) : null; };
  const validPins = (r: AgentHandoffReservation, sourceAgent: string, target: Session): boolean => {
    const source = session(r.sourceSessionId);
    if (!source || source.agentId !== sourceAgent || source.taskId !== r.taskId || source.workspaceId !== r.workspaceId || source.workerId !== r.workerId || source.groupId != null || source.botId != null || (source.kind ?? 'chat') !== 'chat' || source.parentSessionId != null) return false;
    if (target.id !== r.target.id || target.id === source.id || target.agentId !== r.targetAgent || target.agentId === source.agentId || target.model !== r.targetModel || target.taskId !== r.taskId || target.workspaceId !== r.workspaceId || target.workerId !== r.workerId || target.origin.kind !== 'derive' || target.groupId != null || target.botId != null || (target.kind ?? 'chat') !== 'chat' || target.parentSessionId != null || target.createdBy !== r.actorId) return false;
    const task = db.prepare('SELECT project_id, archived_at, status FROM tasks WHERE id = ?').get(r.taskId) as { project_id: string; archived_at: number | null; status: string } | undefined;
    if (!task || task.project_id !== r.projectId || task.archived_at !== null || task.status === 'abandoned') return false;
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL').get(r.projectId)) return false;
    const w = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(r.workspaceId) as Record<string, unknown> | undefined;
    if (!w || !['ready', 'kept'].includes(String(w.state)) || w.worker_id !== r.workerId || w.path !== r.path || w.group_id != null) return false;
    const links = db.prepare('SELECT project_id FROM project_workspaces WHERE workspace_id = ? LIMIT 2').all(r.workspaceId) as { project_id: string }[];
    if (links.length > 1 || (links.length === 1 && links[0]!.project_id !== r.projectId)) return false;
    if (w.kind === 'temporary') return w.project_id === r.projectId && w.owner_task_id === r.taskId;
    return w.kind === 'long_lived' && (links.length === 1 || w.project_id === r.projectId);
  };
  const pristine = (s: Session) => s.status === 'running' && s.lastSeq === 0 && s.turn === 0 && s.agentSessionRef === null && s.originProjectId == null && Object.keys(s.options).length === 0 && s.optionSpec.length === 0 && s.assetIds == null && s.assetSetIds == null && s.mcpDisabled.length === 0 && !s.pinned && s.environmentRevision == null && s.settledAt == null;
  const ingressFree = (id: string) => !db.prepare('SELECT 1 FROM journal WHERE session_id = ? LIMIT 1').get(id) && !db.prepare('SELECT 1 FROM message_delivery WHERE session_id = ? LIMIT 1').get(id) && !db.prepare('SELECT 1 FROM agent_messages WHERE target_session_id = ? LIMIT 1').get(id) && !db.prepare('SELECT 1 FROM branch_attempt WHERE session_id = ? LIMIT 1').get(id);
  const reject = () => { throw new Rejected(); };
  const attempt = <T>(fn: () => T, fallback: T): T => { try { return inTransaction(db, fn); } catch (e) { if (e instanceof Rejected) return fallback; throw e; } };
  // Do not materialize the source prompt or decorated payload into application memory.
  // The source proof additionally establishes the unique keyed, known-outcome end.
  const completedHandoffSource = (id: string): boolean => {
    const row = db.prepare('SELECT first_request_key, first_hash, first_seq, first_delivery_id FROM agent_handoff WHERE target_id=?').get(id) as Pick<Row, 'first_request_key' | 'first_hash' | 'first_seq' | 'first_delivery_id'> | undefined;
    if (!row) return true;
    if (!small(row.first_request_key ?? '') || !small(row.first_hash ?? '') || row.first_seq !== 1 || !small(row.first_delivery_id ?? '')) return false;
    return !!db.prepare(`SELECT 1 FROM journal j JOIN message_delivery d ON d.session_id=j.session_id AND d.seq=j.seq
      WHERE j.session_id=? AND j.seq=? AND j.type='prompt' AND d.id=? AND d.kind='prompt' AND d.state='delivered'
      AND CASE WHEN typeof(j.payload)='text' AND length(CAST(j.payload AS BLOB)) <= 1048576 AND json_valid(j.payload)
        THEN json_extract(j.payload,'$.kind')='prompt' AND json_type(j.payload,'$.text')='text'
          AND json_extract(j.payload,'$.promptActor')='account' AND json_type(j.payload,'$.clientMessageId')='text'
          AND length(trim(json_extract(j.payload,'$.clientMessageId'))) > 0
          AND length(CAST(json_extract(j.payload,'$.clientMessageId') AS BLOB)) <= 512 ELSE 0 END
      AND CASE WHEN typeof(d.payload)='text' AND length(CAST(d.payload AS BLOB)) <= 1048576 AND json_valid(d.payload)
        THEN json_type(d.payload,'$.text')='text' AND json_type(d.payload,'$.parts')='array'
          AND json_array_length(d.payload,'$.parts')=0 ELSE 0 END`).get(id, row.first_seq, row.first_delivery_id!);
  };
  return {
    async reserve(r) {
      return attempt(() => {
        if (![r.actorId, r.sourceSessionId, r.requestKey, r.semanticHash, r.projectId, r.taskId, r.workspaceId, r.workerId, r.path, r.targetAgent, r.targetModel, r.target?.id].every(small) || !Number.isSafeInteger(r.sourceCursor) || r.sourceCursor < 0) return { kind: 'conflict' } as const;
        const old = byKey.get(r.actorId, r.sourceSessionId, r.requestKey) as Row | undefined;
        if (old) {
          if (old.semantic_hash !== r.semanticHash || !session(old.target_id) || !session(old.source_id)) return { kind: 'conflict' } as const;
          return { kind: 'replay', record: convert(old) } as const;
        }
        let reservation: string;
        try { reservation = JSON.stringify(r); } catch { return { kind: 'conflict' } as const; }
        if (typeof reservation !== 'string' || Buffer.byteLength(reservation) > MAX_RESERVATION_BYTES) return { kind: 'conflict' } as const;
        if (session(r.target.id) || !pristine(r.target)) return { kind: 'conflict' } as const;
        const source = session(r.sourceSessionId);
        if (!source || !validPins(r, source.agentId, r.target)) return { kind: 'conflict' } as const;
        saveSession(r.target);
        const staged = session(r.target.id);
        if (!staged || !validPins(r, source.agentId, staged) || !pristine(staged) || !ingressFree(staged.id)) reject();
        if (!completedHandoffSource(r.sourceSessionId) || prepareAgentHandoffSource(db, r.sourceSessionId, r.sourceCursor).kind !== 'ready') reject();
        db.prepare('INSERT INTO agent_handoff(target_id, actor_id, source_id, request_key, semantic_hash, reservation, source_agent, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(r.target.id, r.actorId, r.sourceSessionId, r.requestKey, r.semanticHash, reservation, source.agentId, r.now);
        return { kind: 'created', record: convert(get(r.target.id)!) } as const;
      }, { kind: 'conflict' } as const);
    },
    async byTarget(id) { const row = get(id); return row ? convert(row) : null; },
    async byRequest(actorId, sourceSessionId, requestKey) { const row = byKey.get(actorId, sourceSessionId, requestKey) as Row | undefined; return row ? convert(row) : null; },
    async firstEnded(sessionId, deliveryId, seq) {
      if (!small(sessionId) || !small(deliveryId) || !Number.isSafeInteger(seq) || seq <= 0) return false;
      try {
        return inTransaction(db, () => {
          const delivery = db.prepare("SELECT 1 FROM message_delivery WHERE id=? AND session_id=? AND seq=? AND kind='prompt' AND state='delivered'").get(deliveryId, sessionId, seq);
          if (!delivery) return false;
          // The expression and partial predicate match handoff_first_ended exactly;
          // only bodies with this delivery key are evaluated, at most two.
          const ends = db.prepare(`SELECT seq, CASE WHEN length(CAST(payload AS BLOB)) <= 1048576
            AND json_type(payload)='object' AND json_type(payload,'$.kind')='text'
            AND json_extract(payload,'$.kind')='ended' AND json_type(payload,'$.outcome')='text'
            AND json_extract(payload,'$.outcome') IN ('done','failed','interrupted','stopped')
            AND (json_type(payload,'$.reason') IS NULL OR json_type(payload,'$.reason')='text')
            AND (json_type(payload,'$.reason') IS NULL OR instr(json_extract(payload,'$.reason'),?)=0)
            AND json_type(payload,'$.outcomeUnknown') IS NULL
            AND (SELECT count(*) FROM json_each(payload) WHERE key='kind')=1
            AND (SELECT count(*) FROM json_each(payload) WHERE key='deliveryId')=1
            AND (SELECT count(*) FROM json_each(payload) WHERE key='outcome')=1
            AND (SELECT count(*) FROM json_each(payload) WHERE key='reason')<=1
            AND (SELECT count(*) FROM json_each(payload) WHERE key='outcomeUnknown')=0
            THEN 1 ELSE 0 END AS valid
            FROM journal INDEXED BY handoff_first_ended
            WHERE session_id=? AND type='ended'
              AND CASE WHEN typeof(payload)='text' AND json_valid(payload) AND json_type(payload,'$.deliveryId')='text'
                THEN json_extract(payload,'$.deliveryId') END = ? AND seq > ? LIMIT 2`).all(UNKNOWN_OUTCOME_MARKER, sessionId, deliveryId, seq) as { seq: number; valid: number }[];
          return ends.length === 1 && Number.isSafeInteger(ends[0]!.seq) && ends[0]!.valid === 1;
        });
      } catch { return false; }
    },
    async historyFor(sourceSessionId, cursor) {
      const empty = { entries: [], deliveries: [] };
      if (!small(sourceSessionId) || !Number.isSafeInteger(cursor) || cursor < 0) return empty;
      // One read snapshot: size/count decisions and keyed evidence refer to the same view.
      db.exec('BEGIN');
      try {
        // First read only bounded metadata and raw byte lengths, never payload content.
        // Fetch selected payloads individually only after the cumulative cap is known.
        const metadata = db.prepare(`SELECT seq, type, at, turn, typeof(payload) AS payload_type,
          length(CAST(payload AS BLOB)) AS bytes FROM journal
          WHERE session_id=? AND seq > 0 AND seq <= ? AND type IN ('prompt','text','ended')
          ORDER BY seq DESC LIMIT ?`).all(sourceSessionId, cursor, AGENT_HANDOFF_HISTORY_ROWS) as { seq: number; type: string; at: number; turn: number | null; payload_type: string; bytes: number | null }[];
        let remaining = AGENT_HANDOFF_HISTORY_BYTES;
        const selected: typeof metadata = [];
        for (const row of metadata) {
          if (row.payload_type !== 'text' || row.bytes === null || row.bytes + 256 > remaining) break;
          remaining -= row.bytes + 256;
          selected.push(row);
        }
        selected.reverse();
        const payloadAt = db.prepare('SELECT payload FROM journal WHERE session_id=? AND seq=? AND typeof(payload)=\'text\' AND length(CAST(payload AS BLOB)) <= ?');
        const entries: JournalEntry[] = [];
        for (const row of selected) {
          try {
            const stored = payloadAt.get(sourceSessionId, row.seq, row.bytes!) as { payload: string } | undefined;
            if (!stored) continue;
            const value: unknown = JSON.parse(stored.payload);
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            const e = value as Record<string, unknown>;
            if (e.kind !== row.type || !Number.isSafeInteger(row.seq) || row.seq <= 0 || !Number.isFinite(row.at)) continue;
            if (e.kind === 'prompt' && typeof e.text !== 'string') continue;
            if (e.kind === 'text' && typeof e.delta !== 'string') continue;
            if (e.kind === 'ended' && !['done', 'stopped', 'interrupted', 'failed'].includes(String(e.outcome))) continue;
            if (e.kind === 'ended' && e.reason !== undefined && typeof e.reason !== 'string') continue;
            if (e.kind === 'ended' && e.deliveryId !== undefined && typeof e.deliveryId !== 'string') continue;
            entries.push({ seq: row.seq, event: e as unknown as SessionEvent, at: row.at, ...(Number.isSafeInteger(row.turn) && row.turn !== null ? { turn: row.turn } : {}) });
          } catch { /* Malformed history is absent, not inferred. */ }
        }
        const prompts = new Set(entries.filter(e => e.event.kind === 'prompt').map(e => e.seq));
        const deliveries: AgentHandoffDeliveryEvidence[] = [];
        const used = new Set<string>();
        const deliveryAt = db.prepare("SELECT CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB)) <= 512 THEN id END AS id FROM message_delivery WHERE session_id=? AND seq=? AND kind='prompt' AND state='delivered' LIMIT 2");
        const endCount = db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM journal INDEXED BY handoff_source_journal WHERE session_id=? AND seq > ? AND seq <= ? AND type IN ('prompt','ended') AND type='ended' LIMIT ?)`);
        const invalidEnd = db.prepare(`SELECT 1 FROM journal INDEXED BY handoff_source_journal
          WHERE session_id=? AND seq > ? AND seq <= ? AND type IN ('prompt','ended') AND type='ended'
          AND CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) <= ? AND json_valid(payload)
            THEN CASE WHEN json_extract(payload, '$.kind')='ended' AND json_type(payload, '$.deliveryId')='text' THEN 0 ELSE 1 END ELSE 1 END LIMIT 1`);
        const exactEnd = db.prepare(`SELECT seq FROM journal INDEXED BY handoff_source_journal
          WHERE session_id=? AND seq > ? AND seq <= ? AND type IN ('prompt','ended') AND type='ended' AND
          CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) <= ? AND json_valid(payload)
            THEN json_extract(payload, '$.deliveryId') = ? ELSE 0 END LIMIT 2`);
        for (const entry of entries) {
          const event = entry.event;
          if (event.kind !== 'ended' || isUnknownOutcomeEnded(event) || !small(event.deliveryId ?? '') || used.has(event.deliveryId!)) continue;
          const id = event.deliveryId!;
          const matches = db.prepare("SELECT seq FROM message_delivery WHERE id=? AND session_id=? AND kind='prompt' AND state='delivered' LIMIT 2").all(id, sourceSessionId) as { seq: number }[];
          if (matches.length !== 1 || !Number.isSafeInteger(matches[0]!.seq) || !prompts.has(matches[0]!.seq) || matches[0]!.seq >= entry.seq) continue;
          if ((endCount.get(sourceSessionId, matches[0]!.seq, cursor, AGENT_HANDOFF_HISTORY_ROWS + 1) as { n: number }).n > AGENT_HANDOFF_HISTORY_ROWS) continue;
          if (invalidEnd.get(sourceSessionId, matches[0]!.seq, cursor, AGENT_HANDOFF_HISTORY_BYTES)) continue;
          const atPrompt = deliveryAt.all(sourceSessionId, matches[0]!.seq) as { id: string }[];
          const ends = exactEnd.all(sourceSessionId, matches[0]!.seq, cursor, AGENT_HANDOFF_HISTORY_BYTES, id) as { seq: number }[];
          if (atPrompt.length !== 1 || atPrompt[0]!.id !== id || ends.length !== 1 || ends[0]!.seq !== entry.seq) continue;
          used.add(id);
          deliveries.push({ sessionId: sourceSessionId, promptSeq: matches[0]!.seq, deliveryId: id, ended: { seq: entry.seq, outcome: event.outcome } });
        }
        db.exec('COMMIT');
        return { entries, deliveries };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async admitFirst(i: AgentHandoffFirst) {
      return attempt(() => {
        const row = get(i.targetSessionId);
        if (!row || row.actor_id !== i.actorId || ![i.requestKey, i.semanticHash, i.clientMessageId, i.deliveryId].every(small) || !i.text.trim() || !i.decoratedText.trim()) return { kind: 'conflict' } as const;
        const record = convert(row); const target = session(i.targetSessionId);
        if (!target || !session(row.source_id)) return { kind: 'conflict' } as const;
        if (record.first) {
          const event = record.first.event;
          if (record.first.requestKey !== i.requestKey || record.first.semanticHash !== i.semanticHash || event.kind !== 'prompt' || event.text !== i.text || event.clientMessageId !== i.clientMessageId || target.lastSeq < record.first.delivery.seq) return { kind: 'conflict' } as const;
          return { kind: 'replay', record, session: target } as const;
        }
        if (row.startup_state !== 'pending' || !validPins(record.reservation, record.sourceAgent, target) || !pristine(target) || !ingressFree(target.id)) return { kind: 'conflict' } as const;
        const event: SessionEvent = { kind: 'prompt', text: i.text, promptActor: 'account', clientMessageId: i.clientMessageId };
        const next = applyEvent(target, event, i.now);
        const delivery: Delivery = { id: i.deliveryId, sessionId: target.id, seq: next.lastSeq, kind: 'prompt', payload: { text: i.decoratedText, parts: [] }, state: 'queued', attempt: 0, nextAt: i.now, lastError: null, createdAt: i.now, updatedAt: i.now };
        db.prepare('INSERT INTO journal(session_id, seq, type, payload, at, turn) VALUES (?,?,?,?,?,?)').run(target.id, next.lastSeq, event.kind, JSON.stringify(event), i.now, next.turn);
        db.prepare('UPDATE sessions SET last_seq = ?, status = ?, turn = ?, updated_at = ? WHERE id = ?').run(next.lastSeq, next.status, next.turn, next.updatedAt, target.id);
        db.prepare('INSERT INTO message_delivery(id, session_id, seq, kind, payload, state, attempt, next_at, last_error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(delivery.id, delivery.sessionId, delivery.seq, delivery.kind, JSON.stringify(delivery.payload), delivery.state, delivery.attempt, delivery.nextAt, delivery.lastError, i.now, i.now);
        db.prepare('UPDATE agent_handoff SET first_request_key=?, first_hash=?, first_seq=?, first_delivery_id=?, updated_at=? WHERE target_id=?').run(i.requestKey, i.semanticHash, next.lastSeq, delivery.id, i.now, target.id);
        return { kind: 'admitted', record: convert(get(target.id)!), session: next } as const;
      }, { kind: 'conflict' } as const);
    },
    async claimStartup(i: AgentHandoffStartup) {
      return attempt(() => {
        const row = get(i.targetSessionId); const record = row ? convert(row) : null;
        const target = session(i.targetSessionId);
        if (!row || !record?.first || record.first.delivery.id !== i.deliveryId || record.reservation.workerId !== i.workerId || !small(i.attemptId) || !small(i.connectionId) || row.startup_state !== 'pending' || !target || !validPins(record.reservation, record.sourceAgent, target) || !db.prepare(`SELECT 1 FROM message_delivery d WHERE d.id=? AND d.session_id=? AND d.seq=? AND d.kind='prompt' AND d.state='queued' AND d.attempt=0 AND NOT EXISTS (SELECT 1 FROM message_delivery e WHERE e.session_id=d.session_id AND e.kind='prompt' AND e.state IN ('queued','sending','undelivered') AND (e.created_at < d.created_at OR (e.created_at=d.created_at AND e.seq < d.seq) OR (e.created_at=d.created_at AND e.seq=d.seq AND e.id < d.id)))`).get(i.deliveryId, i.targetSessionId, record.first.delivery.seq)) return { kind: 'ignored', record } as const;
        db.prepare("UPDATE agent_handoff SET startup_state='claimed', startup_attempt=?, startup_worker=?, startup_connection=?, updated_at=? WHERE target_id=? AND startup_state='pending'").run(i.attemptId, i.workerId, i.connectionId, i.now, i.targetSessionId);
        return { kind: 'claimed', record: convert(get(i.targetSessionId)!) } as const;
      }, { kind: 'ignored', record: null } as const);
    },
    async settleStartup(i) {
      return attempt(() => {
        const row = get(i.targetSessionId); const record = row ? convert(row) : null;
        if (!row || !record?.first || record.first.delivery.id !== i.deliveryId || row.startup_state !== 'claimed' || row.startup_attempt !== i.attemptId || row.startup_worker !== i.workerId || !small(i.connectionId) || row.startup_connection !== i.connectionId || !['ready', 'failed', 'unknown'].includes(i.state) || !session(i.targetSessionId) || !db.prepare('SELECT 1 FROM message_delivery WHERE id=? AND session_id=? AND seq=?').get(i.deliveryId, i.targetSessionId, record.first.delivery.seq)) return { kind: 'ignored', record } as const;
        if (i.state === 'ready') {
          const ref = i.observed?.agentSessionRef;
          if (!usableNativeRef(ref)) return { kind: 'ignored', record } as const;
          const written = db.prepare('UPDATE sessions SET agent_session=? WHERE id=? AND agent_session IS NULL').run(ref, i.targetSessionId);
          if (written.changes !== 1) return { kind: 'ignored', record } as const;
          const persisted = db.prepare('SELECT agent_session FROM sessions WHERE id=?').get(i.targetSessionId) as { agent_session: unknown } | undefined;
          if (persisted?.agent_session !== ref) throw new Rejected('Native reference was not persisted');
          const options = i.observed?.options === undefined ? null : serializeOptions(i.observed.options);
          if (options !== null) db.prepare('UPDATE sessions SET option_spec=? WHERE id=?').run(options, i.targetSessionId);
        }
        db.prepare('UPDATE agent_handoff SET startup_state=?, updated_at=? WHERE target_id=?').run(i.state, i.now, i.targetSessionId);
        return { kind: 'settled', record: convert(get(i.targetSessionId)!) } as const;
      }, { kind: 'ignored', record: null } as const);
    }
  };
}
