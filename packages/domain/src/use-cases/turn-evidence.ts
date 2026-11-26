import { isUnknownOutcomeEnded } from '../attention.ts';
import type { Delivery } from '../delivery.ts';
import type { JournalEntry } from '../event.ts';
import type { SessionId } from '../ids.ts';
import type { DeliveryQueue } from '../ports/delivery-queue.ts';
import type { SessionRepository } from '../ports/session-repository.ts';

/**
 * 「这一轮还在不在跑」的两处判断共用的**只读事实**。
 *
 * 这里只放两个用例都需要的、语义完全一致的有界读：精确 `inFlight`、最近的送达记录、
 * journal 尾窗（含截断判定）、以及尾部倒序扫描的骨架。判断本身不在这里统一：
 * 送达门（`delivery.ts` 的 `turnInProgress`）要先核对 delivered 的归属证据再看状态，
 * 切换门（`sessions.ts` 的 `turnStillRunning`）则先认非 running 为已停止。两套优先级
 * 各自留在原模块里，避免再长出第三个「通用 isBusy」把差别抹平。
 */

/** 送达记录的有界读窗口。精确 `inFlight` 不受它限制。 */
export const TURN_RECENT_WINDOW = 200;
/** journal 尾窗；读满且不从 seq 1 开始时无法证明更早的回合已结束。 */
export const TURN_JOURNAL_WINDOW = 2_000;

/**
 * 精确在途：只认队列里唯一那条 `sending`，不看 recent 窗口，也不看会话状态。
 * 没接送达队列（纯 journal 场景 / 老调用）时为空。
 */
export async function readInFlightTurn(
  deliveries: Pick<DeliveryQueue, 'inFlight'> | undefined,
  sessionId: SessionId
): Promise<Delivery | null> {
  return deliveries ? deliveries.inFlight(sessionId) : null;
}

/** 最近的送达记录（时间正序），只用于有界兜底；没有队列时为空。 */
export async function readRecentTurnDeliveries(
  deliveries: Pick<DeliveryQueue, 'recent'> | undefined,
  sessionId: SessionId
): Promise<readonly Delivery[]> {
  return deliveries ? deliveries.recent(sessionId, TURN_RECENT_WINDOW) : [];
}

export interface JournalTailRead {
  readonly entries: readonly JournalEntry[];
  /**
   * 窗口读满且不是从 seq 1 开始：更早的 prompt / ended 可能被截断，
   * 尾部没读到证据时不能据此判定空闲（fail closed）。
   */
  readonly truncated: boolean;
}

/** 读 journal 尾窗；截断判定基于原始窗口，调用方之后再过滤 / 跳过事件。 */
export async function readJournalTail(
  deps: { readonly sessions: Pick<SessionRepository, 'tail'> },
  sessionId: SessionId
): Promise<JournalTailRead> {
  const entries = await deps.sessions.tail(sessionId, TURN_JOURNAL_WINDOW);
  return { entries, truncated: entries.length >= TURN_JOURNAL_WINDOW && entries[0]!.seq > 1 };
}

/**
 * journal 尾部给出的这一轮证据：
 * - `idle`：尾部有结束证据，或窗口完整且没有未收尾的 prompt；
 * - `open`：最后一条未收尾的 prompt 还在等结束证据；
 * - `unknown`：结果未确认，或窗口被截断又没找到任何证据，无法证明结束。
 */
export type TurnTailVerdict = 'idle' | 'open' | 'unknown';

/**
 * 从尾部倒序扫描，跳过「还没开局」的 prompt（由调用方给判定：送达门排除所有未送达状态，
 * 切换门只排除 queued / undelivered / cancelled）。骨架共享，跳过集合仍是各自策略。
 */
export function turnVerdictInTail(
  tail: JournalTailRead,
  isUnstartedPrompt: (entry: JournalEntry) => boolean
): TurnTailVerdict {
  for (let i = tail.entries.length - 1; i >= 0; i--) {
    const entry = tail.entries[i]!;
    if (entry.event.kind === 'ended') return isUnknownOutcomeEnded(entry.event) ? 'unknown' : 'idle';
    if (entry.event.kind !== 'prompt') continue;
    if (isUnstartedPrompt(entry)) continue;
    return 'open';
  }
  return tail.truncated ? 'unknown' : 'idle';
}
