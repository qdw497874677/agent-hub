import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  PREVIEW_FRAME_BYTES,
  PREVIEW_MAX_PAYLOAD,
  PREVIEW_WS_PATH,
  previewDownSchema,
  type PreviewUpFrame
} from '@agent-hub/contract';

/**
 * 预览通道（docs/design/preview.md §6）的 hub 侧：worker 主动再开一条 `/preview` WS，
 * 每个浏览器请求 / 一条 WS 隧道 = 一个 stream。
 *
 * 这里只管建流、搬帧、窗口计数与连接生命周期；HTTP / WS 的反代在 `preview-proxy.ts`，
 * 装配（把 hub 的 upgrade 事件接进来）由 `apps/server/src/main.ts` 负责。
 */

/** 单 worker 并发流上限：超出回 429（设计稿 §6 末段）。 */
const MAX_STREAMS_PER_WORKER = 32;
/** 初始窗口：worker 最多连发这么多帧，每收到一帧 hub 回一次 ack。 */
const STREAM_WINDOW = 8;
const DEFAULT_HEADER_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 25_000;

const STREAM_ID_HEX_BYTES = 8;

/** `preview_ports` 最多记这么多端口（契约同值，这里再兜一次）。 */
const MAX_REPORTED_PORTS = 256;

export type PreviewFailureCode = 'refused' | 'timeout' | 'forbidden';

/** 建流失败 / 流中断：`status` 直接给反代当 HTTP 状态码用。 */
export class PreviewStreamError extends Error {
  readonly status: number;
  readonly code: PreviewFailureCode | undefined;

  constructor(status: number, message: string, code?: PreviewFailureCode) {
    super(message);
    this.name = 'PreviewStreamError';
    this.status = status;
    this.code = code;
  }
}

/** worker 回的响应头（status 101 表示 WS 隧道已建立）。 */
export interface PreviewHead {
  readonly status: number;
  readonly statusText: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

export interface PreviewOpenRequest {
  /** worker 上的回环端口。 */
  readonly port: number;
  readonly method: string;
  /** 含 query，原样透传。 */
  readonly path: string;
  /** 已经剔掉 hop-by-hop 的头。 */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** 有它就是 WS 隧道；hub 不会再发 `preview_body` 当请求体。 */
  readonly upgrade?: { readonly protocol: string | null };
}

/**
 * 一条流。`open()` 立刻返回（`preview_open` 已发出），响应头通过 `onHead` 异步到达；
 * 之后的 `preview_data/end/failed` 通过各自的回调下发。
 */
export interface PreviewStream {
  readonly streamId: string;
  onHead(callback: (head: PreviewHead) => void): void;
  /** 返回 `false` 表示下游背压（反代把 `res.write()` 的结果原样返回）。 */
  onData(callback: (chunk: Buffer) => boolean | void): void;
  onEnd(callback: () => void): void;
  onError(callback: (error: PreviewStreamError) => void): void;
  /** 请求体（HTTP）或隧道数据（WS）。超 64KiB 自动拆帧；`end` 表示请求体结束。 */
  write(chunk: Buffer | Uint8Array | string, end?: boolean): void;
  /** 空请求体也要告诉 worker「没有 body 了」，否则它会一直等。 */
  endBody(): void;
  /** 允许 worker 再发多少帧（窗口计数，不是增量）。 */
  ack(credits: number): void;
  /** hub 主动中止：发 `preview_close`。 */
  close(): void;
}

export interface PreviewChannelOptions {
  /** 校验 `/preview` 握手（worker 凭据）。返回 null 一律 401。 */
  readonly verifyWorker: (request: IncomingMessage) => Promise<{ workerId: string } | null>;
  readonly onWorkerUp?: (workerId: string) => void;
  readonly onWorkerDown?: (workerId: string) => void;
  /** worker 定期上报的「本机正在监听的回环端口」（已去重 / 裁剪）。 */
  readonly onPorts?: (workerId: string, ports: readonly number[]) => void;
  /** worker 从终端输出里认出的端口；hub 不再二次判断（worker 已用 /proc 校验）。 */
  readonly onDetected?: (workerId: string, event: { sessionId: string; port: number; label?: string }) => void;
  readonly onLog?: (message: string) => void;
  /** `preview_open` 之后多久没 `preview_head` 就 504 + `preview_close`（保险丝），默认 10 秒。 */
  readonly headerTimeoutMs?: number;
}

export interface PreviewChannel {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  open(workerId: string, request: PreviewOpenRequest): Promise<PreviewStream>;
  hasWorker(workerId: string): boolean;
  /** 该机器上开着的流数量（诊断 / 测试用）。 */
  streamCount(workerId: string): number;
  close(): void;
}

interface WorkerConnection {
  readonly workerId: string;
  readonly socket: WebSocket;
  readonly streams: Map<string, Stream>;
  alive: boolean;
  misses: number;
}

class Stream implements PreviewStream {
  readonly streamId: string;
  private readonly conn: WorkerConnection;
  private readonly log: (message: string) => void;
  private readonly detach: (stream: Stream) => void;
  private head: PreviewHead | null = null;
  /** 头部超时的保险丝（反代也有一个，这里是最后一道）。 */
  private timer: NodeJS.Timeout | null = null;
  private readonly headCallbacks: Array<(head: PreviewHead) => void> = [];
  private readonly dataCallbacks: Array<(chunk: Buffer) => boolean | void> = [];
  private readonly endCallbacks: Array<() => void> = [];
  private readonly errorCallbacks: Array<(error: PreviewStreamError) => void> = [];
  /** `onData` 还没注册时先攒着，注册时补发。 */
  private readonly pending: Buffer[] = [];
  private endPending = false;
  private errorPending: PreviewStreamError | null = null;
  private closed = false;

