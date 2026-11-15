import { newId } from './ids.ts';

/**
 * 通道出站队列（C2b）。
 *
 * 纯逻辑 + 端口：这里不碰数据库、不碰平台 API。真正的投递由 pump 调 `deliver` 完成，
 * 行存储由 `OutboxStore` 的实现（storage-sqlite）负责。这样回声判定、退避、租约
 * 都能在没有 IO 的情况下单测。
 */

export type OutboxTargetKind = 'session' | 'group' | 'external';
export type OutboxState = 'queued' | 'sending' | 'sent' | 'failed';
export type OutboxAuthorKind = 'agent' | 'user';
export type OutboxOrigin = 'inbound' | 'reply';

export interface OutboxTarget {
  kind: OutboxTargetKind;
  /** session id / group id / `github:owner/repo#n` 之类的平台地址。 */
  id: string;
}

export interface OutboxAuthor {
  kind: OutboxAuthorKind;
  name: string;
}

export interface ChannelOutboxMessage {
  id: string;
  target: OutboxTarget;
  body: string;
  author: OutboxAuthor;
  /** 这条消息要回的原平台消息 id（回声第 2 层用）。 */
  replyToExternalId: string | null;
  externalConversationId: string | null;
  externalThreadId: string | null;
  state: OutboxState;
  attempts: number;
  /** `sending` 期间的独占租约；到期后允许被别人重新 claim。 */
  leaseUntil: number | null;
  nextAttemptAt: number;
  externalMessageId: string | null;
  origin: OutboxOrigin;
  createdAt: number;
  updatedAt: number;
}

export interface OutboxClaim {
  /** 只领这些目标类型；未接线的类型（如 github 的 external）留在队列里。 */
  kinds: readonly OutboxTargetKind[];
}

/**
 * 出站队列的存储端口。
 *
 * `claim` 必须具备 CAS 语义：同一个 message 在任意时刻只能被一个调用者拿到，
 * 不论并发多高、实例有几个。
 */
export interface OutboxStore {
  /** 取一条 `next_attempt_at <= now` 的行，置 `sending` 并写租约；没有则 null。 */
  claim(due: OutboxClaim, now: number, leaseMs: number): Promise<ChannelOutboxMessage | null>;
  save(message: ChannelOutboxMessage): Promise<void>;
  /** 租约已过期、仍停在 `sending` 的行。 */
  expiring(now: number): Promise<ChannelOutboxMessage[]>;
  /** 把过期租约放回 `queued`，返回改动行数。 */
  requeue(now: number): Promise<number>;
  /** 回声判定候选：同目标、窗口内、状态是 `sending` 或 `sent` 的行。 */
  echoCandidates(target: OutboxTarget, since: number): Promise<ChannelOutboxMessage[]>;
}

export const OUTBOX_MAX_ATTEMPTS = 8;

const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000] as const;

/** 第 n 次失败后的等待时长：1s、5s、30s、2min、10min 封顶。 */
export function backoffFor(attempts: number): number {
  const index = Math.max(1, Math.floor(attempts)) - 1;
  return BACKOFF_MS[Math.min(index, BACKOFF_MS.length - 1)]!;
}

/** 4xx 里只有“等一下还会好”的状态算瞬时；其余 4xx 重试也没用。 */
const RETRYABLE_4XX = new Set([408, 429]);

function statusOf(error: unknown): number | null {
  if (typeof error === 'number' && Number.isFinite(error)) return error;
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isFinite(status)) return status;
  }
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const match = /\b(\d{3})\b/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * 网络错误、429、5xx 属瞬时（重试）；400/401/403/404/422 等 4xx 属永久（直接 failed）。
 * 拿不到状态码时按瞬时处理——宁可多试几次，也不要因为一个临时抖动丢消息。
 */
export function isTransient(error: unknown): boolean {
  const status = statusOf(error);
  if (status === null || status === 0) return true;
  if (RETRYABLE_4XX.has(status)) return true;
  if (status >= 500) return true;
  if (status >= 400) return false;
  return true;
}

const sameTarget = (a: OutboxTarget, b: OutboxTarget) => a.kind === b.kind && a.id === b.id;
const normalizeName = (name: string) => name.trim().toLowerCase();
/** 正文指纹：去掉所有空白再比，避免平台侧换行/缩进差异。 */
const fingerprint = (body: string) => body.replace(/\s+/g, '');

export interface OutboxEchoInput {
  target: OutboxTarget;
  body: string;
  author: OutboxAuthor;
  externalMessageId: string | null;
}

