import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { WebSocket } from 'ws';
import {
  PREVIEW_FRAME_BYTES,
  PREVIEW_MAX_PAYLOAD,
  PREVIEW_LISTENER_IDENTITY_HEADER,
  previewConnectionTokensFromPairs,
  previewRequestHeaderDropped,
  previewResponseHeaderDropped,
  previewUpSchema,
  type PreviewDownFrame,
  type PreviewUpFrame
} from '@agent-hub/contract';
import { portsInOutput, scanListeningPorts } from './preview-scan.ts';
import { verifyConnectedListener, verifyListenerIdentity } from './process-scan.ts';

/**
 * 预览通道（docs/design/preview.md §6）：worker 主动连 hub 的 `/preview`，
 * hub 每来一个浏览器请求就发 `preview_open`，我们把流量转到本机回环端口，
 * 再把结果按帧回传。帧契约在 `packages/contract/src/wire/preview.ts`。
 *
 * 两条独立的路由：
 * - 普通 HTTP：`http.request` 打到 `127.0.0.1:<port>`，改写 Host、补 X-Forwarded-*；
 * - WS 隧道（`preview_open.upgrade`）：`net.connect` 后手写 upgrade 请求，101 之后双向裸字节。
 *
 * 背压：每条流 8 个 credits，每发一帧 `preview_data` 扣 1，为 0 就停读上游；
 * `preview_ack` 补窗口，`preview_pause`/`preview_resume` 是 hub 侧的缓冲水位。
 */

export interface PreviewClientOptions {
  /** hub 的预览通道地址，例如 `ws://127.0.0.1:7878/preview`。 */
  readonly url: string;
  /** 单机接入换来的凭据（`ahw_…`）；与 `/worker` 是同一份。null = 没有（本机 Worker 走 localSecret）。 */
  readonly credential: string | null;
  /** 本机口令（HUB_LOCAL_SECRET）：和凭据一样放握手头里。 */
  readonly localSecret?: string;
  /** 本机 Worker 自报 id（没有专属凭据时 hub 靠它认人）。 */
  readonly workerId?: string;
  readonly onLog?: (message: string) => void;
  /** 每 worker 并发流上限，默认 32。 */
  readonly maxStreams?: number;
  /** 等上游响应头的超时，默认 10 秒。 */
  readonly headerTimeoutMs?: number;
  /** 读本机正在监听的端口；测试注入，默认 `scanListeningPorts`。 */
  readonly scanPorts?: () => number[];
}

export interface PreviewClient {
  start(): void;
  stop(): Promise<void>;
  /** 当前打开的流数量（观测 / 测试用）。 */
  activeStreams(): number;
  /**
   * 从会话的终端输出里发现端口（docs/design/preview.md §5）。
   * 只有端口确实在 `/proc` 里 LISTEN 才发 `preview_detected`；同一 `sessionId+port` 只发一次。
   */
  detect(sessionId: string, text: string): void;
}

/** 单条预览链接（这里只能按端口区分）的并发上限。 */
const PER_PORT_LIMIT = 8;
const DEFAULT_MAX_STREAMS = 32;
const DEFAULT_HEADER_TIMEOUT_MS = 10_000;
const INITIAL_CREDITS = 8;
/** 重连退避：2s → 4s → … → 30s。 */
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 30_000;
const MAX_TUNNEL_HEAD_BYTES = 64 * 1024;
/** 监听端口的刷新间隔（端口随 agent 起服务而变，10 秒足够，也不至于频繁读 /proc）。 */
const SCAN_INTERVAL_MS = 10_000;
/** 契约 `preview_ports.ports` 的上限；本机监听端口再多也只报前 256 个。 */
const MAX_REPORTED_PORTS = 256;

type FailureCode = 'refused' | 'timeout' | 'forbidden';