  constructor(streamId: string, conn: WorkerConnection, log: (message: string) => void, detach: (stream: Stream) => void) {
    this.streamId = streamId;
    this.conn = conn;
    this.log = log;
    this.detach = detach;
  }

  /** 装头部超时保险丝：到点还没 head 就 504 + `preview_close`。 */
  arm(milliseconds: number): void {
    this.clearTimer();
    if (this.head !== null || this.closed) return;
    this.timer = setTimeout(() => this.timeout(milliseconds), milliseconds);
    this.timer.unref();
  }

  onHead(callback: (head: PreviewHead) => void): void {
    this.headCallbacks.push(callback);
    if (this.head) callback(this.head);
  }

  onData(callback: (chunk: Buffer) => boolean | void): void {
    this.dataCallbacks.push(callback);
    if (this.pending.length > 0) {
      for (const chunk of this.pending.splice(0)) {
        try {
          callback(chunk);
        } catch (error) {
          this.log(`预览数据回调失败（${this.streamId}）：${messageOf(error)}`);
        }
      }
    }
  }

  onEnd(callback: () => void): void {
    this.endCallbacks.push(callback);
    if (this.endPending) {
      this.endPending = false;
      callback();
    }
  }

  onError(callback: (error: PreviewStreamError) => void): void {
    this.errorCallbacks.push(callback);
    if (this.errorPending) {
      const error = this.errorPending;
      this.errorPending = null;
      callback(error);
    }
  }

  write(chunk: Buffer | Uint8Array | string, end = false): void {
    if (this.closed) return;
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    if (buffer.length === 0) {
      if (end) this.sendUp({ kind: 'preview_body', streamId: this.streamId, data: '', end: true });
      return;
    }
    for (let offset = 0; offset < buffer.length; offset += PREVIEW_FRAME_BYTES) {
      const piece = buffer.subarray(offset, Math.min(offset + PREVIEW_FRAME_BYTES, buffer.length));
      const last = offset + piece.length >= buffer.length;
      this.sendUp({ kind: 'preview_body', streamId: this.streamId, data: piece.toString('base64'), end: end && last });
    }
  }

  endBody(): void {
    this.write(Buffer.alloc(0), true);
  }

  ack(credits: number): void {
    if (this.closed) return;
    this.sendUp({
      kind: 'preview_ack',
      streamId: this.streamId,
      credits: Math.max(0, Math.min(1024, Math.trunc(credits)))
    });
  }

  close(): void {
    if (this.closed) return;
    this.finish();
    this.sendUp({ kind: 'preview_close', streamId: this.streamId });
  }

  /** 头部超时：发 `preview_close`，已注册的回调收 504。 */
  timeout(milliseconds: number): void {
    if (this.closed || this.head !== null) return;
    this.sendUp({ kind: 'preview_close', streamId: this.streamId });
    this.abort(new PreviewStreamError(504, `预览上游 ${Math.round(milliseconds / 1000)} 秒没有响应`, 'timeout'));
  }

  /** worker 断开 / 重连 / hub 关闭 / 头部超时：已建的流回调 error + end。 */
  abort(error: PreviewStreamError): void {
    if (this.closed) return;
    this.finish();
    if (this.errorCallbacks.length === 0) this.errorPending = error;
    else for (const callback of this.errorCallbacks) callback(error);
    for (const callback of this.endCallbacks) callback();
  }

  handleHead(status: number, statusText: string, headers: ReadonlyArray<readonly [string, string]>): void {
    if (this.closed) return;
    this.clearTimer();
    const head: PreviewHead = { status, statusText, headers };
    this.head = head;
    for (const callback of this.headCallbacks) callback(head);
  }

