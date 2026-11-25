import type { Session } from '../session.ts';
import type { Delivery } from '../delivery.ts';
import type { JournalEntry, SessionEvent } from '../event.ts';
import type { RuntimeOption } from '../option.ts';

export interface AgentHandoffDeliveryEvidence {
  readonly sessionId: string;
  readonly promptSeq: number;
  readonly deliveryId: string;
  readonly ended: { readonly seq: number; readonly outcome: 'done' | 'stopped' | 'interrupted' | 'failed' | 'unknown' };
}

/** Hashes are canonical semantic hashes computed by the validated service, not client claims. */
export interface AgentHandoffReservation {
  readonly actorId: string; readonly sourceSessionId: string; readonly sourceCursor: number;
  readonly requestKey: string; readonly semanticHash: string; readonly target: Session;
  readonly projectId: string; readonly taskId: string; readonly workspaceId: string;
  readonly workerId: string; readonly path: string; readonly targetAgent: string;
  readonly targetModel: string; readonly now: number;
}
export interface AgentHandoffFirst {
  readonly targetSessionId: string; readonly actorId: string; readonly requestKey: string;
  readonly semanticHash: string; readonly text: string; readonly decoratedText: string;
  readonly clientMessageId: string; readonly deliveryId: string; readonly now: number;
}
export interface AgentHandoffRecord {
  readonly reservation: AgentHandoffReservation;
  readonly sourceAgent: string;
  readonly first: { readonly requestKey: string; readonly semanticHash: string; readonly event: SessionEvent; readonly delivery: Delivery } | null;
  readonly startup: { readonly state: 'pending' | 'claimed' | 'ready' | 'failed' | 'unknown'; readonly attemptId: string | null; readonly workerId: string | null; readonly connectionId: string | null };
}
export interface AgentHandoffStartup {
  readonly targetSessionId: string; readonly deliveryId: string; readonly attemptId: string;
  readonly workerId: string; readonly connectionId: string; readonly now: number;
}
export interface AgentHandoffStore {
  reserve(input: AgentHandoffReservation): Promise<{ kind: 'created' | 'replay'; record: AgentHandoffRecord } | { kind: 'conflict' }>;
  byTarget(targetSessionId: string): Promise<AgentHandoffRecord | null>;
  /** Exact durable lineage lookup; authorization and semantic hash comparison are caller responsibilities. */
  byRequest(actorId: string, sourceSessionId: string, requestKey: string): Promise<AgentHandoffRecord | null>;
  /** Bounded slice only; absent entries and evidence do not establish completeness. */
  historyFor(sourceSessionId: string, cursor: number): Promise<{ entries: readonly JournalEntry[]; deliveries: readonly AgentHandoffDeliveryEvidence[] }>;
  /** Exact durable delivery and unique known-outcome end; not a live-readiness check. */
  firstEnded(sessionId: string, deliveryId: string, seq: number): Promise<boolean>;
  admitFirst(input: AgentHandoffFirst): Promise<{ kind: 'admitted' | 'replay'; record: AgentHandoffRecord; session: Session } | { kind: 'conflict' }>;
  claimStartup(input: AgentHandoffStartup): Promise<{ kind: 'claimed' | 'ignored'; record: AgentHandoffRecord | null }>;
  /** The caller must validate a ready receipt against the current worker socket before calling.
   * A settled ready result proves its usable observed native reference was persisted atomically;
   * absent, invalid or already-populated references leave the claim unchanged. */
  settleStartup(input: AgentHandoffStartup & { readonly state: 'ready' | 'failed' | 'unknown'; readonly observed?: { readonly agentSessionRef?: string; readonly options?: readonly RuntimeOption[] } }): Promise<{ kind: 'settled' | 'ignored'; record: AgentHandoffRecord | null }>;
}