interface StreamState {
  readonly streamId: string;
  readonly port: number;
  readonly tunnel: boolean;
  credits: number;
  hubPaused: boolean;
  closed: boolean;
  headersSent: boolean;
  upstreamEnded: boolean;
  /** 已经从上游读到、但还没变成 `preview_data` 的字节（credits 用尽时堆在这里）。 */
  readonly queue: Buffer[];
  req?: ClientRequest;
  res?: IncomingMessage;
  socket?: Socket;
  headerTimer?: NodeJS.Timeout;
  writeUpstream: (chunk: Buffer) => void;
  endUpstream: () => void;
  pauseSource: () => void;
  resumeSource: () => void;
}

type HeaderPairs = ReadonlyArray<readonly [string, string]>;

export function createPreviewClient(options: PreviewClientOptions): PreviewClient {
  const maxStreams = Math.max(1, options.maxStreams ?? DEFAULT_MAX_STREAMS);
  const headerTimeoutMs = Math.max(200, options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS);
  const log = (message: string): void => options.onLog?.(message);

  const streams = new Map<string, StreamState>();
  const perPort = new Map<number, number>();
  const scanPorts = options.scanPorts ?? ((): number[] => scanListeningPorts());
  /** 最近一次扫到的监听端口：`detect` 只上报在里面的（/proc 是唯一可信来源）。 */
  const listening = new Set<number>();
  /** 已经报过的 `sessionId+port`：一个客户端生命周期内只报一次。 */
  const announced = new Set<string>();
  let scanTimer: NodeJS.Timeout | null = null;
  let ws: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;

  function isOpen(): boolean {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  }

  /** 刷新监听端口并上报；连接没建立时 `send` 自己会跳过，本地集合照常更新。 */
  function scanAndReport(): void {
    try {
      const ports = scanPorts();
      listening.clear();
      for (const port of ports) listening.add(port);
    } catch (error) {
      log(`扫描监听端口失败：${error instanceof Error ? error.message : String(error)}`);
    }
    send({ kind: 'preview_ports', ports: [...listening].sort((a, b) => a - b).slice(0, MAX_REPORTED_PORTS) });
  }

  function startScanTimer(): void {
    if (scanTimer !== null) return;
    scanTimer = setInterval(scanAndReport, SCAN_INTERVAL_MS);
    scanTimer.unref?.();
  }

  function stopScanTimer(): void {
    if (scanTimer === null) return;
    clearInterval(scanTimer);
    scanTimer = null;
  }

  function send(frame: PreviewDownFrame): void {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  }

  /** 握手头：设计和 `/worker` 一样用 Bearer；本机 Worker 额外带 localSecret。 */
  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    headers[PREVIEW_LISTENER_IDENTITY_HEADER] = '1';
    if (options.credential !== null && options.credential !== '') headers['authorization'] = `Bearer ${options.credential}`;
    if (options.localSecret !== undefined && options.localSecret !== '') headers['x-hub-local-secret'] = options.localSecret;
    if (options.workerId !== undefined && options.workerId !== '') headers['x-hub-worker-id'] = options.workerId;
    return headers;
  }

  function connect(): void {
    if (stopped) return;
    const socket = new WebSocket(options.url, {
      headers: authHeaders(),
      maxPayload: PREVIEW_MAX_PAYLOAD
    });
    ws = socket;

    socket.on('open', () => {
      attempt = 0;
      log(`预览通道已连上 ${options.url}`);
      // 重连成功后立刻补一次端口清单：断线期间端口可能已经变了。
      scanAndReport();
    });

    socket.on('message', (raw: Buffer | string) => {
      let json: unknown;
      try {
        json = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        log('预览通道收到非 JSON 帧');
        return;
      }
      const parsed = previewUpSchema.safeParse(json);
      if (!parsed.success) {
        log(`预览通道收到不认识的帧：${parsed.error.issues[0]?.message ?? 'schema 不匹配'}`);
        return;
      }
      handleFrame(parsed.data);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      if (ws === socket) ws = null;
      // 流属于这条连接：断了就全销毁，重连后 hub 会重新 open。
      dropAllStreams();
      if (stopped) return;
      if (code === 4426 || code === 4401 || code === 4403) {
        stopped = true;
        log(
          code === 4426
            ? `预览通道协议不兼容（${reason.toString() || '版本不一致'}），不再重连`
            : `预览通道被 hub 拒绝（${reason.toString() || `关闭码 ${code}`}），不再重连`
        );
        return;
      }
      const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, 10));
      attempt += 1;
      log(`预览通道断开（${code}），${(delay / 1000).toFixed(1)} 秒后重连`);
      reconnectTimer = setTimeout(connect, delay);
      reconnectTimer.unref?.();
    });

    socket.on('error', (error: Error) => {
      log(`预览通道错误：${error.message}`);
    });
  }

  function handleFrame(frame: PreviewUpFrame): void {
    switch (frame.kind) {
      case 'preview_open':
        openStream(frame);
        return;
      case 'preview_body': {
        const stream = streams.get(frame.streamId);
        if (!stream || stream.closed) return;
        const data = Buffer.from(frame.data, 'base64');
        if (data.length > 0) stream.writeUpstream(data);
        if (frame.end) stream.endUpstream();
        return;
      }
      case 'preview_close': {
        const stream = streams.get(frame.streamId);
        if (stream) finish(stream, false);
        return;
      }
      case 'preview_ack': {
        const stream = streams.get(frame.streamId);
        if (!stream || stream.closed) return;
        stream.credits = Math.min(1024, stream.credits + frame.credits);
        drain(stream);
        return;
      }
      case 'preview_pause': {
        const stream = streams.get(frame.streamId);
        if (!stream || stream.closed) return;
        stream.hubPaused = true;
        stream.pauseSource();
        return;
      }
      case 'preview_resume': {
        const stream = streams.get(frame.streamId);
        if (!stream || stream.closed) return;
        stream.hubPaused = false;
        drain(stream);
        return;
      }
    }
  }

  function openStream(frame: Extract<PreviewUpFrame, { kind: 'preview_open' }>): void {
    if (streams.has(frame.streamId)) {
      log(`预览流 ${frame.streamId} 重复打开，忽略`);
      return;
    }
    const port = frame.port;
    if (frame.listenerIdentity !== undefined && !verifyListenerIdentity(port, frame.listenerIdentity)) {
      send({ kind: 'preview_failed', streamId: frame.streamId, code: 'forbidden', message: '监听服务已变化' });
      return;
    }
    const used = perPort.get(port) ?? 0;
    if (streams.size >= maxStreams || used >= PER_PORT_LIMIT) {
      send({ kind: 'preview_failed', streamId: frame.streamId, code: 'forbidden', message: '预览流太多了' });
      return;
    }

    const stream: StreamState = {
      streamId: frame.streamId,
      port,
      tunnel: frame.upgrade !== undefined,
      credits: INITIAL_CREDITS,
      hubPaused: false,
      closed: false,
      headersSent: false,
      upstreamEnded: false,
      queue: [],
      writeUpstream: () => undefined,
      endUpstream: () => undefined,
      pauseSource: () => undefined,
      resumeSource: () => undefined
    };
    streams.set(stream.streamId, stream);
    perPort.set(port, used + 1);

    if (frame.listenerIdentity === undefined) {
      if (frame.upgrade !== undefined) openTunnel(stream, frame);
      else openHttp(stream, frame);
      return;
    }
    const socket = netConnect({ host: '127.0.0.1', port });
    stream.socket = socket;
    const pending: Buffer[] = [];
    let pendingBytes = 0;
    let pendingEnd = false;
    stream.writeUpstream = (chunk) => {
      if ((pendingBytes += chunk.length) > PREVIEW_MAX_PAYLOAD) fail(stream, 'forbidden', '预览请求过大');
      else pending.push(chunk);
    };
    stream.endUpstream = () => { pendingEnd = true; };
    stream.headerTimer = setTimeout(() => fail(stream, 'timeout', '连接监听服务超时'), headerTimeoutMs);
    stream.headerTimer.unref?.();
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (!stream.closed && !stream.headersSent) fail(stream, failureCode(error), '连接监听服务失败');
    });
    socket.once('connect', () => {
      void verifyConnectedListener(socket, port, frame.listenerIdentity!).then((valid) => {
        if (stream.closed) return;
        if (!valid) { fail(stream, 'forbidden', '监听服务已变化或无法验证'); return; }
        if (stream.headerTimer) clearTimeout(stream.headerTimer);
        stream.headerTimer = undefined;
        if (frame.upgrade !== undefined) openTunnel(stream, frame, socket);
        else openHttp(stream, frame, socket);
        for (const chunk of pending) stream.writeUpstream(chunk);
        if (pendingEnd) stream.endUpstream();
      }).catch(() => fail(stream, 'forbidden', '无法验证监听服务'));
    });
  }

  /**
   * 上游头：Host 改写成回环地址，剥掉逐跳头 / hub 私头 / Connection 点名的动态逐跳头，补 X-Forwarded-*。
   *
   * 规则与 hub 入口同一份（contract 的 `previewRequestHeaderDropped`）。hub 已经在入口剥过一次，
   * 这里再剥是纵深防御：worker 能连本机任意端口，不该假设所有入口都已经做对了。
   */
  function rewriteHeaders(headers: HeaderPairs, port: number, proto: string, upgrade: boolean): Array<[string, string]> {
    const originalHost = headers.find(([name]) => name.toLowerCase() === 'host')?.[1];
    const forwardedHost = headers.find(([name]) => name.toLowerCase() === 'x-forwarded-host')?.[1];
    const forwardedProto = headers.find(([name]) => name.toLowerCase() === 'x-forwarded-proto')?.[1];
    const connectionTokens = previewConnectionTokensFromPairs(headers);
    const out: Array<[string, string]> = [];
    for (const [name, value] of headers) {
      if (previewRequestHeaderDropped(name, { upgrade, connectionTokens })) continue;
      out.push([name, value]);
    }
    out.push(['host', `127.0.0.1:${port}`]);
    // hub 给的 x-forwarded-host 是浏览器看到的 Host；别再拿回环地址把它覆盖掉，也别重复追加。
    if ((forwardedHost === undefined || forwardedHost === '') && originalHost !== undefined && originalHost !== '') {
      out.push(['x-forwarded-host', originalHost]);
    }
    // 同理：hub 已经标明协议就不要再叠一条。
    if (forwardedProto === undefined || forwardedProto === '') out.push(['x-forwarded-proto', proto]);
    return out;
  }

  function toNodeHeaders(pairs: HeaderPairs): Record<string, string | string[]> {
    const grouped = new Map<string, string[]>();
    for (const [name, value] of pairs) {
      const key = name.toLowerCase();
      const list = grouped.get(key);
      if (list) list.push(value);
      else grouped.set(key, [value]);
    }
    const out: Record<string, string | string[]> = {};
    for (const [key, values] of grouped) out[key] = values.length === 1 ? values[0]! : values;
    return out;
  }

  function fail(stream: StreamState, code: FailureCode, message: string): void {
    if (stream.closed) return;
    finish(stream, false);
    send({ kind: 'preview_failed', streamId: stream.streamId, code, message });
  }

  function failureCode(error: NodeJS.ErrnoException): FailureCode {
    return error.code === 'ETIMEDOUT' ? 'timeout' : 'refused';
  }

  function openHttp(stream: StreamState, frame: Extract<PreviewUpFrame, { kind: 'preview_open' }>, connected?: Socket): void {
    const headers = rewriteHeaders(frame.headers, frame.port, 'http', false);
    let req: ClientRequest;
    try {
      const agent = connected === undefined ? false : new Agent({ keepAlive: false });
      if (agent !== false) {
        agent.createConnection = () => connected!;
      }
      req = httpRequest({
        host: '127.0.0.1',
        port: frame.port,
        method: frame.method,
        path: frame.path,
        headers: toNodeHeaders(headers),
        agent,
        setHost: false,
        timeout: headerTimeoutMs
      });
    } catch (error) {
      fail(stream, 'refused', `构造上游请求失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    stream.req = req;
    stream.writeUpstream = (chunk) => {
      if (!req.destroyed && !req.writableEnded) req.write(chunk);
    };
    stream.endUpstream = () => {
      if (!req.destroyed && !req.writableEnded) req.end();
    };

    req.on('timeout', () => {
      if (stream.headersSent) return;
      fail(stream, 'timeout', `上游 127.0.0.1:${frame.port} 在 ${headerTimeoutMs}ms 内没有响应头`);
    });

    req.on('error', (error: NodeJS.ErrnoException) => {
      if (stream.closed) return;
      // 头已经发出去了：这只是一次半路断开，按结束处理，不再回 failed。
      if (stream.headersSent) finish(stream, true);
      else fail(stream, failureCode(error), `连不上上游 127.0.0.1:${frame.port}：${error.message}`);
    });

    req.on('response', (res: IncomingMessage) => {
      if (stream.closed) {
        res.destroy();
        return;
      }
      stream.headersSent = true;
      stream.res = res;
      req.setTimeout(0);
      send({
        kind: 'preview_head',
        streamId: stream.streamId,
        status: res.statusCode ?? 502,
        statusText: res.statusMessage ?? '',
        headers: responseHeaders(res)
      });
      stream.pauseSource = () => res.pause();
      stream.resumeSource = () => res.resume();
      res.on('data', (chunk: Buffer) => enqueue(stream, chunk));
      res.on('end', () => {
        stream.upstreamEnded = true;
        maybeEnd(stream);
      });
      res.on('error', () => {
        if (!stream.closed) finish(stream, true);
      });
    });

    // 没有请求体的方法（GET 等）直接结束；有 content-length/chunked 的等 preview_body end。
    const length = headerValue(frame.headers, 'content-length');
    const chunked = headerValue(frame.headers, 'transfer-encoding') !== undefined;
    if (!chunked && (length === undefined || length === '0')) req.end();
  }

  /**
   * 回给 hub 的响应头：共享响应谓词（逐跳、`set-cookie`、`proxy-*`、Connection 点名的动态字段）。
   * CSP / Referrer-Policy / x-frame-options 留给 hub 按模式处理，两种模式的策略本来就不同。
   */
  function responseHeaders(res: IncomingMessage): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];
    for (let index = 0; index + 1 < res.rawHeaders.length; index += 2) {
      pairs.push([res.rawHeaders[index]!, res.rawHeaders[index + 1]!]);
    }
    const connectionTokens = previewConnectionTokensFromPairs(pairs);
    return pairs.filter(([name]) => !previewResponseHeaderDropped(name, { connectionTokens }));
  }

  function openTunnel(stream: StreamState, frame: Extract<PreviewUpFrame, { kind: 'preview_open' }>, connected?: Socket): void {
    // `frame.upgrade.protocol` 是浏览器的 Sec-WebSocket-Protocol（子协议），不是 Upgrade 令牌。
    // 拿它当升级令牌会发出 `upgrade: graphql-ws` 这种非法握手；升级令牌固定 websocket，
    // 子协议本身随 `sec-websocket-protocol` 头原样转给上游。
    const headers = rewriteHeaders(frame.headers, frame.port, 'ws', true);
    const lines = [
      `${frame.method} ${frame.path} HTTP/1.1`,
      ...headers.map(([name, value]) => `${name}: ${value}`),
      'connection: Upgrade',
      'upgrade: websocket',
      '',
      ''
    ];
    const socket = connected ?? netConnect({ host: '127.0.0.1', port: frame.port });
    stream.socket = socket;
    socket.setNoDelay(true);
    let verified = frame.listenerIdentity === undefined;
    let pendingBytes = 0;
    const pending: Buffer[] = [];
    let pendingEnd = false;
    stream.writeUpstream = (chunk) => {
      if (socket.destroyed) return;
      if (verified) socket.write(chunk);
      else if ((pendingBytes += chunk.length) <= PREVIEW_MAX_PAYLOAD) pending.push(chunk);
      else fail(stream, 'forbidden', '预览请求过大');
    };
    stream.endUpstream = () => {
      if (socket.destroyed) return;
      if (verified) socket.end();
      else pendingEnd = true;
    };
    stream.pauseSource = () => socket.pause();
    stream.resumeSource = () => socket.resume();

    stream.headerTimer = setTimeout(() => {
      if (stream.headersSent) return;
      fail(stream, 'timeout', `上游 127.0.0.1:${frame.port} 在 ${headerTimeoutMs}ms 内没有响应头`);
    }, headerTimeoutMs);
    stream.headerTimer.unref?.();

    let buffered = Buffer.alloc(0);

    const sendHead = (): void => {
      verified = true;
      if (!socket.destroyed) {
        socket.write(lines.join('\r\n'));
        for (const chunk of pending) socket.write(chunk);
        if (pendingEnd) socket.end();
      }
    };
    if (connected) sendHead();
    else socket.on('connect', sendHead);

    socket.on('data', (chunk: Buffer) => {
      if (stream.closed) return;
      buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk]);

      if (!stream.headersSent) {
        const end = buffered.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buffered.length > MAX_TUNNEL_HEAD_BYTES) fail(stream, 'refused', '上游响应头太大');
          return;
        }
        const head = parseUpstreamHead(buffered.subarray(0, end).toString('latin1'));
        buffered = Buffer.from(buffered.subarray(end + 4));
        if (head === null) {
          fail(stream, 'refused', '上游回的不是 HTTP 响应');
          return;
        }
        stream.headersSent = true;
        if (stream.headerTimer) clearTimeout(stream.headerTimer);
        send({
          kind: 'preview_head',
          streamId: stream.streamId,
          status: head.status,
          statusText: head.statusText,
          headers: tunnelResponseHeaders(head.status, head.headers)
        });
        // 非 101 也照常把剩余字节当响应体转出去，socket 关掉就结束。
      }

      if (buffered.length > 0) {
        const rest = buffered;
        buffered = Buffer.alloc(0);
        enqueue(stream, rest);
      }
    });

    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (stream.closed) return;
      if (stream.headersSent) finish(stream, true);
      else fail(stream, failureCode(error), `连不上上游 127.0.0.1:${frame.port}：${error.message}`);
    });

    socket.on('close', () => {
      if (stream.closed) return;
      if (stream.headersSent) {
        stream.upstreamEnded = true;
        maybeEnd(stream);
      } else {
        fail(stream, 'refused', `上游 127.0.0.1:${frame.port} 关掉了连接`);
      }
    });
  }

  function headerValue(headers: HeaderPairs, name: string): string | undefined {
    const lower = name.toLowerCase();
    return headers.find(([key]) => key.toLowerCase() === lower)?.[1];
  }

  function parseUpstreamHead(head: string): { status: number; statusText: string; headers: Array<[string, string]> } | null {
    const lines = head.split('\r\n');
    const first = lines[0] ?? '';
    const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(first);
    if (match === null) return null;
    const headers: Array<[string, string]> = [];
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
    return { status: Number(match[1]), statusText: match[2] ?? '', headers };
  }

  /**
   * 隧道响应头：和普通 HTTP 用同一份响应谓词（逐跳 / `set-cookie` / `proxy-*` / 动态 Connection）。
   *
   * 只对 101 补唯一的 `connection: Upgrade` + `upgrade: websocket`；非 101 不补，保持「普通响应」
   * 语义。`sec-websocket-protocol` / `sec-websocket-accept` 是协商结果，101 上强制保留；
   * `content-length` 等帧格式相关头不动——非 101 的 body 仍按原字节转给 hub。
   */
  function tunnelResponseHeaders(status: number, headers: HeaderPairs): Array<[string, string]> {
    const upgrade = status === 101;
    const connectionTokens = previewConnectionTokensFromPairs(headers);
    const out: Array<[string, string]> = [];
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (upgrade && (lower === 'sec-websocket-protocol' || lower === 'sec-websocket-accept')) {
        out.push([name, value]);
        continue;
      }
      if (previewResponseHeaderDropped(name, { connectionTokens })) continue;
      // permessage-deflate 关闭（设计稿 §7）：101 上不透传扩展协商。
      if (upgrade && lower === 'sec-websocket-extensions') continue;
      out.push([name, value]);
    }
    if (upgrade) {
      out.push(['connection', 'Upgrade'], ['upgrade', 'websocket']);
    }
    return out;
  }

  function enqueue(stream: StreamState, chunk: Buffer): void {
    if (stream.closed || chunk.length === 0) return;
    stream.queue.push(chunk);
    drain(stream);
  }

  /** 把队列里的字节按 credits 发出去；发不动就停读上游。 */
  function drain(stream: StreamState): void {
    while (!stream.closed && !stream.hubPaused && stream.credits > 0 && stream.queue.length > 0) {
      const head = stream.queue[0]!;
      const take = head.length > PREVIEW_FRAME_BYTES ? head.subarray(0, PREVIEW_FRAME_BYTES) : head;
      if (take.length === head.length) stream.queue.shift();
      else stream.queue[0] = head.subarray(take.length);
      stream.credits -= 1;
      send({ kind: 'preview_data', streamId: stream.streamId, data: take.toString('base64') });
    }
    if (stream.closed) return;
    if (stream.queue.length > 0 || stream.credits <= 0 || stream.hubPaused) {
      stream.pauseSource();
      return;
    }
    stream.resumeSource();
    maybeEnd(stream);
  }

  function maybeEnd(stream: StreamState): void {
    if (stream.closed || !stream.upstreamEnded) return;
    if (stream.queue.length > 0) return;
    finish(stream, true);
  }

  /** 结束一条流并释放名额；`sendEnd` 为 true 时补一帧 `preview_end`。 */
  function finish(stream: StreamState, sendEnd: boolean): void {
    if (stream.closed) return;
    stream.closed = true;
    if (stream.headerTimer) clearTimeout(stream.headerTimer);
    streams.delete(stream.streamId);
    const used = perPort.get(stream.port) ?? 0;
    if (used <= 1) perPort.delete(stream.port);
    else perPort.set(stream.port, used - 1);
    stream.queue.length = 0;
    if (stream.req && !stream.req.destroyed) stream.req.destroy();
    if (stream.res && !stream.res.destroyed) stream.res.destroy();
    if (stream.socket && !stream.socket.destroyed) stream.socket.destroy();
    if (sendEnd) send({ kind: 'preview_end', streamId: stream.streamId });
  }

  function dropAllStreams(): void {
    for (const stream of [...streams.values()]) finish(stream, false);
  }

  return {
    start(): void {
      if (ws !== null || stopped) return;
      stopped = false;
      connect();
      startScanTimer();
    },
    async stop(): Promise<void> {
      stopped = true;
      stopScanTimer();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      dropAllStreams();
      const socket = ws;
      ws = null;
      if (socket === null || socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            socket.terminate();
          } catch {
            // 已经断了
          }
          resolve();
        }, 1_000);
        timer.unref?.();
        socket.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          socket.close();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    },
    activeStreams(): number {
      return streams.size;
    },
    detect(sessionId: string, text: string): void {
      // 连接断了先攒着不发：发不出去就别消耗「只报一次」的名额，重连后还会再看到输出。
      if (stopped || !isOpen()) return;
      for (const hit of portsInOutput(text)) {
        if (!listening.has(hit.port)) continue;
        const key = `${sessionId}\u0000${hit.port}`;
        if (announced.has(key)) continue;
        announced.add(key);
        send({ kind: 'preview_detected', sessionId, port: hit.port, label: hit.label.slice(0, 60) });
      }
    }
  };
}
