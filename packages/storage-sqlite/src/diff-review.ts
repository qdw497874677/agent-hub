import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { applyEvent, type DiffReviewBatch, type DiffReviewNote, type DiffReviewScope, type DiffReviewStore } from '@agent-hub/domain';
import { toSession } from './mappers.ts';
import { inTransaction } from './tx.ts';

type Draft = Omit<DiffReviewNote, 'delivery'>;
type BatchRow = { batch_id: string; target_id: string; note_ids: string; delivery_id: string; seq: number; turn: number; fingerprint: string };
type NoteRow = { note: string; batch_id: string | null; target_id: string | null; delivery_id: string | null; state: string | null };
const small = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && Buffer.byteLength(s) <= 512;
const validScope = (s: DiffReviewScope) => !!s && [s.actorId, s.taskId, s.sourceSessionId].every(small);
const scopeArgs = (s: DiffReviewScope): [string, string, string] => [s.actorId, s.taskId, s.sourceSessionId];
const validNote = (n: Draft) => !!n && small(n.id) && (n.member === null || small(n.member)) && small(n.path) && small(n.base) && small(n.version) && (n.side === 'old' || n.side === 'new') && Number.isSafeInteger(n.start) && n.start > 0 && Number.isSafeInteger(n.end) && n.end >= n.start && typeof n.text === 'string' && n.text.trim().length > 0 && Buffer.byteLength(n.text) <= 16384;
// Serialize only contract fields, never caller-supplied extras or property order.
const noteJson = (n: Draft) => JSON.stringify({ id: n.id, member: n.member, path: n.path, base: n.base, side: n.side, start: n.start, end: n.end, version: n.version, text: n.text });
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter(k => obj[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}
const batchOf = (r: BatchRow): DiffReviewBatch => ({ batchId: r.batch_id, targetSessionId: r.target_id, noteIds: JSON.parse(r.note_ids) as string[], deliveryId: r.delivery_id, seq: r.seq, turn: r.turn });

export function createSqliteDiffReview(db: DatabaseSync): DiffReviewStore {
  // Only source/task own the records: deleting a target must not erase reviewer feedback.
  db.exec(`CREATE TABLE IF NOT EXISTS diff_review_batch (
    actor_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, batch_id TEXT NOT NULL,
    target_id TEXT NOT NULL, note_ids TEXT NOT NULL, delivery_id TEXT NOT NULL,
    seq INTEGER NOT NULL, turn INTEGER NOT NULL, fingerprint TEXT NOT NULL,
    PRIMARY KEY(actor_id, task_id, source_id, batch_id)
  );
  CREATE TABLE IF NOT EXISTS diff_review_note (
    actor_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, note_id TEXT NOT NULL,
    note TEXT NOT NULL, batch_id TEXT,
    PRIMARY KEY(actor_id, task_id, source_id, note_id)
  );`);
  const live = db.prepare('SELECT * FROM sessions WHERE id=? AND task_id=?');
  const getBatch = db.prepare('SELECT * FROM diff_review_batch WHERE actor_id=? AND task_id=? AND source_id=? AND batch_id=?');
  const getNote = db.prepare('SELECT note, batch_id FROM diff_review_note WHERE actor_id=? AND task_id=? AND source_id=? AND note_id=?');
  return {
    async list(scope) {
      if (!validScope(scope)) return [];
      const rows = db.prepare(`SELECT n.note, n.batch_id, b.target_id, b.delivery_id, d.state
        FROM diff_review_note n LEFT JOIN diff_review_batch b ON b.actor_id=n.actor_id AND b.task_id=n.task_id AND b.source_id=n.source_id AND b.batch_id=n.batch_id
        LEFT JOIN message_delivery d ON d.id=b.delivery_id AND d.session_id=b.target_id AND d.seq=b.seq AND d.kind='prompt'
        WHERE n.actor_id=? AND n.task_id=? AND n.source_id=? ORDER BY n.rowid`).all(...scopeArgs(scope)) as NoteRow[];
      return rows.map(r => ({ ...JSON.parse(r.note) as Draft, delivery: r.batch_id === null ? null : {
        batchId: r.batch_id, targetSessionId: r.target_id!, deliveryId: r.delivery_id!,
        state: (['queued','sending','delivered','undelivered','cancelled'].includes(r.state ?? '') ? r.state : 'unknown') as NonNullable<DiffReviewNote['delivery']>['state']
      } }));
    },
    async save(scope, note) {
      if (!validScope(scope) || !validNote(note)) return false;
      return inTransaction(db, () => {
        if (!live.get(scope.sourceSessionId, scope.taskId)) return false;
        const existing = getNote.get(...scopeArgs(scope), note.id) as { batch_id: string | null } | undefined;
        if (existing?.batch_id != null) return false;
        if (!existing && (db.prepare('SELECT count(*) AS n FROM diff_review_note WHERE actor_id=? AND task_id=? AND source_id=?').get(...scopeArgs(scope)) as { n: number }).n >= 500) return false;
        db.prepare(`INSERT INTO diff_review_note(actor_id,task_id,source_id,note_id,note) VALUES (?,?,?,?,?)
          ON CONFLICT(actor_id,task_id,source_id,note_id) DO UPDATE SET note=excluded.note WHERE diff_review_note.batch_id IS NULL`).run(...scopeArgs(scope), note.id, noteJson(note));
        return true;
      });
    },
    async remove(scope, noteId) {
      if (!validScope(scope) || !small(noteId)) return false;
      return Number(db.prepare('DELETE FROM diff_review_note WHERE actor_id=? AND task_id=? AND source_id=? AND note_id=? AND batch_id IS NULL').run(...scopeArgs(scope), noteId).changes) === 1;
    },
    async batch(scope, batchId) {
      if (!validScope(scope) || !small(batchId)) return null;
      const row = getBatch.get(...scopeArgs(scope), batchId) as BatchRow | undefined;
      return row ? batchOf(row) : null;
    },
    async admit(scope, input) {
      const conflict = { kind: 'conflict' } as const;
      if (!validScope(scope) || !input || !small(input.batchId) || !small(input.targetSessionId) || !Array.isArray(input.noteIds) || input.noteIds.length === 0 || input.noteIds.length > 100 || !input.noteIds.every(small) || new Set(input.noteIds).size !== input.noteIds.length || !Array.isArray(input.expectedNotes) || input.expectedNotes.length !== input.noteIds.length || !input.expectedNotes.every(validNote) || !Number.isSafeInteger(input.now) || !input.event || input.event.kind !== 'prompt' || typeof input.event.text !== 'string') return conflict;
      const ids = [...input.noteIds].sort();
      const expected = new Map(input.expectedNotes.map(n => [n.id, noteJson(n)]));
      if (expected.size !== ids.length || ids.some(id => !expected.has(id))) return conflict;
      let fingerprint: string;
      try {
        const serialized = canonical({ target: input.targetSessionId, notes: ids.map(id => expected.get(id)) });
        if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) return conflict;
        fingerprint = createHash('sha256').update(serialized).digest('hex');
      } catch { return conflict; }
      return inTransaction(db, () => {
        const source = live.get(scope.sourceSessionId, scope.taskId);
        const targetRow = live.get(input.targetSessionId, scope.taskId);
        if (!source || !targetRow) return conflict;
        const target = toSession(targetRow);
        const old = getBatch.get(...scopeArgs(scope), input.batchId) as BatchRow | undefined;
        if (old) return old.fingerprint === fingerprint && old.target_id === input.targetSessionId && old.note_ids === JSON.stringify(ids)
          ? { kind: 'replay' as const, batch: batchOf(old), session: target } : conflict;
        const payload = input.payload as { text?: unknown; parts?: unknown } | null;
        if (!input.event.text.trim() || Buffer.byteLength(input.event.text) > 2 * 1024 * 1024 || !payload || typeof payload !== 'object' || typeof payload.text !== 'string' || !payload.text.trim() || !Array.isArray(payload.parts) || payload.parts.length !== 0) return conflict;
        let eventJson: string; let payloadJson: string;
        try {
          eventJson = JSON.stringify(input.event); payloadJson = JSON.stringify(input.payload);
          if (Buffer.byteLength(eventJson) > 2 * 1024 * 1024 || Buffer.byteLength(payloadJson) > 2 * 1024 * 1024) return conflict;
        } catch { return conflict; }
        if (input.event.clientMessageId !== undefined && (!small(input.event.clientMessageId) || db.prepare(`SELECT 1 FROM journal WHERE session_id=? AND type='prompt' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.clientMessageId')=? ELSE 0 END LIMIT 1`).get(target.id, input.event.clientMessageId))) return conflict;
        for (const id of ids) {
          const row = getNote.get(...scopeArgs(scope), id) as { note: string; batch_id: string | null } | undefined;
          if (!row || row.batch_id !== null || row.note !== expected.get(id)) return conflict;
        }
        const next = applyEvent(target, input.event, input.now);
        const deliveryId = randomUUID();
        db.prepare('INSERT INTO diff_review_batch(actor_id,task_id,source_id,batch_id,target_id,note_ids,delivery_id,seq,turn,fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...scopeArgs(scope), input.batchId, input.targetSessionId, JSON.stringify(ids), deliveryId, next.lastSeq, next.turn, fingerprint);
        const claim = db.prepare('UPDATE diff_review_note SET batch_id=? WHERE actor_id=? AND task_id=? AND source_id=? AND note_id=? AND batch_id IS NULL AND note=?');
        for (const id of ids) if (Number(claim.run(input.batchId, ...scopeArgs(scope), id, expected.get(id)!).changes) !== 1) throw new Error('Diff review note claim failed');
        db.prepare('INSERT INTO journal(session_id,seq,type,payload,at,turn) VALUES (?,?,?,?,?,?)').run(target.id, next.lastSeq, 'prompt', eventJson, input.now, next.turn);
        db.prepare('UPDATE sessions SET last_seq=?,status=?,turn=?,updated_at=? WHERE id=?').run(next.lastSeq, next.status, next.turn, next.updatedAt, target.id);
        db.prepare('INSERT INTO message_delivery(id,session_id,seq,kind,payload,state,attempt,next_at,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(deliveryId, target.id, next.lastSeq, 'prompt', payloadJson, 'queued', 0, input.now, null, input.now, input.now);
        return { kind: 'admitted' as const, batch: { batchId: input.batchId, targetSessionId: input.targetSessionId, noteIds: ids, deliveryId, seq: next.lastSeq, turn: next.turn }, session: next };
      });
    }
  };
}
