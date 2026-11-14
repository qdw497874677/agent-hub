import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { PreviewLink } from '@agent-hub/domain';
import { PreviewStreamError, type PreviewChannel, type PreviewHead, type PreviewStream } from './preview-channel.ts';

/**
 * 预览反代（docs/design/preview.md §7）：每个预览链接在 hub 的绑定地址上多开一个监听端口，
 * 把流量原样转给 worker 上的 `127.0.0.1:<port>`（经 `preview-channel.ts` 的 `/preview` WS）。
 *
 * 路径零重写：浏览器把 `http://hub:17901/foo` 当成独立 origin，dev server 的绝对路径、
 * redirect、cookie path、HMR 全都自然正确。这里只做鉴权、头改写与流式搬运。
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

/** 客户端发来的、不该转给上游的头（除了 hop-by-hop）。 */
const REQUEST_DROP = new Set(['host', 'expect']);

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_HEADER_TIMEOUT_MS = 10_000;
const DEFAULT_HOST = '127.0.0.1';

/** 上游不可达时的固定文案（设计稿 §7）。 */
export const PREVIEW_DOWN_TEXT = '服务没在跑：在会话终端里重新启动，或换一个端口';

const LOOPBACKS = new Set(['127.0.0.1', '::1', 'localhost']);

function normalizeAddress(address: string | undefined): string {
  return (address ?? '').replace(/^::ffff:/, '');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return LOOPBACKS.has(normalizeAddress(address));
}

/** 去掉 CSP 里的 `frame-ancestors`：我们自己的页面要 iframe 它，其余指令原样保留。 */
export function stripFrameAncestors(policy: string): string {
  return policy
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !/^frame-ancestors(\s|$)/i.test(part))
    .join('; ');
}

function headerValue(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return Array.isArray(value) ? value.join(', ') : value;
}

function requestHeaders(request: IncomingMessage, link: PreviewLink, proto: string, upgrade: boolean): Array<[string, string]> {
  const connectionTokens = new Set(
    headerValue(request.headers.connection)
      .toLowerCase()
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token !== '')
  );
  const out: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (REQUEST_DROP.has(lower) || lower.startsWith('proxy-')) continue;
    // WS 隧道要保留 upgrade / connection 的语义，等下面显式补；HTTP 请求则一律剔掉。
    if (HOP_BY_HOP.has(lower) && !(upgrade && (lower === 'upgrade' || lower === 'connection'))) continue;
    if (connectionTokens.has(lower)) continue;
    // permessage-deflate 关闭（设计稿 §7）：不透传扩展协商。
    if (upgrade && lower === 'sec-websocket-extensions') continue;
    for (const item of Array.isArray(value) ? value : [value]) out.push([name, item]);
  }
  out.push(['host', `127.0.0.1:${link.port}`]);
  const remote = normalizeAddress(request.socket.remoteAddress);
  const prior = headerValue(request.headers['x-forwarded-for']);
  out.push(['x-forwarded-for', prior === '' ? remote : `${prior}, ${remote}`]);
  out.push(['x-forwarded-proto', proto]);
  out.push(['x-forwarded-host', headerValue(request.headers.host)]);
  if (upgrade) {
    // 上游按 Upgrade 处理；这两条是剔掉后必须补回来的。
    out.push(['connection', 'Upgrade']);
    out.push(['upgrade', 'websocket']);
  }
  return out;
}

/** 响应的头：剥 `x-frame-options` / CSP `frame-ancestors` / hop-by-hop，其余原样。 */
function responseHeaders(head: PreviewHead, keepUpgradeHeaders: boolean): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [name, value] of head.headers) {
    const lower = name.toLowerCase();
    if (lower === 'x-frame-options') continue;
    if (lower.startsWith('proxy-')) continue;
    if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
      const cleaned = stripFrameAncestors(value);
      if (cleaned !== '') out.push([name, cleaned]);
      continue;
    }
    if (keepUpgradeHeaders) {
      if (lower === 'transfer-encoding' || lower === 'keep-alive' || lower === 'sec-websocket-extensions') continue;
      out.push([name, value]);
      continue;
    }
    if (HOP_BY_HOP.has(lower)) continue;
    out.push([name, value]);
  }
  if (keepUpgradeHeaders) {
    const names = new Set(out.map(([name]) => name.toLowerCase()));
    if (!names.has('connection')) out.push(['connection', 'Upgrade']);
    if (!names.has('upgrade')) out.push(['upgrade', 'websocket']);
  }
  return out;
}

