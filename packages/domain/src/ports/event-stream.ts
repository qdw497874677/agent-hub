import type { Seq, SessionId } from '../ids.ts';
import type { SessionEvent } from '../event.ts';
import type { SessionStatus } from '../session.ts';

export interface SessionStreamFrame {
  readonly sessionId: SessionId;
  readonly seq: Seq;
  /**
   * `null` 表示「只有状态变了，没有新事件」。
   * 没有这一档的话，用户发出提问到 agent 说出第一个字之间，界面会一直显示上一次的状态——
   * 明明在跑，却写着「完成」。
   */
  readonly event: SessionEvent | null;
  readonly status: SessionStatus;
}

/** 被驱动端口：领域不认识 WS，它只把帧交出去。 */
export interface SessionEventStream {
  publish(frame: SessionStreamFrame): void;
  subscribe(listener: (frame: SessionStreamFrame) => void): () => void;
}
