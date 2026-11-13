import type { ProviderModel, ProviderProtocol } from '@agent-hub/domain';
import { PROVIDER_MODEL_EXTRA_FORBIDDEN_KEYS, parseHubModel } from '@agent-hub/domain';

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
  /** 这个提供商的模型（含每模型 extra）：转发时按请求体里的 model 合并额外参数。 */
  readonly models?: readonly ProviderModel[] | undefined;
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
 * 哪些上游路径允许合并 model extra（只看路径部分，忽略 query）。
 * 只合并会话式请求：/models 之类的 GET 不碰。
 */
const MERGE_PATHS = ['/chat/completions', '/completions', '/responses', '/messages'];

const EXTRA_FORBIDDEN = new Set(PROVIDER_MODEL_EXTRA_FORBIDDEN_KEYS);

/**
 * 思考强度这类「用户在会话里可以自己选」的键：agent 已经发了值就以它为准，
 * 提供商配置里的同名键只当默认值。别的键（max_tokens、temperature 之类）仍是提供商说了算：
 * 那些多是为了让模型能跑，不是用户当场能表达的意图。
 */
const AGENT_PREFERRED = new Set(['reasoning_effort', 'reasoning', 'thinking', 'thinking_config']);

/** 请求体里的 model 去掉 hub-<slug>/ 前缀：agent 可能拿到的是 hub 模型 id。 */
function bareModel(model: string): string {
  const parsed = parseHubModel(model);
  if (parsed) return parsed.modelId;
  if (model.startsWith('hub-')) {
    const slash = model.indexOf('/');
    if (slash > 0 && slash < model.length - 1) return model.slice(slash + 1);
  }
  return model;
}

/**
 * 把提供商为该模型配置的 extra 合并进上游请求体（纯函数）：
 * 只有 POST + JSON 对象 + 命中会话式路径且 model 对得上时才改；顶层浅合并，extra 覆盖同名键，
 * 但绝不覆盖 model/messages/input/stream/stream_options/tools；思考强度类的键在 agent 已发值时让位给 agent。
 * 任何不命中或解析失败都原样返回入参，不抛错。
 */
export function mergeModelExtra(
  request: { readonly method: string; readonly subpath: string; readonly headers: { get(name: string): string | null }; readonly body: Uint8Array },
  models: readonly ProviderModel[] | undefined
): Uint8Array {
  if (!models?.length || request.body.byteLength === 0) return request.body;
  if (request.method.toUpperCase() !== 'POST') return request.body;
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return request.body;
  const path = request.subpath.split('?')[0] ?? '';
  if (!MERGE_PATHS.some((suffix) => path.endsWith(suffix))) return request.body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(request.body));
  } catch {
    return request.body;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return request.body;
  const body = parsed as Record<string, unknown>;
  if (typeof body['model'] !== 'string') return request.body;
  const id = bareModel(body['model']);
  const extra = models.find((model) => model.id === id)?.extra;
  if (!extra || Object.keys(extra).length === 0) return request.body;
  const entries = Object.entries(body);
  for (const [key, value] of Object.entries(extra)) {
    if (EXTRA_FORBIDDEN.has(key)) continue;
    // 思考强度：agent 报过（会话里能切）就听 agent 的，配置只补它没报的
    if (AGENT_PREFERRED.has(key) && body[key] !== undefined) continue;
    entries.push([key, value]);
  }
  // Object.fromEntries 按数据属性写入：即使 extra 里混进 __proto__ 也不会改原型。
  return new TextEncoder().encode(JSON.stringify(Object.fromEntries(entries)));
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
  const body = mergeModelExtra(request, upstream.models);
  if (body.byteLength > limits.maxRequestBytes) return errorResponse(413, '请求体太大');
  const headers: Record<string, string> = {};
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  Object.assign(headers, authHeaders(upstream.protocol, upstream.apiKey));
  const abort = new AbortController();
  const total = setTimeout(() => abort.abort(new Error('总时长超限')), limits.totalTimeoutMs);
  total.unref?.();
  const headerTimer = setTimeout(() => abort.abort(new Error('上游响应超时')), limits.headersTimeoutMs);
  headerTimer.unref?.();
  const bytesIn = body.byteLength;
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
      ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
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