  handleData(data: string): void {
    if (this.closed) return;
    const chunk = Buffer.from(data, 'base64');
    if (this.dataCallbacks.length === 0) {
      this.pending.push(chunk);
    } else {
      for (const callback of this.dataCallbacks) {
        try {
          callback(chunk);
        } catch (error) {
          this.log(`预览数据回调失败（${this.streamId}）：${messageOf(error)}`);
        }
      }
    }
    // 窗口计数：还没交出去的分片占着窗口，交出去了就整窗放回去。
    this.ack(STREAM_WINDOW - this.pending.length);
  }

  handleEnd(): void {
    if (this.closed) return;
    this.finish();
    if (this.endCallbacks.length === 0) this.endPending = true;
    else for (const callback of this.endCallbacks) callback();
  }

  handleFailed(message: string, code: PreviewFailureCode | undefined): void {
    if (this.closed) return;
    const error = new PreviewStreamError(failureStatus(code), message, code);
    this.finish();
    if (this.errorCallbacks.length === 0) this.errorPending = error;
    else for (const callback of this.errorCallbacks) callback(error);
    for (const callback of this.endCallbacks) callback();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.detach(this);
  }

  private sendUp(frame: PreviewUpFrame): void {
    const socket = this.conn.socket;
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // 连接刚好断了：close 事件会统一收尾
    }
  }
}

function failureStatus(code: PreviewFailureCode | undefined): number {
  if (code === 'timeout') return 504;
  if (code === 'forbidden') return 403;
  return 502;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 端口表兜底：只留 1–65535 的整数、去重、最多 256 个（顺序按首次出现）。 */
export function normalizePorts(ports: readonly number[]): number[] {
  const unique = new Set<number>();
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    unique.add(port);
    if (unique.size >= MAX_REPORTED_PORTS) break;
  }
  return [...unique];
}

function deny(socket: Duplex, status: number, message: string): void {
  if (socket.writableEnded) return;
  const reason = status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Bad Request';
  const body = message;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    () => socket.destroy()
  );
}

