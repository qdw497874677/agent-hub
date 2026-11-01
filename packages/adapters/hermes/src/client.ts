import { createSseParser } from './sse.ts';

/** 一个 Hermes API Server 的地址和密钥（密钥只在内存里）。 */
export interface HermesEndpoint {
  readonly baseUrl: string;
  readonly key: string;
  /** 每个请求都带同一个 X-Hermes-Session-Key：§14 实测它是幂等指纹的一部分，换了就 409。 */
  readonly sessionKey: string;
}

export class HermesHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | null;
  constructor(status: number, code: string, message: string, retryAfterMs: number | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function headers(endpoint: HermesEndpoint, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${endpoint.key}`, 'x-hermes-session-key': endpoint.sessionKey, ...extra };
}

export async function hermesJson<T>(
  endpoint: HermesEndpoint,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
  fetcher: typeof fetch = fetch
): Promise<T> {
  const response = await fetcher(`${endpoint.baseUrl}${path}`, {
    method,
    headers: headers(endpoint, body === undefined ? extra : { 'content-type': 'application/json', ...extra }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const retry = Number(response.headers.get('retry-after'));
    throw new HermesHttpError(
      response.status,
      typeof error?.code === 'string' ? error.code : `http_${response.status}`,
      typeof error?.message === 'string' ? error.message : `Hermes 返回 ${response.status}`,
      Number.isFinite(retry) && retry > 0 ? retry * 1000 : null
    );
  }
  return parsed as T;
}

/**
 * 提交一轮。429 / 503 用**同一个**幂等键退避重试（最多 maxWaitMs，默认 2 分钟）——重放不会多跑一轮。
 * 网络错误也按同一个键重试：Hermes 记得这个键，第二次只会把第一次的 run_id 还回来。
 */
export async function submitRun(
  endpoint: HermesEndpoint,
  body: Record<string, unknown>,
  idempotencyKey: string,
  options: { readonly maxWaitMs?: number; readonly sleep?: (ms: number) => Promise<void>; readonly fetcher?: typeof fetch } = {}
): Promise<{ run_id: string; status: string }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (options.maxWaitMs ?? 120_000);
  let delay = 1000;
  for (;;) {
    try {
      return await hermesJson(endpoint, 'POST', '/v1/runs', body, { 'idempotency-key': idempotencyKey }, options.fetcher);
    } catch (error) {
      const retryable = error instanceof HermesHttpError ? error.status === 429 || error.status === 503 : error instanceof TypeError;
      if (!retryable || Date.now() + delay > deadline) throw error;
      await sleep(error instanceof HermesHttpError && error.retryAfterMs ? Math.min(error.retryAfterMs, 30_000) : delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

/** 订阅一轮的事件流；返回的 promise 在流关掉时 resolve（正常结束或断线都算，调用方再查状态对账）。 */
export async function streamRun(
  endpoint: HermesEndpoint,
  runId: string,
  onEvent: (event: Record<string, unknown>, id: string | null) => void,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const response = await fetcher(`${endpoint.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
    headers: headers(endpoint, { accept: 'text/event-stream' }),
    signal
  });
  if (!response.ok || !response.body) throw new HermesHttpError(response.status, `http_${response.status}`, `事件流打不开：${response.status}`, null);
  const parse = createSseParser((frame) => {
    try {
      const value = JSON.parse(frame.data) as unknown;
      if (value && typeof value === 'object') onEvent(value as Record<string, unknown>, frame.id);
    } catch {
      /* 不认识的帧跳过 */
    }
  });
  const decoder = new TextDecoder();
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) parse(decoder.decode(chunk, { stream: true }));
}
