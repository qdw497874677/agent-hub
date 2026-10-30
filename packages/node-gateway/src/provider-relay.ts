import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { DEFAULT_PROXY_LIMITS, PayloadTooLarge, errorResponse, forwardProvider, offeredToken, readLimited, type ProxyLimits, type Upstream } from './provider-proxy.ts';

/**
 * Worker 本机的模型提供商中继（ADR 0013 D1）：只听 127.0.0.1，每个会话一个随机句柄 + 令牌。
 * agent 只拿到 http://127.0.0.1:<port>/r/<handle> 和令牌；真密钥（direct）或 hub 中转令牌（via hub）
 * 留在 worker 进程里，由这里换到发往上游的请求头上。令牌和密钥都不进日志。
 */
export interface RelaySession {
  readonly handle: string;
  /** agent 用的 base URL（不含协议路径，agent 自己拼 /chat/completions 等）。 */
  readonly baseUrl: string;
  readonly token: string;
}

export interface ProviderRelay {
  open(sessionId: string, upstream: Upstream): Promise<RelaySession>;
  close(sessionId: string): void;
  stop(): Promise<void>;
  /** 测试用：当前监听地址。 */
  address(): string | null;
}

interface Entry {
  readonly handle: string;
  readonly token: Buffer;
  readonly upstream: Upstream;
}

const same = (offered: string, expected: Buffer): boolean => {
  const given = Buffer.from(offered, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
};

export function createProviderRelay(options: { readonly limits?: ProxyLimits; readonly log?: (line: string) => void } = {}): ProviderRelay {
  const limits = options.limits ?? DEFAULT_PROXY_LIMITS;
  const byHandle = new Map<string, Entry>();
  const bySession = new Map<string, string>();
  let server: Server | null = null;
  let listening: Promise<string> | null = null;
  let base: string | null = null;

  async function send(response: ServerResponse, out: Response): Promise<void> {
    const headers: Record<string, string> = {};
    out.headers.forEach((value, name) => (headers[name] = value));
    response.writeHead(out.status, headers);
    if (!out.body) {
      response.end();
      return;
    }
    const body = Readable.fromWeb(out.body as import('node:stream/web').ReadableStream<Uint8Array>);
    response.on('close', () => body.destroy());
    body.on('error', () => response.destroy());
    body.pipe(response);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const matched = /^\/r\/([A-Za-z0-9_-]{16,64})(\/.*)?$/.exec(request.url ?? '');
    const entry = matched ? byHandle.get(matched[1] ?? '') : undefined;
    const headers = { get: (name: string) => { const v = request.headers[name]; return Array.isArray(v) ? (v[0] ?? null) : (v ?? null); } };
    if (!matched || !entry) return send(response, errorResponse(404, '没有这个中继会话（会话已结束？）'));
    if (!same(offeredToken(headers), entry.token)) return send(response, errorResponse(401, '中继令牌不对'));
    let body: Uint8Array;
    try {
      body = await readLimited(request, limits.maxRequestBytes);
    } catch (failure) {
      return send(response, errorResponse(failure instanceof PayloadTooLarge ? 413 : 400, failure instanceof PayloadTooLarge ? '请求体太大' : '请求体读不完'));
    }
    const out = await forwardProvider({ method: request.method ?? 'GET', subpath: matched[2] ?? '/', headers, body }, entry.upstream, limits);
    return send(response, out);
  }

  function listen(): Promise<string> {
    if (listening) return listening;
    listening = new Promise((resolve, reject) => {
      const created = createServer((request, response) => {
        handle(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      // 流式响应可能很长：交给 forwardProvider 的总时长控制
      created.requestTimeout = 0;
      created.headersTimeout = 60_000;
      created.once('error', reject);
      created.listen(0, '127.0.0.1', () => {
        const address = created.address();
        if (address === null || typeof address === 'string') return reject(new Error('中继没有拿到端口'));
        server = created;
        base = `http://127.0.0.1:${address.port}`;
        resolve(base);
      });
    });
    return listening;
  }

  return {
    async open(sessionId, upstream) {
      const root = await listen();
      this.close(sessionId);
      const handle = randomBytes(18).toString('base64url');
      const token = randomBytes(32).toString('base64url');
      byHandle.set(handle, { handle, token: Buffer.from(token, 'utf8'), upstream });
      bySession.set(sessionId, handle);
      return { handle, baseUrl: `${root}/r/${handle}`, token };
    },
    close(sessionId) {
      const handle = bySession.get(sessionId);
      if (handle) byHandle.delete(handle);
      bySession.delete(sessionId);
    },
    async stop() {
      byHandle.clear();
      bySession.clear();
      const current = server;
      server = null;
      listening = null;
      if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
    },
    address: () => base
  };
}

