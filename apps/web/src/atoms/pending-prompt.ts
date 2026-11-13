import type { AttachmentInputDto } from '@agent-hub/contract';

/**
 * 还没写进对话记录的那条消息：本地先画气泡，等 journal 回显再让位。
 *
 * 对账只认 id（clientMessageId）：同文的第二条消息不会把第一条挤掉，
 * 服务端也不会因为重发而重复落库。纯逻辑、不碰 DOM——所以这里没有 crypto 的直接调用。
 */
export type PendingPromptState =
  /** 请求在飞，还不知道服务端收没收到。 */
  | 'sending'
  /** 服务端 202 了：已落库、排队等派发。 */
  | 'queued'
  /** 超时没回执：可能到了也可能没到，交给人决定重试还是放弃。 */
  | 'unknown';

export interface PendingPrompt {
  /** 就是发给服务端的 clientMessageId；重试沿用同一个。 */
  readonly id: string;
  readonly text: string;
  /** 重试时原样再带上（服务端幂等，第二次会被忽略）。 */
  readonly attachments: readonly AttachmentInputDto[];
  readonly state: PendingPromptState;
  /** 服务端回执里的 journal 位置；sending / unknown 时没有。 */
  readonly seq?: number;
  /** 这一轮发送的起点（重试会刷新），超时按它算。 */
  readonly sentAt: number;
}

/** 回执等这么久还没来，就把气泡标成「未送达」。 */
export const ACK_TIMEOUT_MS = 8000;

/**
 * 生成一条消息 id。优先 crypto.randomUUID（浏览器和安全上下文里都有），
 * 没有就退回时间 + 随机串——只要 1–80 字符、够唯一就行。
 */
export function newClientMessageId(random: () => string = randomUuid): string {
  return random();
}

function randomUuid(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 对账只看得到的部分：prompt 块可能带 clientMessageId（新事件），老事件没有。 */
export interface ReconcilableBlock {
  readonly kind: string;
  readonly clientMessageId?: string;
}

/**
 * journal 里出现了同 id 的 prompt 块，就删掉对应 pending。
 * 文本一概不看：同文的第二条消息有自己的 id，不会被误删。
 * 没有变化时返回原数组，React 的 setState 才不会白重渲染。
 */
export function reconcilePending(
  pending: readonly PendingPrompt[],
  blocks: readonly ReconcilableBlock[]
): readonly PendingPrompt[] {
  if (pending.length === 0) return pending;
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.kind === 'prompt' && block.clientMessageId) seen.add(block.clientMessageId);
  }
  if (seen.size === 0) return pending;
  const next = pending.filter((item) => !seen.has(item.id));
  return next.length === pending.length ? pending : next;
}

const LABELS: Record<PendingPromptState, string> = {
  sending: '正在发送…',
  queued: '已收到 · 排队中',
  unknown: '未送达'
};

export function pendingLabel(state: PendingPromptState): string {
  return LABELS[state];
}

/** 只有「还在飞」的才会超时；已经回执的、已经标过未知的都不再变。 */
export function isExpired(
  state: PendingPromptState,
  sentAt: number,
  now: number,
  timeoutMs: number = ACK_TIMEOUT_MS
): boolean {
  return state === 'sending' && now - sentAt >= timeoutMs;
}

/** 把超时的 pending 标成 unknown；没有变化时返回原数组。 */
export function expirePending(
  pending: readonly PendingPrompt[],
  now: number,
  timeoutMs: number = ACK_TIMEOUT_MS
): readonly PendingPrompt[] {
  const expired = pending.some((item) => isExpired(item.state, item.sentAt, now, timeoutMs));
  if (!expired) return pending;
  return pending.map((item) =>
    isExpired(item.state, item.sentAt, now, timeoutMs) ? { ...item, state: 'unknown' as const } : item
  );
}