function toHeaderObject(pairs: ReadonlyArray<readonly [string, string]>): Record<string, string | string[]> {
  const grouped = new Map<string, { name: string; values: string[] }>();
  for (const [name, value] of pairs) {
    const key = name.toLowerCase();
    const existing = grouped.get(key);
    if (existing) existing.values.push(value);
    else grouped.set(key, { name, values: [value] });
  }
  const out: Record<string, string | string[]> = {};
  for (const { name, values } of grouped.values()) out[name] = values.length === 1 ? (values[0] ?? '') : values;
  return out;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n]/g, ' ').trim();
}

function headerTimeoutText(milliseconds: number): string {
  return `预览超时：上游 ${Math.round(milliseconds / 1000)} 秒没有响应，服务可能还在启动`;
}

function sendText(response: ServerResponse, status: number, text: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = text;
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function failureText(error: unknown): { status: number; text: string } {
  if (error instanceof PreviewStreamError) {
    if (error.status === 504) return { status: 504, text: headerTimeoutText(DEFAULT_HEADER_TIMEOUT_MS) };
    if (error.status === 429) return { status: 429, text: '预览请求太多，稍后再试' };
    if (error.status === 403) return { status: 403, text: '无权访问这个预览' };
    if (error.status === 400) return { status: 400, text: error.message };
    return { status: error.status >= 400 && error.status <= 599 ? error.status : 502, text: PREVIEW_DOWN_TEXT };
  }
  return { status: 502, text: PREVIEW_DOWN_TEXT };
}

function writeRaw(
  socket: Duplex,
  status: number,
  reason: string,
  headers: ReadonlyArray<readonly [string, string]>,
  body = ''
): void {
  const lines = [`HTTP/1.1 ${status} ${sanitizeStatusText(reason) || 'Error'}`];
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  if (body !== '' && !headers.some(([name]) => name.toLowerCase() === 'content-length')) {
    lines.push(`content-length: ${Buffer.byteLength(body)}`);
  }
  lines.push('connection: close', '', body);
  socket.end(lines.join('\r\n'));
}

export interface PreviewProxyOptions {
  /** 按预览端口找链接；找不到就是 404。 */
  readonly resolve: (hubPort: number) => Promise<PreviewLink | null>;
  /** 未登录 / 无权访问 → false（反代 302 到登录页）。 */
  readonly authorize: (request: IncomingMessage, link: PreviewLink) => Promise<boolean>;
  readonly channel: PreviewChannel;
  /** 与 hub 相同的绑定地址（HUB_HOST），默认 127.0.0.1。 */
  readonly host?: string;
  readonly onLog?: (message: string) => void;
  /** `EADDRINUSE`：端口被占，装配方去把这条 link 标 stale。 */
  readonly onConflict?: (linkId: string) => void;
  /** 请求体上限，默认 10MiB。 */
  readonly maxBodyBytes?: number;
  /** 上游多久没回响应头就回 504 页，默认 10 秒（`open()` 本身不等 head）。 */
  readonly headerTimeoutMs?: number;
  /** 拼 `x-forwarded-proto`，默认 http。 */
  readonly proto?: string;
  /** 未授权时的跳转地址；默认相对 `/login?next=<原地址>`。 */
  readonly loginUrl?: (request: IncomingMessage, link: PreviewLink, target: string) => string;
  /** 测试用：默认按 remoteAddress 判回环。回环请求免鉴权（本机 dogfood / 健康检查）。 */
  readonly isLoopback?: (request: IncomingMessage) => boolean;
}

export interface PreviewProxy {
  listen(link: PreviewLink): Promise<void>;
  unlisten(linkId: string): Promise<void>;
  listenAll(links: readonly PreviewLink[]): Promise<void>;
  /** 正在监听 / 冲突过的端口 → link id（诊断与测试用）。 */
  listening(): ReadonlyArray<{ readonly linkId: string; readonly hubPort: number }>;
  close(): Promise<void>;
}

interface Listener {
  readonly link: PreviewLink;
  readonly server: Server;
  /** upgrade 之后的裸 socket 已从 http 解析器摘除，closeAllConnections() 管不到它们。 */
  readonly upgraded: Set<Duplex>;
}

export function createPreviewProxy(options: PreviewProxyOptions): PreviewProxy {
  const log = options.onLog ?? (() => {});
  const host = options.host ?? DEFAULT_HOST;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const headerTimeoutMs = options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
  const proto = options.proto ?? 'http';
  const listeners = new Map<string, Listener>();
  const byPort = new Map<number, Listener>();
  const closed = { value: false };

  async function lookup(hubPort: number): Promise<PreviewLink | null> {
    try {
      return await options.resolve(hubPort);
    } catch (error) {
      log(`预览链接解析失败（端口 ${hubPort}）：${messageOf(error)}`);
      return null;
    }
  }

  async function allowed(request: IncomingMessage, link: PreviewLink): Promise<boolean> {
    const loopback = options.isLoopback ?? ((candidate: IncomingMessage) => isLoopbackAddress(candidate.socket.remoteAddress));
    if (loopback(request)) return true;
    try {
      return await options.authorize(request, link);
    } catch (error) {
      log(`预览鉴权失败（${link.id}）：${messageOf(error)}`);
      return false;
    }
  }

  function loginTarget(request: IncomingMessage): string {
    const hostHeader = headerValue(request.headers.host);
    const origin = hostHeader === '' ? '' : `http://${hostHeader}`;
    return `${origin}${request.url ?? '/'}`;
  }

  function loginLocation(request: IncomingMessage, link: PreviewLink): string {
    const target = loginTarget(request);
    return options.loginUrl?.(request, link, target) ?? `/login?next=${encodeURIComponent(target)}`;
  }

  function redirectToLogin(request: IncomingMessage, response: ServerResponse, link: PreviewLink): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(302, { location: loginLocation(request, link), 'cache-control': 'no-store' });
    response.end();
  }

  function writeUpstreamHead(response: ServerResponse, head: PreviewHead): void {
    const headers = toHeaderObject(responseHeaders(head, false));
    const contentType = String(headers['content-type'] ?? '').toLowerCase();
    if (contentType.includes('text/html') && headers['cache-control'] === undefined) headers['cache-control'] = 'no-cache';
    const statusText = sanitizeStatusText(head.statusText);
    if (statusText === '') response.writeHead(head.status, headers);
    else response.writeHead(head.status, statusText, headers);
    // SSE 不能等缓冲：先把头刷出去，后续 data 边收边写。
    if (contentType.includes('text/event-stream')) response.flushHeaders();
  }

  async function handleHttp(request: IncomingMessage, response: ServerResponse, hubPort: number): Promise<void> {
    const link = await lookup(hubPort);
    if (!link) {
      sendText(response, 404, '预览链接不存在');
      return;
    }
    if (!(await allowed(request, link))) {
      redirectToLogin(request, response, link);
      return;
    }

    const method = (request.method ?? 'GET').toUpperCase();
    let stream: PreviewStream;
    try {
      stream = await options.channel.open(link.workerId, {
        port: link.port,
        method,
        path: request.url ?? '/',
        headers: requestHeaders(request, link, proto, false)
      });
    } catch (error) {
      const failure = failureText(error);
      sendText(response, failure.status, failure.text);
      return;
    }

    // `open()` 立刻返回：带 body 的请求要先把 `preview_body` 推给 worker，上游才会回 head。
    let answered = false;
    const timer = setTimeout(() => {
      if (answered) return;
      answered = true;
      sendText(response, 504, headerTimeoutText(headerTimeoutMs));
      stream.close();
    }, headerTimeoutMs);
    timer.unref();

    stream.onError((error) => {
      if (answered) {
        // 头已经发出去了：不能换状态码，只能断开让浏览器看到「传输中断」。
        if (!response.writableEnded) response.destroy();
        return;
      }
      answered = true;
      clearTimeout(timer);
      const failure = failureText(error);
      sendText(response, failure.status, failure.text);
    });

    stream.onHead((upstream) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      writeUpstreamHead(response, upstream);

      if (method === 'HEAD' || upstream.status === 204 || upstream.status === 304) {
        response.end();
        stream.close();
        return;
      }

      // 头之前到达的分片由 channel 缓存着，注册后立即补发。
      stream.onData((chunk) => {
        if (response.writableEnded || response.destroyed) return false;
        return response.write(chunk);
      });
      stream.onEnd(() => {
        if (!response.writableEnded) response.end();
      });
    });
    // 上游没回 head 就结束（或 body 在 head 之前就完了）：按不可达处理。
    stream.onEnd(() => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      sendText(response, 502, PREVIEW_DOWN_TEXT);
      stream.close();
    });

    // 浏览器提前关掉（关标签 / SSE 断开）：别让 worker 上的流挂着。
    response.on('close', () => {
      if (!response.writableEnded) stream.close();
    });

    // 请求体：有的话边收边转，没有也要告诉 worker「body 结束了」，否则它会一直等。
    const contentLength = Number(headerValue(request.headers['content-length']) || '0');
    const hasBody = (Number.isFinite(contentLength) && contentLength > 0) || request.headers['transfer-encoding'] !== undefined;
    if (!hasBody) {
      stream.endBody();
      return;
    }
    let received = 0;
    let overflow = false;
    request.on('data', (chunk: Buffer) => {
      if (overflow) return;
      received += chunk.length;
      if (received > maxBodyBytes) {
        overflow = true;
        log(`预览请求体超过 ${maxBodyBytes} 字节（${link.id}），中止`);
        if (!response.headersSent) sendText(response, 413, '请求体太大');
        else if (!response.writableEnded) response.destroy();
        stream.close();
        request.destroy();
        return;
      }
      stream.write(chunk);
    });
    request.on('end', () => {
      if (!overflow) stream.endBody();
    });
    request.on('error', () => stream.close());
    request.on('aborted', () => stream.close());
  }

  async function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    hubPort: number
  ): Promise<void> {
    const link = await lookup(hubPort);
    if (!link) {
      writeRaw(socket, 404, 'Not Found', [['content-type', 'text/plain; charset=utf-8']], '预览链接不存在');
      return;
    }
    if (!(await allowed(request, link))) {
      writeRaw(socket, 302, 'Found', [
        ['location', loginLocation(request, link)],
        ['content-length', '0'],
        ['cache-control', 'no-store']
      ]);
      return;
    }
    const protocol = request.headers['sec-websocket-protocol'];
    let stream: PreviewStream;
    try {
      stream = await options.channel.open(link.workerId, {
        port: link.port,
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: requestHeaders(request, link, proto, true),
        upgrade: { protocol: typeof protocol === 'string' ? protocol : null }
      });
    } catch (error) {
      const failure = failureText(error);
      writeRaw(
        socket,
        failure.status,
        failure.status === 504 ? 'Gateway Timeout' : 'Bad Gateway',
        [['content-type', 'text/plain; charset=utf-8']],
        failure.text
      );
      return;
    }

    const raw = socket as unknown as Socket;
    let responded = false;
    const timer = setTimeout(() => {
      if (responded) return;
      responded = true;
      writeRaw(
        socket,
        504,
        'Gateway Timeout',
        [['content-type', 'text/plain; charset=utf-8']],
        headerTimeoutText(headerTimeoutMs)
      );
      stream.close();
    }, headerTimeoutMs);
    timer.unref();

    stream.onHead((upstream) => {
      responded = true;
      clearTimeout(timer);
      if (upstream.status !== 101) {
        // 上游拒绝升级（或直接回了个普通响应）：把状态码和头原样交给浏览器，然后收尾。
        const lines = [`HTTP/1.1 ${upstream.status} ${sanitizeStatusText(upstream.statusText) || 'Error'}`];
        for (const [name, value] of responseHeaders(upstream, false)) lines.push(`${name}: ${value}`);
        lines.push('connection: close', '');
        socket.write(lines.join('\r\n') + '\r\n');
        stream.onData((chunk) => {
          if (!socket.destroyed) socket.write(chunk);
        });
        stream.onEnd(() => {
          if (!socket.destroyed) socket.end();
        });
        stream.onError(() => {
          if (!socket.destroyed) socket.destroy();
        });
        return;
      }

      const lines = ['HTTP/1.1 101 Switching Protocols'];
      for (const [name, value] of responseHeaders(upstream, true)) lines.push(`${name}: ${value}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      raw.setNoDelay?.(true);
      // 浏览器可能等 101 之前就发了帧；握手里剩下的 head 先补给 worker。
      if (head.length > 0) stream.write(head);

      socket.on('data', (chunk: Buffer) => stream.write(chunk));
      socket.on('end', () => stream.close());
      socket.on('close', () => stream.close());
      socket.on('error', () => stream.close());

      stream.onData((chunk) => {
        if (!socket.destroyed) socket.write(chunk);
      });
      stream.onEnd(() => {
        if (!socket.destroyed) socket.end();
      });
      stream.onError(() => {
        if (!socket.destroyed) socket.destroy();
      });
    });

    stream.onError((error) => {
      if (responded) return; // 101 之后由上面的回调处理
      clearTimeout(timer);
      const failure = failureText(error);
      writeRaw(
        socket,
        failure.status,
        failure.status === 504 ? 'Gateway Timeout' : 'Bad Gateway',
        [['content-type', 'text/plain; charset=utf-8']],
        failure.text
      );
    });

    // WS 隧道没有请求体：不发 `preview_body{end:true}`（worker 会把它当成隧道关闭）。
  }

  async function listen(link: PreviewLink): Promise<void> {
    if (closed.value) return;
    if (listeners.has(link.id)) return;
    const existing = byPort.get(link.hubPort);
    if (existing) await unlisten(existing.link.id);
    if (closed.value) return;

    const server = createServer((request, response) => {
      void handleHttp(request, response, link.hubPort).catch((error: unknown) => {
        log(`预览请求处理失败（${link.id}）：${messageOf(error)}`);
        if (!response.headersSent) sendText(response, 502, PREVIEW_DOWN_TEXT);
        else response.destroy();
      });
    });
    const listener: Listener = { link, server, upgraded: new Set<Duplex>() };
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      listener.upgraded.add(socket);
      socket.once('close', () => listener.upgraded.delete(socket));
      void handleUpgrade(request, socket, head, link.hubPort).catch((error: unknown) => {
        log(`预览 WS 处理失败（${link.id}）：${messageOf(error)}`);
        if (!socket.destroyed) socket.destroy();
      });
    });
    listeners.set(link.id, listener);
    byPort.set(link.hubPort, listener);

    await new Promise<void>((resolveListen) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        if (listeners.get(link.id) === listener) listeners.delete(link.id);
        if (byPort.get(link.hubPort) === listener) byPort.delete(link.hubPort);
        log(`预览端口 ${link.hubPort} 监听失败：${error.code ?? messageOf(error)}`);
        if (error.code === 'EADDRINUSE') options.onConflict?.(link.id);
        server.close(() => resolveListen());
      };
      server.once('error', onError);
      server.listen(link.hubPort, host, () => {
        server.off('error', onError);
        server.on('error', (error: Error) => log(`预览端口 ${link.hubPort} 出错：${messageOf(error)}`));
        resolveListen();
      });
    });
  }

  async function unlisten(linkId: string): Promise<void> {
    const listener = listeners.get(linkId);
    if (!listener) return;
    listeners.delete(linkId);
    if (byPort.get(listener.link.hubPort) === listener) byPort.delete(listener.link.hubPort);
    const { server } = listener;
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      // keep-alive 与 WS 隧道都不会自己结束：不主动断开，close() 会一直等。
      for (const socket of listener.upgraded) socket.destroy();
      listener.upgraded.clear();
      server.closeAllConnections();
    });
  }

  return {
    listen,
    unlisten,
    async listenAll(links: readonly PreviewLink[]): Promise<void> {
      await Promise.all(links.map((link) => listen(link)));
    },
    listening(): ReadonlyArray<{ readonly linkId: string; readonly hubPort: number }> {
      return [...listeners.values()].map(({ link }) => ({ linkId: link.id, hubPort: link.hubPort }));
    },
    async close(): Promise<void> {
      closed.value = true;
      await Promise.all([...listeners.keys()].map((linkId) => unlisten(linkId)));
      listeners.clear();
      byPort.clear();
    }
  };
}
