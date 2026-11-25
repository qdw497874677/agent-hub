import type { DatabaseSync } from 'node:sqlite';
import { UNKNOWN_OUTCOME_MARKER } from '@agent-hub/domain';

/** Maximum relevant journal rows plus delivery rows inspected per proof. */
export const AGENT_HANDOFF_SOURCE_BUDGET = 512;
export const AGENT_HANDOFF_SOURCE_BYTES = 8 * 1024 * 1024;

export type AgentHandoffSourceResult =
  | { readonly kind: 'ready'; readonly cursor: number }
  | { readonly kind: 'missing' | 'cursor_changed' | 'busy' | 'unproven' };

/** Explicit setup, outside the admission transaction. Never creates or migrates tables. */
export function installAgentHandoffSourceIndexes(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS handoff_source_delivery ON message_delivery(session_id, seq);
    CREATE INDEX IF NOT EXISTS handoff_source_journal ON journal(session_id, seq) WHERE type IN ('prompt', 'ended');
    CREATE INDEX IF NOT EXISTS handoff_first_ended ON journal(session_id,
      CASE WHEN typeof(payload)='text' AND json_valid(payload) AND json_type(payload,'$.deliveryId')='text'
        THEN json_extract(payload,'$.deliveryId') END, seq) WHERE type='ended';
    CREATE INDEX IF NOT EXISTS handoff_source_message ON agent_messages(target_session_id, status);
    CREATE INDEX IF NOT EXISTS handoff_source_branch ON branch_attempt(session_id);
  `);
}

type DeliveryRow = { id: unknown; seq: unknown; kind: unknown; state: unknown; attempt: unknown };
type EventRow = { seq: unknown; type: unknown; valid: unknown; kind: unknown; delivery_id: unknown; outcome: unknown; reason_type: unknown; unknown_outcome: unknown };
const positiveSeq = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const smallId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 512;

/**
 * Read-only, synchronous, and deliberately does not start a transaction. The caller must
 * hold BEGIN IMMEDIATE continuously through its reservation and derived-session insert.
 * Indexes must already be installed; missing/old schema and SQLite errors fail closed.
 * Success contains no source content. This is not authorization or body eligibility.
 */
export function prepareAgentHandoffSource(db: DatabaseSync, sessionId: string, expectedCursor: number): AgentHandoffSourceResult {
  const unproven = { kind: 'unproven' } as const;
  if (!smallId(sessionId) || !Number.isSafeInteger(expectedCursor) || expectedCursor < 0) return unproven;
  try {
    const session = db.prepare(`SELECT last_seq, CASE
      WHEN agent_session IS NULL THEN 'absent'
      WHEN typeof(agent_session) = 'text' AND length(CAST(agent_session AS BLOB)) <= 512
        AND trim(agent_session) <> '' AND lower(trim(agent_session)) <> 'pending' THEN 'valid'
      ELSE 'invalid' END AS ref_status FROM sessions WHERE id = ?`).get(sessionId) as { last_seq: unknown; ref_status: unknown } | undefined;
    if (!session) return { kind: 'missing' };
    if (typeof session.last_seq !== 'number' || !Number.isSafeInteger(session.last_seq) || session.last_seq < 0) return unproven;
    if (session.last_seq !== expectedCursor) return { kind: 'cursor_changed' };
    if (session.ref_status === 'invalid') return unproven;
    if (db.prepare('SELECT 1 FROM journal WHERE session_id = ? AND seq > ? LIMIT 1').get(sessionId, expectedCursor)) return unproven;

    const branch = db.prepare("SELECT CASE WHEN state IN ('pending','both_failed','native','plain') THEN state END AS state FROM branch_attempt INDEXED BY handoff_source_branch WHERE session_id = ? LIMIT 2").all(sessionId) as { state: unknown }[];
    if (branch.length > 1) return unproven;
    if (branch.length) {
      if (branch[0]!.state === 'pending' || branch[0]!.state === 'both_failed') return { kind: 'busy' };
      if (!['native', 'plain'].includes(String(branch[0]!.state)) || session.ref_status !== 'valid') return unproven;
    }
    if (db.prepare(`SELECT 1 FROM agent_messages INDEXED BY handoff_source_message
      WHERE target_session_id = ? AND status IN ('queued','held','awaiting_approval','delivered') LIMIT 1`).get(sessionId)) return { kind: 'busy' };

    const deliveries = db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) <= 512 THEN id END AS id, seq,
      CASE WHEN kind IN ('prompt','handoff_brief') THEN kind END AS kind,
      CASE WHEN state IN ('queued','sending','undelivered','held','delivered','cancelled') THEN state END AS state,
      attempt FROM message_delivery INDEXED BY handoff_source_delivery
      WHERE session_id = ? LIMIT ?`).all(sessionId, AGENT_HANDOFF_SOURCE_BUDGET + 1) as DeliveryRow[];
    if (deliveries.length > AGENT_HANDOFF_SOURCE_BUDGET) return unproven;
    // A legacy brief can still be active even though it is not a prompt.
    if (deliveries.some(d => ['queued', 'sending', 'undelivered', 'held'].includes(String(d.state)))) return { kind: 'busy' };
    const prompts = new Map<number, DeliveryRow>();
    const ids = new Map<string, DeliveryRow>();
    for (const d of deliveries) {
      if (!positiveSeq(d.seq) || d.seq > expectedCursor || !smallId(d.id) || !['prompt', 'handoff_brief'].includes(String(d.kind)) || !['delivered', 'cancelled'].includes(String(d.state)) || typeof d.attempt !== 'number' || !Number.isSafeInteger(d.attempt) || d.attempt < 0) return unproven;
      // Cancellation permits previously undelivered messages; attempt may have been reset.
      // There is no immutable no-send receipt, so even attempt=0 is insufficient.
      if (d.state === 'cancelled' || d.kind !== 'prompt') return unproven;
      if (prompts.has(d.seq) || ids.has(d.id)) return unproven;
      prompts.set(d.seq, d); ids.set(d.id, d);
    }
    // Bound total inspected bytes before any per-event JSON work. The limited subquery
    // reads metadata only, and the existing row budget makes the sum finite.
    const size = db.prepare(`SELECT count(*) AS n, COALESCE(sum(bytes),0) AS bytes FROM (
      SELECT length(CAST(payload AS BLOB)) AS bytes FROM journal INDEXED BY handoff_source_journal
      WHERE session_id=? AND type IN ('prompt','ended') LIMIT ?)`)
      .get(sessionId, AGENT_HANDOFF_SOURCE_BUDGET - deliveries.length + 1) as { n: number; bytes: number };
    if (size.n + deliveries.length > AGENT_HANDOFF_SOURCE_BUDGET || size.bytes > AGENT_HANDOFF_SOURCE_BYTES) return unproven;
    const events = db.prepare(`SELECT seq, type,
      CASE WHEN length(CAST(payload AS BLOB)) <= 1048576 THEN json_valid(payload) ELSE 0 END AS valid,
      CASE WHEN length(CAST(payload AS BLOB)) <= 1048576 AND json_valid(payload) THEN CASE WHEN json_extract(payload, '$.kind') IN ('prompt','ended') THEN json_extract(payload, '$.kind') END END AS kind,
      CASE WHEN length(CAST(payload AS BLOB)) <= 1048576 AND json_valid(payload) THEN CASE WHEN json_type(payload, '$.deliveryId') = 'text' AND length(CAST(json_extract(payload, '$.deliveryId') AS BLOB)) <= 512 THEN json_extract(payload, '$.deliveryId') END END AS delivery_id,
      CASE WHEN length(CAST(payload AS BLOB)) <= 1048576 AND json_valid(payload) THEN CASE WHEN json_extract(payload, '$.outcome') IN ('done','failed','interrupted','stopped') THEN json_extract(payload, '$.outcome') END END AS outcome,
      CASE WHEN length(CAST(payload AS BLOB)) <= 1048576 AND json_valid(payload) THEN json_type(payload, '$.reason') END AS reason_type,
      CASE WHEN length(CAST(payload AS BLOB)) <= 1048576 AND json_valid(payload) THEN CASE WHEN json_type(payload, '$.reason') = 'text' THEN instr(json_extract(payload, '$.reason'), ?) ELSE 0 END ELSE 0 END AS unknown_outcome
      FROM journal INDEXED BY handoff_source_journal
      WHERE session_id = ? AND type IN ('prompt', 'ended') LIMIT ?`).all(UNKNOWN_OUTCOME_MARKER, sessionId, AGENT_HANDOFF_SOURCE_BUDGET - deliveries.length + 1) as EventRow[];
    if (events.length + deliveries.length > AGENT_HANDOFF_SOURCE_BUDGET) return unproven;
    const seenPrompts = new Set<number>();
    const seenEnds = new Set<string>();
    for (const e of events) {
      if (!positiveSeq(e.seq) || e.seq > expectedCursor || e.valid !== 1 || e.kind !== e.type) return unproven;
      if (e.type === 'prompt') {
        if (!prompts.has(e.seq) || seenPrompts.has(e.seq)) return unproven;
        seenPrompts.add(e.seq);
      } else {
        if (!smallId(e.delivery_id) || !ids.has(e.delivery_id) || seenEnds.has(e.delivery_id) || !['done', 'failed', 'interrupted', 'stopped'].includes(String(e.outcome)) || (e.reason_type !== null && e.reason_type !== 'text') || e.unknown_outcome !== 0) return unproven;
        const delivery = ids.get(e.delivery_id)!;
        if (e.seq <= (delivery.seq as number)) return unproven;
        seenEnds.add(e.delivery_id);
      }
    }
    if (seenPrompts.size !== prompts.size || seenEnds.size !== prompts.size) return unproven;
    return { kind: 'ready', cursor: expectedCursor };
  } catch {
    return unproven;
  }
}
