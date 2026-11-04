import type { Delivery, DeliveryKind } from '../delivery.ts';

/** 送达队列（ADR 0031 D2）：落 SQLite，hub 重启后接着送。 */
export interface DeliveryQueue {
  save(delivery: Delivery): Promise<void>;
  byId(id: string): Promise<Delivery | null>;
  /** 某会话还没送达的（queued/sending/undelivered），按 createdAt、seq 排序。 */
  pendingFor(sessionId: string): Promise<Delivery[]>;
  /** 每个会话最靠前的那条 queued 且 nextAt <= now 的。 */
  due(now: number): Promise<Delivery[]>;
  /** 交接简报这类挂起的（held）。 */
  held(sessionId: string, kind: DeliveryKind): Promise<Delivery | null>;
  /** 某会话最近的送达记录（含已送达），给 UI 用。 */
  recent(sessionId: string, limit: number): Promise<Delivery[]>;
  /** Worker 重连：把 queued 的都改成现在就到期；返回改了几条。 */
  wakeAll(now: number): Promise<number>;
  /** 进程重启：上次停在 sending 的退回 queued。 */
  recoverSending(now: number): Promise<number>;
}
