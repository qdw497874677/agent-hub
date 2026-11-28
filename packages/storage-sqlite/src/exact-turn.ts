import type { DatabaseSync } from 'node:sqlite';

export const EXACT_TURN_ROW_LIMIT = 1024;
export const EXACT_TURN_PAYLOAD_LIMIT = 65536;
export type ExactTurnStatus = {
  sessionId: string; turn: number; promptSeq: number | null; deliveryId: string | null;
  deliveryState: 'queued' | 'sending' | 'delivered' | 'undelivered' | 'cancelled' | 'held' | null;
  outcome: 'done' | 'failed' | 'stopped' | 'interrupted' | null;
  outcomeUnknown: boolean; endedSeq: number | null;
  status: 'pending' | 'terminal' | 'unknown'; reason: string;
};
export type ExactTurnReader = (sessionId: string, turn: number) => ExactTurnStatus;
const idOk = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && Buffer.byteLength(id) <= 512 && !/[\u0000-\u001f\u007f]/.test(id);
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
type Row = { source: string; seq: unknown; turn: unknown; id: unknown; state: unknown; attempt: unknown; payload: unknown; bytes: unknown };

/** Read one consistent SQLite statement snapshot. Never returns journal/delivery content.
 * Exhausting either bounded scan or encountering ambiguous evidence is unknown. */
export function createSqliteExactTurn(db: DatabaseSync): ExactTurnReader {
  const sql = `WITH j AS (
      SELECT seq, turn, type, CASE WHEN (type='ended' OR (type='prompt' AND turn=?)) AND typeof(payload)='text' AND length(CAST(payload AS BLOB)) <= ${EXACT_TURN_PAYLOAD_LIMIT} THEN payload END AS payload,
        length(CAST(payload AS BLOB)) AS bytes FROM journal
      WHERE session_id=? AND type IN ('prompt','ended') ORDER BY seq LIMIT ${EXACT_TURN_ROW_LIMIT + 1}
    ), d AS (
      SELECT seq, id, state, attempt FROM message_delivery WHERE session_id=? AND kind='prompt' LIMIT ${EXACT_TURN_ROW_LIMIT + 1}
    )
    SELECT type AS source, seq, turn, NULL AS id, NULL AS state, NULL AS attempt, payload, bytes FROM j
    UNION ALL SELECT 'delivery', seq, NULL, id, state, attempt, NULL, NULL FROM d`;
  return (sessionId, turn) => {
    const result: ExactTurnStatus = { sessionId, turn, promptSeq: null, deliveryId: null, deliveryState: null, outcome: null, outcomeUnknown: true, endedSeq: null, status: 'unknown', reason: 'insufficient_evidence' };
    if (!idOk(sessionId) || !positive(turn)) return { ...result, reason: 'invalid_input' };
    try {
      const rows = db.prepare(sql).all(turn, sessionId, sessionId) as Row[];
      const events = rows.filter(r => r.source !== 'delivery');
      const deliveries = rows.filter(r => r.source === 'delivery');
      if (events.length > EXACT_TURN_ROW_LIMIT || deliveries.length > EXACT_TURN_ROW_LIMIT) return { ...result, reason: 'scan_limit' };
      const prompts = events.filter(r => r.source === 'prompt' && r.turn === turn);
      if (prompts.length !== 1 || !positive(prompts[0]?.seq)) return { ...result, reason: prompts.length > 1 ? 'ambiguous_prompt' : 'prompt_unavailable' };
      result.promptSeq = prompts[0].seq as number;
      try {
        const p: unknown = typeof prompts[0].payload === 'string' ? JSON.parse(prompts[0].payload) : null;
        if (!p || typeof p !== 'object' || Array.isArray(p) || (p as Record<string, unknown>).kind !== 'prompt') return { ...result, reason: 'invalid_prompt' };
      } catch { return { ...result, reason: 'invalid_prompt' }; }
      const matches = deliveries.filter(r => r.seq === result.promptSeq);
      if (matches.length !== 1 || !idOk(matches[0]?.id)) return { ...result, reason: matches.length > 1 ? 'ambiguous_delivery' : 'delivery_unavailable' };
      const d = matches[0]!;
      result.deliveryId = d.id as string;
      if (!['queued','sending','delivered','undelivered','cancelled','held'].includes(String(d.state)) || typeof d.attempt !== 'number' || !Number.isSafeInteger(d.attempt) || d.attempt < 0) return { ...result, reason: 'invalid_delivery' };
      result.deliveryState = d.state as ExactTurnStatus['deliveryState'];
      if (d.attempt > 1 || (d.attempt > 0 && d.state !== 'delivered')) return { ...result, reason: 'retry_ambiguous' };
      let end: { seq: number; outcome: ExactTurnStatus['outcome'] } | null = null;
      for (const event of events) {
        if (event.source !== 'ended') continue;
        let value: unknown;
        try { value = typeof event.payload === 'string' ? JSON.parse(event.payload) : null; } catch { value = null; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          if (positive(event.seq) && event.seq > result.promptSeq) return { ...result, reason: 'unattributed_end' };
          continue;
        }
        const e = value as Record<string, unknown>;
        if (!idOk(e.deliveryId)) {
          if (positive(event.seq) && event.seq > result.promptSeq) return { ...result, reason: 'unattributed_end' };
          continue;
        }
        if (e.deliveryId !== result.deliveryId) continue;
        if (!positive(event.seq) || event.seq <= result.promptSeq || end) return { ...result, reason: 'contradictory_end' };
        if (e.kind !== 'ended' || !['done','failed','stopped','interrupted'].includes(String(e.outcome)) || ('reason' in e && typeof e.reason !== 'string')) return { ...result, reason: 'invalid_end' };
        if ('outcomeUnknown' in e || (typeof e.reason === 'string' && e.reason.includes('outcome_unknown'))) return { ...result, reason: 'outcome_unknown' };
        end = { seq: event.seq, outcome: e.outcome as ExactTurnStatus['outcome'] };
      }
      if (end) {
        // Only the reconciled delivery is terminal. A still-sending row can be a
        // retry of the same identity, and attempt can be reset by manual retry.
        if (d.state !== 'delivered' || d.attempt !== 1) return { ...result, reason: 'delivery_unconfirmed' };
        return { ...result, endedSeq: end.seq, outcome: end.outcome, outcomeUnknown: false, status: 'terminal', reason: 'ended' };
      }
      if (d.state === 'cancelled' || d.state === 'undelivered' || d.state === 'delivered') return { ...result, reason: 'delivery_unconfirmed' };
      return { ...result, outcomeUnknown: false, status: 'pending', reason: `delivery_${d.state}` };
    } catch {
      return { ...result, reason: 'evidence_unavailable' };
    }
  };
}
