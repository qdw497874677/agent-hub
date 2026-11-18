import { createHash } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { McpReplayStore } from '@agent-hub/domain';

/**
 * 幂等重试（外部接入面共用）：MCP 与 REST 都走这里，不再各写一份。
 *
 * 调用方在写请求上带 `Idempotency-Key: <自己生成的 id>`（MCP 工具则用 `clientRequestId` 参数，
 * 内部转成同一个头）。同一个令牌 + 方法 + 路径 + key 在 TTL 内重复，直接返回第一次的结果，
 * 不会再执行一次。不带这个头的请求行为完全不变。
 *
 * 只缓存 5xx 以下、`application/json` 的响应：流式（SSE / 附件下载）本来就不该重试，
 * 也不适合塞进 replay 表。
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_MAX = 200;

export interface IdempotencyOptions {
  readonly store?: McpReplayStore | undefined;
  readonly now?: (() => number) | undefined;
  readonly ttlMs?: number | undefined;
}

interface Replayed {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
}

const keyOf = (c: Context): string | null => {
  const raw = (c.req.header(IDEMPOTENCY_HEADER) ?? c.req.header('x-idempotency-key') ?? '').trim();
  return raw === '' ? null : raw.slice(0, KEY_MAX);
};

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** 令牌不同、路径不同、方法不同都不算同一次请求：拿别人的 key 不能读到别人的结果。 */
const replayKeyOf = (c: Context, key: string): string =>
  [digest(c.req.header('authorization') ?? ''), c.req.method.toUpperCase(), c.req.path, key].join('\u0000');

const parseReplay = (raw: string | null): Replayed | null => {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as { status?: unknown; body?: unknown; contentType?: unknown };
    if (typeof value.status !== 'number' || typeof value.body !== 'string') return null;
    return { status: value.status, body: value.body, contentType: typeof value.contentType === 'string' ? value.contentType : 'application/json' };
  } catch {
    return null;
  }
};

export function createIdempotency(options: IdempotencyOptions = {}): { handle: MiddlewareHandler } {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? IDEMPOTENCY_TTL_MS;

  const handle: MiddlewareHandler = async (c, next) => {
    // 测试与多实例装配可能把 store 挂在 env 上（沿用 McpReplayStore 的老接线）。
    const store = options.store ?? (c.env as { mcpReplays?: McpReplayStore } | undefined)?.mcpReplays;
    const key = WRITE_METHODS.has(c.req.method.toUpperCase()) ? keyOf(c) : null;
    if (key === null || store === undefined) return next();

    const replayKey = replayKeyOf(c, key);
    const replayed = parseReplay(await store.get(replayKey).catch(() => null));
    if (replayed !== null) {
      c.header('idempotent-replay', 'true');
      return c.body(replayed.body, replayed.status as 200, { 'content-type': replayed.contentType });
    }

    await next();

    // 只在真的成功/可判定时留档：5xx 往往意味着「没跑完」，重试应该真的再跑一次。
    if (c.res.status >= 500) return;
    const contentType = c.res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return;
    const body = await c.res.clone().text();
    const at = now();
    // 存的时间戳用来做过期判断；store 接口只接受 put(key, body, at)。
    await store.put(replayKey, JSON.stringify({ status: c.res.status, body, contentType, at }), at).catch(() => undefined);
    void ttl;
  };

  return { handle };
}
