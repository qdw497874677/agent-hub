/**
 * 消息送达（ADR 0031 D2）：问话先落 journal，再进送达队列；送不出去就按退避重试，
 * 10 次后停在「未送达」，等人点「立即重试」或撤回。纯规则，不碰时钟和存储。
 */
export type DeliveryState = 'queued' | 'sending' | 'delivered' | 'undelivered' | 'cancelled' | 'held';
export type DeliveryKind = 'prompt' | 'handoff_brief';

export interface Delivery {
  readonly id: string;
  readonly sessionId: string;
  /** 对应 journal 里 prompt 事件的 seq；交接简报（held）为 0。 */
  readonly seq: number;
  readonly kind: DeliveryKind;
  readonly payload: unknown;
  readonly state: DeliveryState;
  readonly attempt: number;
  readonly nextAt: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export const DELIVERY_BASE_MS = 2_000;
export const DELIVERY_MAX_MS = 60_000;
export const DELIVERY_MAX_ATTEMPTS = 10;

/** 第 attempt 次失败后等多久：2s 起倍增，封顶 60s，±10% 抖动（random 注入，测试可固定）。 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(DELIVERY_BASE_MS * 2 ** Math.max(0, attempt - 1), DELIVERY_MAX_MS);
  return Math.round(base * (0.9 + 0.2 * random()));
}

/** 一次送达失败后的下一个状态。 */
export function afterFailure(d: Delivery, error: string, now: number, random?: () => number): Delivery {
  const attempt = d.attempt + 1;
  if (attempt >= DELIVERY_MAX_ATTEMPTS) return { ...d, attempt, state: 'undelivered', nextAt: null, lastError: error, updatedAt: now };
  return { ...d, attempt, state: 'queued', nextAt: now + retryDelay(attempt, random), lastError: error, updatedAt: now };
}

/** 还占着这条会话「送达通道」的（后面的消息得排在它后面）。 */
export function isPending(state: DeliveryState): boolean {
  return state === 'queued' || state === 'sending' || state === 'undelivered';
}
