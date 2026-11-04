import type { Phase } from '../attention.ts';

/** 「人已看过」（ADR 0031 D1）：按 (账号, 会话, 阶段, 进入时刻) 记；阶段变了自然重新上榜。 */
export interface AttentionAck {
  readonly sessionId: string;
  readonly phase: Phase;
  readonly since: number;
}
export interface AttentionStore {
  ack(accountId: string, ack: AttentionAck, at: number): Promise<void>;
  acks(accountId: string): Promise<readonly AttentionAck[]>;
}
