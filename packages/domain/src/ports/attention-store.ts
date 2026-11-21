import type { Phase } from '../attention.ts';

/** 「人已看过」（ADR 0031 D1）：按 (账号, 会话, 阶段, 进入时刻) 记；阶段变了自然重新上榜。 */
export interface AttentionAck {
  readonly sessionId: string;
  readonly phase: Phase;
  readonly since: number;
}
export interface AttentionStore {
  /** 记一条；返回这一条的收据（首次记下时的时刻，重复记返回原来那条的）。 */
  ack(accountId: string, ack: AttentionAck, at: number): Promise<number>;
  /**
   * 撤销一条（只按账号 + 精确元组删）。给了 receipt 就只在收据一致时删，
   * 挡住「迟到的撤销」把之后重新记下的同一条删掉。返回是否真的删掉了。
   */
  unack(accountId: string, ack: AttentionAck, receipt?: number): Promise<boolean>;
  acks(accountId: string): Promise<readonly AttentionAck[]>;
}
