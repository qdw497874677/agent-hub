import type { ProviderProtocol } from '@agent-hub/domain';

/**
 * 模型提供商的转发核心（worker 本机中继与 hub 中转共用，ADR 0013）：
 * 剥掉进来的一切凭据头，按协议换上真密钥，请求体有上限，响应（含 SSE）边收边转。
 * 不打任何日志；密钥只出现在发往上游的那一个请求头里。
 */
export interface ProxyLimits {
  readonly maxRequestBytes: number;
  /** 等上游响应头的时间。 */
  readonly headersTimeoutMs: number;
  /** 整个请求（含流式响应）的上限。 */
  readonly totalTimeoutMs: number;
}

export const DEFAULT_PROXY_LIMITS: ProxyLimits = { maxRequestBytes: 16 * 1024 * 1024, headersTimeoutMs: 120_000, totalTimeoutMs: 30 * 60_000 };

export interface Upstream {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly protocol: ProviderProtocol;
}

export interface ProxyOutcome {
  readonly status: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly ok: boolean;
}

const FORWARD_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'x-stainless-helper-method'];
const RETURN_HEADERS = ['content-type', 'cache-control', 'x-request-id', 'request-id', 'retry-after'];

/** 只认 /v1/…、/chat/completions 这类相对路径：不许 .. 和协议串，防止中继被当成开放代理。 */
export function safeSubpath(rest: string): string | null {
  if (!rest.startsWith('/') || rest.startsWith('//')) return null;
  const path = rest.split('?')[0] ?? '';
  if (path.split('/').some((part) => part === '..' || part === '.') || /[\\\s]|%2e|%2f|%5c/i.test(path)) return null;
  return rest;
}

export function authHeaders(protocol: ProviderProtocol, apiKey: string): Record<string, string> {
  return protocol === 'anthropic' ? { 'x-api-key': apiKey } : { authorization: `Bearer ${apiKey}` };
}

/** 进来的凭据：Bearer 或 x-api-key（anthropic 客户端发后者）。 */
export function offeredToken(headers: { get(name: string): string | null }): string {
  const auth = headers.get('authorization') ?? '';
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return (headers.get('x-api-key') ?? '').trim();
}

export class PayloadTooLarge extends Error {}

/** 读请求体，超过上限就抛 PayloadTooLarge。 */
export async function readLimited(body: AsyncIterable<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > max) throw new PayloadTooLarge(`请求体超过 ${max} 字节`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { type: 'hub_relay_error', message } }), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * 转发一个请求。onDone 在响应体转完（或出错 / 超时）时调一次，用于计数。
 * 返回的 Response 的 body 是边收边转的流。
 */
export async function forwardProvider(
  request: { readonly method: string; readonly subpath: string; readonly headers: { get(name: string): string | null }; readonly body: Uint8Array },
  upstream: Upstream,
  limits: ProxyLimits = DEFAULT_PROXY_LIMITS,
  onDone?: (outcome: ProxyOutcome) => void
): Promise<Response> {
  const subpath = safeSubpath(request.subpath);
  if (!subpath) return errorResponse(400, '路径不合法');
  if (request.body.byteLength > limits.maxRequestBytes) return errorResponse(413, '请求体太大');
  const headers: Record<string, string> = {};
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  Object.assign(headers, authHeaders(upstream.protocol, upstream.apiKey));
  const abort = new AbortController();
  const total = setTimeout(() => abort.abort(new Error('总时长超限')), limits.totalTimeoutMs);
  const headerTimer = setTimeout(() => abort.abort(new Error('上游响应超时')), limits.headersTimeoutMs);
  const bytesIn = request.body.byteLength;
  let done = false;
  const finish = (status: number, bytesOut: number, ok: boolean) => {
    if (done) return;
    done = true;
    clearTimeout(total);
    clearTimeout(headerTimer);
    onDone?.({ status, bytesIn, bytesOut, ok });
  };
  let response: Response;
  try {
    const method = request.method.toUpperCase();
    response = await fetch(upstream.baseUrl.replace(/\/+$/, '') + subpath, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: request.body }),
      signal: abort.signal,
      redirect: 'manual'
    });
  } catch (failure) {
    finish(502, 0, false);
    const reason = abort.signal.aborted ? String((abort.signal.reason as Error)?.message ?? '超时') : '连不上模型提供商';
    return errorResponse(abort.signal.aborted ? 504 : 502, reason + (failure instanceof Error && !abort.signal.aborted ? `（${failure.name}）` : ''));
  }
  clearTimeout(headerTimer);
  const out = new Headers();
  for (const name of RETURN_HEADERS) {
    const value = response.headers.get(name);
    if (value) out.set(name, value);
  }
  const status = response.status;
  if (!response.body) {
    finish(status, 0, status < 400);
    return new Response(null, { status, headers: out });
  }
  let bytesOut = 0;
  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: end, value } = await reader.read();
        if (end) {
          finish(status, bytesOut, status < 400);
          controller.close();
          return;
        }
        bytesOut += value.byteLength;
        controller.enqueue(value);
      } catch (failure) {
        finish(status, bytesOut, false);
        controller.error(failure);
      }
    },
    cancel(reason) {
      finish(status, bytesOut, false);
      abort.abort(reason);
      void reader.cancel(reason).catch(() => undefined);
    }
  });
  return new Response(stream, { status, headers: out });
}
