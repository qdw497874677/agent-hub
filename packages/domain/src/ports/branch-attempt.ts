import type { HandoffResult } from '../handoff.ts';
import type { Session } from '../session.ts';
import type { SessionEvent } from '../event.ts';
import type { Delivery } from '../delivery.ts';

export type BranchOutcome = 'native' | 'plain' | 'both_failed';
export type BranchReceipt = { readonly outcome: 'native' | 'plain'; readonly agentSessionRef: string } | { readonly outcome: 'both_failed' };
export interface BranchAttempt {
  readonly id: string;
  readonly sessionId: string;
  readonly workerId: string;
  readonly brief: HandoffResult;
  readonly state: 'pending' | BranchOutcome;
  /** Source reference captured when a native branch is staged. */
  readonly sourceAgentSessionRef?: string;
  /** Durable, exact child reference confirmed by settlement; absent on legacy rows. */
  readonly settledAgentSessionRef?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type BranchSettlement = { readonly kind: 'ignored' } | {
  readonly kind: 'settled';
  readonly session: Session;
  readonly event: SessionEvent | null;
  readonly delivery: Delivery | null;
};

/** stage and settle are indivisible with the session/journal/delivery writes. */
export interface BranchAttemptStore {
  stage(session: Session, attempt: BranchAttempt): Promise<void>;
  bySession(sessionId: string): Promise<BranchAttempt | null>;
  settle(sessionId: string, attemptId: string, workerId: string, receipt: BranchReceipt, now: number): Promise<BranchSettlement>;
}
