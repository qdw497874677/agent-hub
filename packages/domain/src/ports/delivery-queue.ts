import type { Delivery, DeliveryKind } from '../delivery.ts';

/** 认领结果：send 为真才可以立刻派给 worker，否则调用方必须停手，让队首先走。 */
export interface PromptClaim {
  readonly delivery: Delivery;
  /** 这次写入的是队首，且前面没有未完成项。 */
  readonly send: boolean;
}

/** 送达队列（ADR 0031 D2）：落 SQLite，hub 重启后接着送。 */
export interface DeliveryQueue {
  save(delivery: Delivery): Promise<void>;
  /**
   * 原子认领队首：只有这条 prompt 是会话队首（没有更早的 queued/sending/undelivered），
   * 且同一会话没有别的 sending 时，才把状态翻成 sending，占用这一轮。
   * 返回 false 说明另一个入口（定时泵 / 回合结束 / 立即重试）已经抢走了，或者前面还有没走完的消息，
   * 调用方都不能派发。
   */
  claimSend(id: string, now: number): Promise<boolean>;
  /**
   * 完成一次认领：只有 id 属于该会话且仍在 sending 时才改成 delivered，attempt + 1，清掉 nextAt / lastError。
   * 返回 false（重复完成 / 会话不符 / 已经不是 sending）时不改任何行。
   */
  finishSending(sessionId: string, id: string, now: number): Promise<boolean>;
  /** 这个会话当前真正在飞的那条 prompt（state = sending）；没有就 null。精确查询，不受 recent 窗口限制。 */
  inFlight(sessionId: string): Promise<Delivery | null>;
  /**
   * 上一轮还在跑：把这条按条件改回 queued 并定下一次检查时间。
   * 只有它还在 queued/undelivered 时才写，返回 false 说明别的入口已经接管，调用方不能再动它。
   */
  reschedule(id: string, now: number, nextAt: number): Promise<boolean>;
  /**
   * 把一条 prompt 放进队列，并在同一次写入里决定它是不是队首。
   * 两条同时进来时只有一条 send 为真；另一条停在 queued，不派给 worker。
   * 若队首是「未送达」，先把它改回 queued 并给满重试，新的这一条排在后面。
   */
  claimPrompt(incoming: Delivery): Promise<PromptClaim>;
  byId(id: string): Promise<Delivery | null>;
  /** 某会话还没送达的（queued/sending/undelivered），按 createdAt、seq 排序。 */
  pendingFor(sessionId: string): Promise<Delivery[]>;
  /** 每个会话最靠前的那条 queued 且 nextAt <= now 的。 */
  due(now: number): Promise<Delivery[]>;
  /** 交接简报这类挂起的（held）。 */
  held(sessionId: string, kind: DeliveryKind): Promise<Delivery | null>;
  /** 某会话最近的送达记录（含已送达），给 UI 用。 */
  recent(sessionId: string, limit: number): Promise<Delivery[]>;
  /**
   * 送出去之后就再没动静的那些（state 仍是 delivered、updatedAt 早于 cutoff）。
   * 用来收掉「分类没有在机器上跑起来」的回合：不然它一直占着队首，后面的消息永远排着。
   */
  deliveredBefore(cutoff: number, limit: number): Promise<Delivery[]>;
  /** Worker 重连：把 queued 的都改成现在就到期；返回改了几条。 */
  wakeAll(now: number): Promise<number>;
}
