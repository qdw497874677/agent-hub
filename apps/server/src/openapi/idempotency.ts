import { createHash } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { McpReplayStore } from '@agent-hub/domain';

/**
 * 幂等重试（外部接入面共用）：MCP 与 REST 都走这里，不再各写一份。
 *
 * 调用方在写请求上带 `Idempotency-Key: <自己生成的 id>`（MCP 工具则用 `clientRequestId` 参数，
 * 内部转成同一个头）。同一个令牌 + 方法 + 路径 + key 在 TTL 内只认第一次请求：
 * - 同一个请求体：直接返回第一次的结果（`idempotent-replay: true`），不再执行；
 * - 换了请求体：409 `idempotency_key_conflict`，既不回放旧结果，也不重新执行（多半是 key 拼错了）；
 * - 同一 key 已经有请求在跑：409 + retry-after，不会两个都执行。
 * 不带这个头的请求行为完全不变。key 按令牌隔离：拿别人的 key 读不到别人的结果。
 *
 * 并发：执行前先用 `store.claim` 条件插入占位，唯一键冲突 = 同 key 已有一个请求正在跑，
 * 直接回 409。占位超过 30 秒视为超时（进程挂了 / 卡住），可被后续请求接管；结果落档走
 * `store.commit` 并带上占位时间戳，只有占位还是自己那次才写得进去——被接管的老请求不会
 * 覆盖接管者的占位或结果。
 *
 * 只缓存 5xx 以下、`application/json` 的响应：流式（SSE / 附件下载）本来就不该重试，
 * 也不适合塞进 replay 表。
 *
 * 兼容（升级前写入的行）：旧键里带请求体摘要（见 `legacyReplayKeyOf`），所以只能按
 * 「这次请求体」把同一个请求的旧结果找回来，原样回放并顺手迁到新键。旧键用的那个请求体
 * 事后不可知，因此「同 key 换 body → 409」对升级前的 key 没有追溯力：升级后第一次用另一个
 * 请求体还会执行（结果会写进新键，之后这个 key 就进入新语义）。旧格式的 done 行没有
 * `requestDigest`，但都只可能出现在旧键下，不会拿来做「同一请求体」的判定。
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** 占位超过这么久还没写结果（进程挂了 / 卡住），允许重试接管。 */
export const IDEMPOTENCY_PLACEHOLDER_MS = 30_000;
/** 同一个 key 换了请求体：错误码与 Hermes 的 `idempotency_key_conflict` 同名。 */
export const IDEMPOTENCY_CONFLICT_CODE = 'idempotency_key_conflict';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** 幂等键上限；MCP 的 clientRequestId 用同一上限，但超长直接报错（不静默截断）。 */
export const IDEMPOTENCY_KEY_MAX = 200;

export interface IdempotencyOptions {
  readonly store?: McpReplayStore | undefined;
  readonly now?: (() => number) | undefined;
  readonly ttlMs?: number | undefined;
}

interface Replayed {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
  /** 第一次执行时的请求体摘要；没有就说明是升级前的行，不能证明「同一个请求体」。 */
  readonly requestDigest?: string | undefined;
  /** 第一次完成的时间（迁移旧行时用它，TTL 不续命）。 */
  readonly at?: number | undefined;
}

const keyOf = (c: Context): string | null => {
  const raw = (c.req.header(IDEMPOTENCY_HEADER) ?? c.req.header('x-idempotency-key') ?? '').trim();
  return raw === '' ? null : raw.slice(0, IDEMPOTENCY_KEY_MAX);
};

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** 读请求体做摘要；用 clone 读，原 request 的 body 留给后面的 handler（MCP 直接拿 raw）。 */
const bodyOf = async (c: Context): Promise<string> => {
  try {
    return await c.req.raw.clone().text();
  } catch {
    return '';
  }
};

/** 令牌不同、路径不同、方法不同都不算同一次请求：拿别人的 key 不能读到别人的结果。 */
const scopeOf = (c: Context): string[] => [digest(c.req.header('authorization') ?? ''), c.req.method.toUpperCase(), c.req.path];

/** 当前键：请求体不进键，记在值里（同 key 换 body 要 409）。 */
const replayKeyOf = (c: Context, key: string): string => [...scopeOf(c), key].join('\u0000');

/** 升级前的键：请求体摘要也在键里。只用来读旧行，不再往里写。 */
const legacyReplayKeyOf = (c: Context, key: string, bodyDigest: string): string =>
  [...scopeOf(c), bodyDigest, key].join('\u0000');

const parseReplay = (raw: string | null): Replayed | null => {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as { status?: unknown; body?: unknown; contentType?: unknown; requestDigest?: unknown; at?: unknown };
    if (typeof value.status !== 'number' || typeof value.body !== 'string') return null;
    return {
      status: value.status,
      body: value.body,
      contentType: typeof value.contentType === 'string' ? value.contentType : 'application/json',
      requestDigest: typeof value.requestDigest === 'string' ? value.requestDigest : undefined,
      at: typeof value.at === 'number' ? value.at : undefined
    };
  } catch {
    return null;
  }
};