export function createPreviewChannel(options: PreviewChannelOptions): PreviewChannel {
  const log = options.onLog ?? (() => {});
  const headerTimeoutMs = options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
  const connections = new Map<string, WorkerConnection>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: PREVIEW_MAX_PAYLOAD });

  function sendFrame(conn: WorkerConnection, frame: PreviewUpFrame): boolean {
    if (conn.socket.readyState !== WebSocket.OPEN) return false;
    try {
      conn.socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  function failConnection(conn: WorkerConnection, error: PreviewStreamError): void {
    const streams = [...conn.streams.values()];
    conn.streams.clear();
    for (const stream of streams) stream.abort(error);
  }

  function onFrame(conn: WorkerConnection, raw: unknown): void {
    const text =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.from(raw as ArrayBuffer).toString('utf8');
    if (text.length > PREVIEW_MAX_PAYLOAD) {
      log(`预览通道收到超大帧（${text.length} 字节），忽略`);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      log('预览通道收到非 JSON 帧，忽略');
      return;
    }
    const parsed = previewDownSchema.safeParse(value);
    if (!parsed.success) {
      log('预览通道收到不符合协议的帧，忽略');
      return;
    }
    const frame = parsed.data;
    // 这两类帧没有 streamId：必须在查流表之前分流，回调抛错也不能打断 WS。
    if (frame.kind === 'preview_ports') {
      const callback = options.onPorts;
      if (callback) {
        try {
          callback(conn.workerId, normalizePorts(frame.ports));
        } catch (error) {
          log(`预览端口回调失败（${conn.workerId}）：${messageOf(error)}`);
        }
      }
      return;
    }
    if (frame.kind === 'preview_detected') {
      const callback = options.onDetected;
      if (callback) {
        const event = frame.label === undefined
          ? { sessionId: frame.sessionId, port: frame.port }
          : { sessionId: frame.sessionId, port: frame.port, label: frame.label };
        try {
          callback(conn.workerId, event);
        } catch (error) {
          log(`预览端口识别回调失败（${conn.workerId}）：${messageOf(error)}`);
        }
      }
      return;
    }
    const stream = conn.streams.get(frame.streamId);
    if (!stream) {
      log(`预览帧指向未知流（${frame.streamId} / ${frame.kind}），忽略`);
      return;
    }
    switch (frame.kind) {
      case 'preview_head':
        stream.handleHead(frame.status, frame.statusText, frame.headers);
        return;
      case 'preview_data':
        stream.handleData(frame.data);
        return;
      case 'preview_end':
        stream.handleEnd();
        return;
      case 'preview_failed':
        stream.handleFailed(frame.message, frame.code);
        return;
    }
  }

  function detachConnection(conn: WorkerConnection): void {
    // 同一台机器已经重连过：旧连接的 close 不能再影响新连接。
    if (connections.get(conn.workerId) !== conn) return;
    connections.delete(conn.workerId);
    failConnection(conn, new PreviewStreamError(502, '机器离线，预览中断'));
    log(`预览通道断开：${conn.workerId}`);
    options.onWorkerDown?.(conn.workerId);
  }

  function attach(socket: WebSocket, workerId: string): void {
    const previous = connections.get(workerId);
    const conn: WorkerConnection = { workerId, socket, streams: new Map(), alive: true, misses: 0 };
    connections.set(workerId, conn);

    socket.on('pong', () => {
      conn.alive = true;
      conn.misses = 0;
    });
    socket.on('message', (raw) => onFrame(conn, raw));
    socket.on('close', () => detachConnection(conn));
    socket.on('error', () => {
      // close 会跟着来；这里只防未处理的 error 事件把进程带崩。
    });

    if (previous) {
      // 设计稿 §6：同一 worker 重连就踢旧连接，旧连接上的流全部失败（502）。
      failConnection(previous, new PreviewStreamError(502, '机器重新连接，预览中断'));
      try {
        previous.socket.close(1001, 'worker reconnected');
      } catch {
        // 已经关了
      }
    }
    log(`预览通道接入：${workerId}`);
    options.onWorkerUp?.(workerId);
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (request.url ?? '').split('?')[0] ?? '';
    if (path !== PREVIEW_WS_PATH) {
      deny(socket, 404, '不是预览通道');
      return;
    }
    void options.verifyWorker(request).then(
      (worker) => {
        if (!worker) {
          deny(socket, 401, '未授权的机器');
          return;
        }
        try {
          wss.handleUpgrade(request, socket, head, (ws) => attach(ws, worker.workerId));
        } catch (error) {
          log(`预览通道握手失败：${messageOf(error)}`);
          deny(socket, 400, '无法升级到 WebSocket');
        }
      },
      (error: unknown) => {
        log(`预览通道校验失败：${messageOf(error)}`);
        deny(socket, 401, '未授权的机器');
      }
    );
  }

  function open(workerId: string, request: PreviewOpenRequest): Promise<PreviewStream> {
    const conn = connections.get(workerId);
    if (!conn) return Promise.reject(new PreviewStreamError(502, '机器不在线'));
    if (conn.streams.size >= MAX_STREAMS_PER_WORKER) {
      return Promise.reject(new PreviewStreamError(429, '预览并发流太多，稍后再试'));
    }
    if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535) {
      return Promise.reject(new PreviewStreamError(400, '预览端口不合法'));
    }
    const streamId = randomBytes(STREAM_ID_HEX_BYTES).toString('hex');
    const stream = new Stream(streamId, conn, log, (candidate) => {
      if (conn.streams.get(streamId) === candidate) conn.streams.delete(streamId);
    });
    conn.streams.set(streamId, stream);

    const frame: PreviewUpFrame = {
      kind: 'preview_open',
      streamId,
      port: request.port,
      method: request.method,
      path: request.path,
      headers: request.headers.map(([name, value]) => [name, value] as [string, string]),
      ...(request.upgrade ? { upgrade: { protocol: request.upgrade.protocol } } : {})
    };
    // 不等 head：带 body 的请求要先把 body 推给 worker，上游才可能回响应头。
    if (!sendFrame(conn, frame)) {
      stream.abort(new PreviewStreamError(502, '机器不在线'));
      return Promise.reject(new PreviewStreamError(502, '机器不在线'));
    }
    stream.arm(headerTimeoutMs);
    return Promise.resolve<PreviewStream>(stream);
  }

  const heartbeat = setInterval(() => {
    for (const conn of connections.values()) {
      if (!conn.alive) {
        conn.misses += 1;
        if (conn.misses >= 2) {
          try {
            conn.socket.terminate();
          } catch {
            // 已经断了
          }
          continue;
        }
      } else {
        conn.misses = 0;
      }
      conn.alive = false;
      try {
        conn.socket.ping();
      } catch {
        // 下一轮判死
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    handleUpgrade,
    open,
    hasWorker(workerId: string): boolean {
      return connections.has(workerId);
    },
    streamCount(workerId: string): number {
      return connections.get(workerId)?.streams.size ?? 0;
    },
    close(): void {
      clearInterval(heartbeat);
      for (const conn of connections.values()) {
        failConnection(conn, new PreviewStreamError(502, 'hub 正在关闭'));
        try {
          conn.socket.close(1001, 'hub 正在关闭');
        } catch {
          // 已经关了
        }
      }
      connections.clear();
      wss.close();
    }
  };
}
