import type { DatabaseSync } from 'node:sqlite';
import { applyEvent, type BranchAttempt, type BranchAttemptStore, type BranchSettlement, type Delivery, type Session, type SessionEvent } from '@agent-hub/domain';
import { inTransaction } from './tx.ts';
import { toSession } from './mappers.ts';

export function ensureBranchAttemptTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS branch_attempt (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, worker_id TEXT NOT NULL,
    brief TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
}

export function createSqliteBranchAttempts(db: DatabaseSync, saveSession: (session: Session) => void): BranchAttemptStore {
  const get = db.prepare('SELECT * FROM branch_attempt WHERE session_id = ?');
  const getSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const insert = db.prepare('INSERT INTO branch_attempt VALUES (?, ?, ?, ?, ?, ?, ?)');
  const update = db.prepare("UPDATE branch_attempt SET state = ?, updated_at = ?, brief = ? WHERE id = ? AND state = 'pending'");
  const journal = db.prepare('INSERT INTO journal(session_id, seq, type, payload, at, turn) VALUES (?, ?, ?, ?, ?, ?)');
  const cursor = db.prepare('UPDATE sessions SET last_seq = ?, status = ?, turn = ?, updated_at = ? WHERE id = ?');
  const settleSession = db.prepare('UPDATE sessions SET agent_session = ?, status = ?, updated_at = ? WHERE id = ?');
  const enqueue = db.prepare('INSERT INTO message_delivery(id, session_id, seq, kind, payload, state, attempt, next_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  type Row = { id: string; session_id: string; worker_id: string; brief: string; state: BranchAttempt['state']; created_at: number; updated_at: number };
  type StoredBrief = BranchAttempt['brief'] & { __branchProof?: { sourceRef?: string; settledRef?: string } };
  const convert = (r: Row): BranchAttempt => {
    const { __branchProof, ...brief } = JSON.parse(r.brief) as StoredBrief;
    return { id: r.id, sessionId: r.session_id, workerId: r.worker_id, brief, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at, settledAgentSessionRef: __branchProof?.settledRef };
  };
  return {
    async stage(session, attempt) {
      if (session.id !== attempt.sessionId || session.workerId !== attempt.workerId || attempt.state !== 'pending' || session.agentSessionRef !== null) throw new Error('invalid branch attempt');
      inTransaction(db, () => {
        if (getSession.get(session.id)) throw new Error('branch child already exists');
        let sourceRef: string | undefined;
        if (session.origin.kind === 'fork') {
          const source = getSession.get(session.origin.fromSessionId);
          const stored = source ? toSession(source).agentSessionRef : null;
          if (!stored?.trim() || stored.trim().toLowerCase() === 'pending' || Buffer.byteLength(stored) > 512) throw new Error('branch source reference unavailable');
          sourceRef = stored;
          const plannedRef = attempt.sourceAgentSessionRef;
          if (plannedRef !== undefined && plannedRef !== sourceRef) throw new Error('branch source reference changed');
        }
        saveSession(session);
        insert.run(attempt.id, attempt.sessionId, attempt.workerId, JSON.stringify({ ...attempt.brief, __branchProof: { sourceRef } }), attempt.state, attempt.createdAt, attempt.updatedAt);
      });
    },
    async bySession(sessionId) {
      const row = get.get(sessionId) as Row | undefined;
      return row ? convert(row) : null;
    },
    async settle(sessionId, attemptId, workerId, receipt, now): Promise<BranchSettlement> {
      return inTransaction(db, () => {
        const row = get.get(sessionId) as Row | undefined;
        if (!row || row.id !== attemptId || row.worker_id !== workerId || row.state !== 'pending' || !receipt || !['native', 'plain', 'both_failed'].includes(receipt.outcome)) return { kind: 'ignored' };
        if (receipt.outcome !== 'both_failed' && (typeof receipt.agentSessionRef !== 'string' || !receipt.agentSessionRef.trim() || receipt.agentSessionRef.trim().toLowerCase() === 'pending' || Buffer.byteLength(receipt.agentSessionRef, 'utf8') > 512)) return { kind: 'ignored' };
        const sessionRow = getSession.get(sessionId);
        if (!sessionRow) return { kind: 'ignored' };
        const session = toSession(sessionRow);
        const brief = JSON.parse(row.brief) as StoredBrief;
        if (session.origin.kind === 'fork' && (!brief.__branchProof?.sourceRef || (receipt.outcome !== 'both_failed' && receipt.agentSessionRef === brief.__branchProof.sourceRef))) return { kind: 'ignored' };
        let next: Session = receipt.outcome === 'both_failed'
          ? { ...session, status: 'failed', updatedAt: now }
          : { ...session, agentSessionRef: receipt.agentSessionRef, updatedAt: now };
        settleSession.run(next.agentSessionRef, next.status, now, sessionId);
        let event: SessionEvent | null = null;
        let delivery: Delivery | null = null;
        if (receipt.outcome === 'plain') {
          event = { kind: 'prompt', text: brief.text, handoff: brief.stats, promptActor: 'system' };
          next = applyEvent(next, event, now);
          delivery = { id: `branch_brief_${attemptId}`, sessionId, seq: next.lastSeq, kind: 'prompt', payload: { text: brief.text, parts: [] }, state: 'queued', attempt: 0, nextAt: now, lastError: null, createdAt: now, updatedAt: now };
          journal.run(sessionId, next.lastSeq, event.kind, JSON.stringify(event), now, next.turn);
          cursor.run(next.lastSeq, next.status, next.turn, next.updatedAt, sessionId);
          enqueue.run(delivery.id, sessionId, delivery.seq, delivery.kind, JSON.stringify(delivery.payload), delivery.state, delivery.attempt, delivery.nextAt, delivery.lastError, now, now);
        }
        brief.__branchProof = { sourceRef: brief.__branchProof?.sourceRef, ...(receipt.outcome === 'both_failed' ? {} : { settledRef: receipt.agentSessionRef }) };
        update.run(receipt.outcome, now, JSON.stringify(brief), attemptId);
        return { kind: 'settled', session: next, event, delivery };
      });
    }
  };
}