const replay = (c: Context, replayed: Replayed): Response => {
  c.header('idempotent-replay', 'true');
  return c.body(replayed.body, replayed.status as 200, { 'content-type': replayed.contentType });
};

/** 409：这个 key 已经用过了，但请求体不一样。既不能回放（会拿别人的结果顶包），也不能执行。 */
const conflicts = (c: Context): Response =>
  c.json(
    { error: { code: IDEMPOTENCY_CONFLICT_CODE, message: '这个 Idempotency-Key 已经用在不同的请求体上，换个 key 再重试' } },
    409
  );

/**
 * 落档。有 `commit` 就走带归属的条件写：占位被接管时不写、也不覆盖新结果；
 * 老 store 没有 `commit` 时退化成 `put`（与改造前一致）。
 */
const write = async (store: McpReplayStore, key: string, body: string, at: number, claimedAt: number | null): Promise<boolean> => {
  const commit = store.commit?.bind(store);
  if (commit !== undefined && claimedAt !== null) return commit(key, body, at, claimedAt).catch(() => false);
  await store.put(key, body, at).catch(() => undefined);
  return true;
};

export function createIdempotency(options: IdempotencyOptions = {}): { handle: MiddlewareHandler } {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? IDEMPOTENCY_TTL_MS;

  const handle: MiddlewareHandler = async (c, next) => {
    // 测试与多实例装配可能把 store 挂在 env 上（沿用 McpReplayStore 的老接线）。
    const store = options.store ?? (c.env as { mcpReplays?: McpReplayStore } | undefined)?.mcpReplays;
    const key = WRITE_METHODS.has(c.req.method.toUpperCase()) ? keyOf(c) : null;
    if (key === null || store === undefined) return next();

    const at = now();
    const bodyDigest = digest(await bodyOf(c));
    const replayKey = replayKeyOf(c, key);
    // 请求体一致才回放；没有摘要的行不能证明一致，按冲突处理（正常路径不会走到）。
    const respond = (record: Replayed): Response => (record.requestDigest === bodyDigest ? replay(c, record) : conflicts(c));

    const done = parseReplay(await store.get(replayKey, at, ttl).catch(() => null));
    if (done !== null) return respond(done);

    // 升级前写入的行：旧键带请求体摘要，只能按这次的请求体找回同一个请求。
    // 部署满 24h（旧行全部过期）后这一段可以删掉。
    const legacy = parseReplay(await store.get(legacyReplayKeyOf(c, key, bodyDigest), at, ttl).catch(() => null));

    // 条件占位：拿到才执行；别人正在跑同一个 key 就直接 409，避免并发重复。
    const claim = store.claim?.bind(store);
    const acquired = claim === undefined ? true : await claim(replayKey, at, at - IDEMPOTENCY_PLACEHOLDER_MS, at - ttl).catch(() => false);
    const claimedAt = claim === undefined ? null : at;
    if (!acquired) {
      // 窄窗口：读完之后、占位之前，别人刚好写完了结果。
      const latest = parseReplay(await store.get(replayKey, now(), ttl).catch(() => null));
      if (latest !== null) return respond(latest);
      // 已有新格式请求占位：不要并行回放可能属于不同请求体的旧结果。
      c.header('retry-after', '1');
      return c.json({ error: '相同 Idempotency-Key 的请求正在执行，请稍后重试' }, 409);
    }

    let stored = false;
    try {
      if (legacy !== null) {
        // 旧结果是第一次的真实响应：原样回放，顺手迁到新键（保留原完成时间，TTL 不续命）。
        const migrated = JSON.stringify({ ...legacy, requestDigest: bodyDigest });
        stored = await write(store, replayKey, migrated, legacy.at ?? at, claimedAt);
        return replay(c, legacy);
      }

      await next();

      // 只在真的成功/可判定时留档：5xx 往往意味着「没跑完」，重试应该真的再跑一次。
      if (c.res.status >= 500) return;
      const contentType = c.res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) return;
      const body = await c.res.clone().text();
      const doneAt = now();
      const record = JSON.stringify({ status: c.res.status, body, contentType, at: doneAt, requestDigest: bodyDigest });
      stored = await write(store, replayKey, record, doneAt, claimedAt);
    } finally {
      // 没留下结果就把占位还回去，让重试能立刻再跑，不用等 30 秒超时。
      // 带上 claimedAt：占位已被接管时不能误删接管者的占位。
      if (!stored && claimedAt !== null) await store.release?.(replayKey, claimedAt).catch(() => undefined);
    }
  };

  return { handle };
}
