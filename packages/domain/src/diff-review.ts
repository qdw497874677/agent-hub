import type { Delivery } from './delivery.ts';
import type { SessionEvent } from './event.ts';
import type { Session } from './session.ts';

export interface DiffReviewScope { actorId: string; taskId: string; sourceSessionId: string }
export interface DiffReviewAnchor { member: string | null; path: string; base: string; side: 'old' | 'new'; start: number; end: number; version: string }
export type DiffReviewNote = DiffReviewAnchor & { id: string; text: string; delivery: null | { batchId: string; targetSessionId: string; deliveryId: string; state: 'queued' | 'sending' | 'delivered' | 'undelivered' | 'cancelled' | 'unknown' } };
export interface DiffReviewBatch { batchId: string; targetSessionId: string; noteIds: readonly string[]; deliveryId: string; seq: number; turn: number }
export interface DiffReviewStore {
  list(scope: DiffReviewScope): Promise<readonly DiffReviewNote[]>;
  save(scope: DiffReviewScope, note: Omit<DiffReviewNote, 'delivery'>): Promise<boolean>;
  remove(scope: DiffReviewScope, noteId: string): Promise<boolean>;
  batch(scope: DiffReviewScope, batchId: string): Promise<DiffReviewBatch | null>;
  admit(scope: DiffReviewScope, input: { batchId: string; targetSessionId: string; noteIds: readonly string[]; expectedNotes: readonly Omit<DiffReviewNote, 'delivery'>[]; event: Extract<SessionEvent, { kind: 'prompt' }>; payload: Delivery['payload']; now: number }): Promise<{ kind: 'admitted' | 'replay'; batch: DiffReviewBatch; session: Session } | { kind: 'conflict' }>;
}