/**
 * 回声三层去重：
 * ① 平台身份——候选行是本 agent 发的（作者名相同）；
 * ② `externalMessageId` 精确相等；
 * ③ 正文指纹相同且作者名相同（人类自己重复发同样的话不算，因为候选行作者是 agent 时不走这层）。
 *
 * 只比 `sending` / `sent` 的行：失败和排队中的行还没真投出去，不能拿来吃掉入站消息。
 */
export function looksLikeEcho(message: OutboxEchoInput, candidate: ChannelOutboxMessage): boolean {
  if (candidate.state !== 'sending' && candidate.state !== 'sent') return false;
  if (!sameTarget(message.target, candidate.target)) return false;
  if (message.externalMessageId !== null && message.externalMessageId === candidate.externalMessageId) return true;

  const name = normalizeName(message.author.name);
  const sameName = name !== '' && name === normalizeName(candidate.author.name);
  if (candidate.author.kind === 'agent' && sameName) return true;

  const body = fingerprint(message.body);
  return sameName && body !== '' && body === fingerprint(candidate.body);
}

export interface NewOutboxMessage {
  target: OutboxTarget;
  body: string;
  author: OutboxAuthor;
  origin: OutboxOrigin;
  replyToExternalId?: string | null;
  externalConversationId?: string | null;
  externalThreadId?: string | null;
}

export function newOutboxMessage(input: NewOutboxMessage, now: number, id: string = newId()): ChannelOutboxMessage {
  return {
    id,
    target: input.target,
    body: input.body,
    author: input.author,
    replyToExternalId: input.replyToExternalId ?? null,
    externalConversationId: input.externalConversationId ?? null,
    externalThreadId: input.externalThreadId ?? null,
    state: 'queued',
    attempts: 0,
    leaseUntil: null,
    nextAttemptAt: now,
    externalMessageId: null,
    origin: input.origin,
    createdAt: now,
    updatedAt: now
  };
}

export interface OutboxDeliverResult {
  ok: boolean;
  /** 平台返回的消息 id，成功后写回，供回声第 2 层使用。 */
  externalMessageId?: string;
  error?: unknown;
}

export type OutboxDeliver = (message: ChannelOutboxMessage) => Promise<OutboxDeliverResult>;

export interface OutboxPumpDeps {
  store: Pick<OutboxStore, 'claim' | 'save' | 'requeue'>;
  deliver: OutboxDeliver;
  now?: () => number;
  leaseMs?: number;
  maxAttempts?: number;
  /** 默认只处理 `session`；github 等未接线的目标类型继续保持 queued。 */
  kinds?: readonly OutboxTargetKind[];
}

export interface OutboxPump {
  /** 处理一条到期消息；返回本次处理条数（0 或 1）。 */
  tick(): Promise<number>;
  enqueue(input: NewOutboxMessage): Promise<ChannelOutboxMessage>;
}

export function createOutboxPump(deps: OutboxPumpDeps): OutboxPump {
  const now = deps.now ?? (() => Date.now());
  const leaseMs = deps.leaseMs ?? 30_000;
  const maxAttempts = deps.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
  const kinds = deps.kinds ?? (['session'] as const);

  return {
    async tick() {
      const at = now();
      await deps.store.requeue(at); // 租约过期的行先归队，再参与本轮领取
      const message = await deps.store.claim({ kinds }, at, leaseMs);
      if (message === null) return 0;

      let result: OutboxDeliverResult;
      try {
        result = await deps.deliver(message);
      } catch (error) {
        result = { ok: false, error };
      }

      const stamp = now();
      if (result.ok) {
        await deps.store.save({
          ...message,
          state: 'sent',
          leaseUntil: null,
          externalMessageId: result.externalMessageId ?? message.externalMessageId,
          updatedAt: stamp
        });
        return 1;
      }

      if (!isTransient(result.error)) {
        await deps.store.save({ ...message, state: 'failed', leaseUntil: null, updatedAt: stamp });
        return 1;
      }

      const attempts = message.attempts + 1;
      const exhausted = attempts >= maxAttempts;
      await deps.store.save({
        ...message,
        attempts,
        state: exhausted ? 'failed' : 'queued',
        leaseUntil: null,
        nextAttemptAt: exhausted ? message.nextAttemptAt : stamp + backoffFor(attempts),
        updatedAt: stamp
      });
      return 1;
    },

    async enqueue(input: NewOutboxMessage) {
      const message = newOutboxMessage(input, now());
      await deps.store.save(message);
      return message;
    }
  };
}
