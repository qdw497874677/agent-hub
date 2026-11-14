import type { PreviewLink } from '@agent-hub/domain';
import { PREVIEW_DOWN_TEXT } from './preview-proxy.ts';
import type { PreviewChannel, PreviewStream } from './preview-channel.ts';

/**
 * 预览的「路径前缀」模式（docs/design/preview.md §5，P4）。
 *
 * 默认模式是每条链接占一个 hub 端口；云上安全组只放通 hub 一个端口时，
 * 可以设 `HUB_PREVIEW_PREFIX=/preview`，让链接挂在 `<hub>/preview/<linkId>/…` 下。
 *
 * 差异（写清楚，省得以后当成 bug）：
 * - HTTP 全支持：流式响应、SSE、重定向、HEAD。
 * - **WebSocket 不支持**（HMR 会退化成整页刷新；需要 HMR 就继续用端口模式）。
 * - 路径原样透传（`/preview/<id>/assets/a.js` → worker 的 `/assets/a.js`），不做任何重写。
 */
export interface PreviewPrefixOptions {
  /** 形如 `/preview`，不带结尾斜杠。 */
  readonly prefix: string;
  readonly resolve: (linkId: string) => Promise<PreviewLink | null>;
  /** 复用端口模式的鉴权（cookie + `session.read` / 分享令牌）。 */
  readonly authorize: (request: Request, link: PreviewLink) => Promise<boolean>;
  readonly channel: PreviewChannel;
  /** 未授权时跳哪（默认回 hub 登录页）。 */
  readonly loginUrl?: (request: Request, link: PreviewLink, target: string) => string;
  readonly maxBodyBytes?: number;
  readonly headTimeoutMs?: number;
  readonly onLog?: (message: string) => void;
}

export interface PreviewPrefix {
  /** 命中前缀返回 Response；不命中返回 null（交给后面的路由）。 */
  handle(request: Request): Promise<Response | null>;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length'
]);

const stripHopByHop = (headers: Headers): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    out.push([key, value]);
  });
  return out;
};

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const downPage = (): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>预览没有响应</title><body style="font:14px system-ui;padding:24px;line-height:1.6">${escapeHtml(PREVIEW_DOWN_TEXT)}</body>`,
    { status: 502, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );

export function createPreviewPrefix(options: PreviewPrefixOptions): PreviewPrefix {
  const prefix = options.prefix.endsWith('/') ? options.prefix.slice(0, -1) : options.prefix;
  const maxBody = options.maxBodyBytes ?? 10 * 1024 * 1024;
  const headTimeout = options.headTimeoutMs ?? 10_000;
  const log = options.onLog ?? (() => undefined);

  const handle = async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
    const rest = url.pathname.slice(prefix.length).replace(/^\/+/, '');
    const [rawId = '', ...tail] = rest.split('/');
    if (rawId === '') {
      return new Response('缺少预览链接 id', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const link = await options.resolve(rawId);
    if (link === null) return new Response('预览链接不存在', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (!(await options.authorize(request, link))) {
      const target = `${url.pathname}${url.search}`;
      const location = options.loginUrl?.(request, link, target) ?? `/login?next=${encodeURIComponent(target)}`;
      return new Response(null, { status: 302, headers: { location } });
    }
    if (link.state === 'offline') return downPage();

    const path = `/${tail.join('/')}${url.search}`;
    const headers = stripHopByHop(request.headers);
    headers.push(['host', `127.0.0.1:${link.port}`]);
    headers.push(['x-forwarded-proto', url.protocol.replace(':', '')]);

    let body: Uint8Array | null = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const buffer = new Uint8Array(await request.arrayBuffer());
      if (buffer.byteLength > maxBody) {
        return new Response('请求体太大', { status: 413, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      body = buffer;
    }

    let stream: PreviewStream;
    try {
      stream = await options.channel.open(link.workerId, {
        port: link.port,
        method: request.method,
        path,
        headers
      });
    } catch (failure) {
      log(`前缀模式打开失败：${(failure as Error).message}`);
      return downPage();
    }

    const head = await new Promise<{ status: number; headers: Array<[string, string]> } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), headTimeout);
      stream.onHead((value) => {
        clearTimeout(timer);
        resolve({ status: value.status, headers: value.headers.map(([key, val]): [string, string] => [key, val]) });
      });
      stream.onError(() => {
        clearTimeout(timer);
        resolve(null);
      });
      // 空请求体也要显式告诉 worker，否则它会一直等。
      if (body === null) stream.endBody();
      else stream.write(body, true);
    });
    if (head === null) {
      stream.close();
      return downPage();
    }

    const out = new Headers();
    for (const [key, value] of head.headers) {
      const lower = key.toLowerCase();
      if (lower === 'x-frame-options') continue;
      if (lower === 'content-length') continue;
      if (lower === 'content-encoding') continue;
      if (lower === 'connection' || lower === 'transfer-encoding') continue;
      if (lower === 'frame-ancestors') continue;
      if (lower === 'content-security-policy') {
        const kept = value
          .split(';')
          .map((part) => part.trim())
          .filter((part) => !/^frame-ancestors\b/i.test(part))
          .join('; ');
        out.set(key, `${kept}${kept === '' ? '' : '; '}frame-ancestors 'self'`);
        continue;
      }
      out.append(key, value);
    }
    if (request.method === 'HEAD' || head.status === 204 || head.status === 304) {
      stream.close();
      return new Response(null, { status: head.status, headers: out });
    }

    // 每帧最多 64KiB，窗口 8 帧：先给 8，收到一帧再补回 8（窗口是「允许未确认的数量」）。
    stream.ack(8);
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        stream.onData((chunk) => {
          controller.enqueue(new Uint8Array(chunk));
          stream.ack(8);
          return true;
        });
        stream.onEnd(() => {
          try {
            controller.close();
          } catch {
            // 已经被取消
          }
        });
        stream.onError((error) => {
          log(`前缀模式转发中断：${error.message}`);
          try {
            controller.close();
          } catch {
            // 已经被取消
          }
        });
      },
      cancel() {
        stream.close();
      }
    });
    return new Response(readable, { status: head.status, headers: out });
  };

  return { handle };
}
