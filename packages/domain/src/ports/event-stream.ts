import type { Seq, SessionId } from '../ids.ts';
import type { SessionEvent } from '../event.ts';
import type { SessionStatus } from '../session.ts';

export interface SessionStreamFrame {
  readonly sessionId: SessionId;
  readonly seq: Seq;
  readonly event: SessionEvent;
  readonly status: SessionStatus;
}

/** 被驱动端口：领域不认识 WS，它只把帧交出去。 */
export interface SessionEventStream {
  publish(frame: SessionStreamFrame): void;
  subscribe(listener: (frame: SessionStreamFrame) => void): () => void;
}
