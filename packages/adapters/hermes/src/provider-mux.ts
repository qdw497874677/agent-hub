import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';

/**
 * worker 内的模型中继分流器（设计文档 §17）：一个 worker 只有一个 Hermes 网关，网关只认一个 custom provider，
 * 但 hub 的中继凭据是按会话发的（ADR 0013：每会话一个 handle + 令牌，用量按会话记）。
 * Hermes 发给上游的请求里没有任何会话标识（§17.1 实测：没有 header，body 里也没有 user），
 * 所以靠模型名带路由：每轮提交时 model 写成 `<路由>~<真模型>`，这里认出路由、换回真模型、带上那个会话自己的令牌转给 hub 中继。
 * - 只听 127.0.0.1，用一个随机密钥（只在内存和网关进程环境里）挡住本机别的进程；
 * - 会话的中继令牌只在内存里，不落盘；
 * - 路由未知 / 会话已结束：直接 404，不会落到别的会话的凭据上。
 */
export interface MuxRoute {
  readonly baseUrl: string;
  readonly token: string;
  readonly models: readonly { readonly id: string; readonly name?: string }[];
}

export const ROUTE_SEP = '~';

export function routedModel(route: string, model: string): string {
  return `${route}${ROUTE_SEP}${model}`;
}

export function splitRoutedModel(value: unknown): { route: string; model: string } | null {
  if (typeof value !== 'string') return null;
  const at = value.indexOf(ROUTE_SEP);
  if (at <= 0) return null;
  return { route: value.slice(0, at), model: value.slice(at + 1) };
}

export interface ProviderMux {
  readonly baseUrl: string;
  readonly key: string;
  add(route: MuxRoute): string;
  remove(route: string): void;
  size(): number;
  close(): Promise<void>;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new Error('too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function startProviderMux(): Promise<ProviderMux> {
  const routes = new Map<string, MuxRoute>();
  const key = randomBytes(24).toString('hex');
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) reply(res, 502, { error: { message: 'mux_failed' } });
      else res.destroy();
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${key}`) return reply(res, 401, { error: { message: 'unauthorized' } });
    const path = (req.url ?? '/').replace(/^\/v1/, '');
    if (req.method === 'GET' && path.startsWith('/models')) {
      // 列出所有会话的模型（带路由前缀）：Hermes 起网关/校验模型时会看这个列表
      const data = [...routes.entries()].flatMap(([route, value]) => value.models.map((model) => ({ id: routedModel(route, model.id), object: 'model' })));
      return reply(res, 200, { object: 'list', data });
    }
    if (req.method !== 'POST') return reply(res, 404, { error: { message: 'not_found' } });
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      return reply(res, 400, { error: { message: 'bad_json' } });
    }
    const split = splitRoutedModel(body['model']);
    const route = split ? routes.get(split.route) : undefined;
    if (!split || !route) return reply(res, 404, { error: { message: 'unknown_route' } });
    const out = Buffer.from(JSON.stringify({ ...body, model: split.model }));
    const target = new URL(`${route.baseUrl.replace(/\/$/, '')}${path}`);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = send(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(out.length),
        authorization: `Bearer ${route.token}`,
        ...(req.headers.accept ? { accept: req.headers.accept } : {})
      }
    });
    upstream.on('response', (response) => {
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'retry-after', 'cache-control']) {
        const value = response.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      res.writeHead(response.statusCode ?? 502, headers);
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) reply(res, 502, { error: { message: 'upstream_unreachable' } });
      else res.destroy();
    });
    res.on('close', () => upstream.destroy());
    upstream.end(out);
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    key,
    add(route) {
      const id = `r${randomBytes(6).toString('hex')}`;
      routes.set(id, route);
      return id;
    },
    remove(route) {
      routes.delete(route);
    },
    size: () => routes.size,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
