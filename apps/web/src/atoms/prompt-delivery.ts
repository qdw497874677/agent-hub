import { ACK_TIMEOUT_MS, type PendingPrompt } from './pending-prompt.ts';

/**
 * 发送反馈里不碰 DOM 的那部分：哪些 prompt 还在排队、时间线怎么拆、气泡超时怎么算。
 *
 * 专注对话和画布卡片共用这一份，免得两边对「排队中」的理解慢慢跑偏。
 */

/** 还在排队/还没送到的送达状态：这些 prompt 不该留在时间线里。 */
const HELD_STATES: ReadonlySet<string> = new Set(['queued', 'sending', 'undelivered']);

/** 定时器比超时点晚一点醒：同一毫秒里刚到的回执不算过期。 */
export const ACK_GRACE_MS = 50;

export interface TimelineBlock {
  readonly kind: string;
  readonly seq: number;
}

/** 送达状态是 queued / sending / undelivered 的 seq。没送达状态（还没查到的）、已送到的都不算。 */
export function heldPromptSeqs(
  deliveries: ReadonlyMap<number, { readonly state: string }>
): ReadonlySet<number> {
  const held = new Set<number>();
  for (const [seq, delivery] of deliveries) {
    if (HELD_STATES.has(delivery.state)) held.add(seq);
  }
  return held;
}

/**
 * 把时间线拆成「正文」和「排队中」两段：排队中的用户消息要贴在输入框上方，
 * 不能留在正文里被后续输出顶到上面。没有命中任何一条时返回原数组（下游 memo 不用重算）。
 */
export function splitTimeline<B extends TimelineBlock>(
  blocks: readonly B[],
  held: ReadonlySet<number>
): { readonly timeline: readonly B[]; readonly queued: readonly B[] } {
  if (held.size === 0) return { timeline: blocks, queued: [] };
  const queued = blocks.filter((block) => block.kind === 'prompt' && held.has(block.seq));
  if (queued.length === 0) return { timeline: blocks, queued };
  return { timeline: blocks.filter((block) => !(block.kind === 'prompt' && held.has(block.seq))), queued };
}

/**
 * 乐观气泡的临时 seq：负数，不会和 journal 里的 seq 撞。
 * 越早发的越靠前（先发的是 -1），和真实消息的顺序读起来一致。
 */
export function pendingBubbles(
  pending: readonly PendingPrompt[]
): readonly { readonly prompt: PendingPrompt; readonly seq: number }[] {
  return pending.map((prompt, index) => ({ prompt, seq: -1 - index }));
}

/**
 * 下一次该在多少毫秒后检查超时：取最近的一条「等回执」的消息；已经没有在等的就返回 null。
 * 过了超时点的返回 0（立刻复查），不返回负数。
 */
export function nextAckDelay(
  pending: readonly PendingPrompt[],
  now: number,
  timeoutMs: number = ACK_TIMEOUT_MS
): number | null {
  let soonest: number | null = null;
  for (const item of pending) {
    if (item.state !== 'sending') continue;
    const delay = Math.max(0, item.sentAt + timeoutMs - now);
    if (soonest === null || delay < soonest) soonest = delay;
  }
  return soonest;
}
