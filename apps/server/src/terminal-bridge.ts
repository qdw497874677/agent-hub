import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { DomainError, Result } from '@agent-hub/domain';
import type { Subject } from '@agent-hub/domain';
import { sameSecret } from './request-guard.ts';

/**
 * 会话终端（docs/design/terminal.md）的 hub 侧桥接。
 *
 * 浏览器一条 WebSocket ↔ hub 内存里的 Map<sessionId, entry> ↔ worker 的 PTY。
 * 这里只管搬帧、鉴权、心跳与清理；PTY 的生命周期由 worker 的终端宿主决定。
 */

/** 浏览器→hub 的帧。 */
type BrowserFrame = { readonly t: 'input'; readonly d: string } | { readonly t: 'resize'; readonly cols: number; readonly rows: number } | { readonly t: 'ping' };

/** hub→浏览器的帧。data 是 base64。 */
type HubFrame =
  | { readonly t: 'ready'; readonly terminalId: string }
  | { readonly t: 'data'; readonly d: string }
  | { readonly t: 'exit'; readonly code: number }
  | { readonly t: 'error'; readonly message: string }
  | { readonly t: 'pong' };

/** 桥接只要网关的这几项：便于单测用假网关。 */
export interface TerminalGateway {
  openTerminal(
    workerId: string,
    input: {
      readonly terminalId: string;
      readonly sessionId: string;
      readonly cols: number;
      readonly rows: number;
      readonly cwd?: string;
    }
  ): Promise<
    | {
        readonly ok: true;
        readonly value: {
          readonly cols: number;
          readonly rows: number;
          readonly reused: boolean;
          /** 复用终端时的最近输出（base64）：ready 之后补发给浏览器。 */
          readonly scrollback?: string;
        };
      }
    | { readonly ok: false; readonly code?: string; readonly message: string }
  >;
  resizeTerminal(workerId: string, terminalId: string, cols: number, rows: number): Promise<{ readonly ok: boolean }>;
  closeTerminal(workerId: string, terminalId: string): Promise<{ readonly ok: boolean; readonly message?: string }>;
  sendTerminalInput(workerId: string, terminalId: string, data: string): boolean;
}

export interface TerminalBridgeOptions {
  readonly gateway: TerminalGateway;
  /** 会话 → 机器 / 目录（domain 的 terminalTarget）。失败按 notFound → 404，其余 → 403。 */
  readonly target: (subject: Subject | null, sessionId: string) => Promise<Result<{ readonly workerId: string | null; readonly root: string }, DomainError>>;
  /** cookie 里的登录令牌 → 主体；没登录 / 过期返回 null。 */
  readonly authenticate: (token: string) => Promise<Subject | null>;
  /** 和 HTTP 路由同一套 Host 校验（缺 Host 的老客户端由 guard 放行）。 */
  readonly hostAllowed: (host: string | undefined) => boolean;
  readonly log: (message: string) => void;
  readonly now?: () => number;
  /** 心跳间隔，默认 25 秒；连续两轮没有 pong 就关。 */
  readonly heartbeatMs?: number;
  /** 慢客户端阈值与判定窗口，默认 4MB / 5 秒。 */
  readonly slowLimitBytes?: number;
  readonly slowGraceMs?: number;
  readonly slowCheckMs?: number;
  /** 会话刚派下来时 worker 还没登记工作目录，open 会回 not_ready：在这段时间内重试。默认 10 秒。 */
  readonly openRetryMs?: number;
  /** 测试用：拿到服务端的 WebSocket 实例（生产不传）。 */
  readonly onSocket?: (sessionId: string, socket: WebSocket) => void;
}

export interface TerminalBridge {
  attach(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** worker 的 terminal_data → 对应浏览器。 */
  onWorkerData(workerId: string, terminalId: string, data: string): void;
  /** worker 的 terminal_exit → 对应浏览器并收尾。 */
  onWorkerExit(workerId: string, terminalId: string, code: number): void;
  /** 会话结束 / 删除 / 换机器：通知 worker 关 PTY，再关浏览器 WS。 */
  closeSession(sessionId: string): void;
  /** 机器离线：只关浏览器 WS（PTY 随 worker 一起没了），不发 terminal.close。 */
  closeWorker(workerId: string): void;
  /** hub 上还开着的 terminalId（可按机器过滤）：worker 重连对账用。 */
  knownTerminals(workerId?: string | null): ReadonlySet<string>;
  /** 慢客户端检查（定时器调用；单测可直接调）。 */
  checkSlowClients(): void;
  close(): void;
}

const TERMINAL_PATH = /^\/api\/sessions\/([^/]+)\/terminal$/;
const MAX_PAYLOAD = 128 * 1024;
/** terminal_input 帧里 data 的上限（契约同值）。 */
const MAX_INPUT_CHARS = 131_072;
const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_SLOW_LIMIT_BYTES = 4 * 1024 * 1024;
const DEFAULT_SLOW_GRACE_MS = 5_000;
const DEFAULT_SLOW_CHECK_MS = 1_000;
/** 会话刚派下来时 worker 还没登记目录，`not_ready` 最多重试这么久。 */
const DEFAULT_OPEN_RETRY_MS = 10_000;

const LOOPBACKS = new Set(['127.0.0.1', '::1', 'localhost']);

/** `::ffff:127.0.0.1` → `127.0.0.1`。 */
function normalizeAddress(address: string | undefined): string {
  return (address ?? '').replace(/^::ffff:/, '');
}

/**
 * §2.3 第 2 步：Origin 必须等于 Host。**缺 Origin 只接受回环来源**。
 * 不复用 request-guard 的 originAllowed：它把「没有 Origin」当放行，对 WS 太宽。
 */
export function originMatches(origin: string | undefined, host: string | undefined, remoteAddress: string | undefined): boolean {
  if (origin === undefined || origin === '') return LOOPBACKS.has(normalizeAddress(remoteAddress));
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

/**
 * §2.3 第 3 步：两种 cookie 名都认（HTTPS 用 `__Host-` 前缀）。
 * 两个都在时必须一致（常量时间比较）；只给一个也接受。
 */
export function loginTokenOf(cookie: string | undefined): string {
  const values = new Map<string, string>();
  for (const part of (cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (name === 'hub_login' || name === '__Host-hub_login') values.set(name, part.slice(at + 1).trim());
  }
  const secure = values.get('__Host-hub_login') ?? '';
  const plain = values.get('hub_login') ?? '';
  if (secure !== '' && plain !== '') return sameSecret(plain, secure) ? secure : '';
  return secure || plain;
}

interface Entry {
  readonly terminalId: string;
  readonly workerId: string;
  readonly socket: WebSocket;
  /** 应用层 ping / WS pong 都会刷新它；每轮心跳先置 false。 */
  alive: boolean;
  misses: number;
  /** bufferedAmount 第一次超过阈值的时间；降回来就清空。 */
  slowSince: number | null;
  /** worker 上是否真的开过 PTY：浏览器断在 open 途中时也要靠它记住 linger。 */
  opened: boolean;
}

/** 开过 PTY、但浏览器已经断开（在 worker 的 linger 期里）：会话结束时仍要主动 terminal.close。 */
interface LingeringTerminal {
  readonly workerId: string;
  readonly terminalId: string;
}

function send(socket: WebSocket, frame: HubFrame): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // 连接刚好断了：让 close 事件收尾
  }
}

function deny(socket: Duplex, status: number, message: string): void {
  if (socket.writableEnded) return;
  const reason = status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Forbidden';
  const body = message;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/** terminalId v1 固定一条：`<sessionId>:1`。 */
export const terminalIdOf = (sessionId: string): string => `${sessionId}:1`;

export function createTerminalBridge(options: TerminalBridgeOptions): TerminalBridge {
  const { gateway, log } = options;
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const slowLimitBytes = options.slowLimitBytes ?? DEFAULT_SLOW_LIMIT_BYTES;
  const slowGraceMs = options.slowGraceMs ?? DEFAULT_SLOW_GRACE_MS;
  const slowCheckMs = options.slowCheckMs ?? DEFAULT_SLOW_CHECK_MS;
  const entries = new Map<string, Entry>();
  /** sessionId → 浏览器已断开、PTY 还留在 worker 上的终端。 */
  const lingering = new Map<string, LingeringTerminal>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  const entryOfTerminal = (workerId: string, terminalId: string): Entry | null => {
    for (const entry of entries.values()) {
      if (entry.terminalId === terminalId && entry.workerId === workerId) return entry;
    }
    return null;
  };

  /** 只删 Map 里仍是这一个的连接（重连 / 关闭先后到达时不误删新的）。 */
  function forget(sessionId: string, entry: Entry): void {
    if (entries.get(sessionId) === entry) entries.delete(sessionId);
  }

  /** 浏览器断开但 PTY 还留在 worker 的 linger 期：记下来，会话结束时仍要主动 terminal.close。 */
  function linger(sessionId: string, workerId: string, terminalId: string): void {
    lingering.set(sessionId, { workerId, terminalId });
  }

  /** PTY 已经没了（worker 报 exit / 机器离线 / 刚发过 close）：对应的 linger 记录也清掉。 */
  function forgetLingering(workerId: string, terminalId: string): void {
    for (const [sessionId, item] of [...lingering]) {
      if (item.workerId === workerId && item.terminalId === terminalId) lingering.delete(sessionId);
    }
  }

  function closeEntry(sessionId: string, entry: Entry, code: number, reason: string): void {
    forget(sessionId, entry);
    try {
      entry.socket.close(code, reason);
    } catch {
      // 已经关了
    }
  }

  async function start(
    socket: WebSocket,
    sessionId: string,
    workerId: string,
    root: string,
    cols: number,
    rows: number
  ): Promise<void> {
    const duplicate = entries.get(sessionId);
    if (duplicate) {
      // 设计稿 §2.2：同一个终端已经有窗口，拒绝新来的，**不踢旧的**。
      send(socket, { t: 'error', message: '这个终端已在另一个窗口打开' });
      socket.close(1008, 'already open');
      return;
    }
    const terminalId = terminalIdOf(sessionId);
    const entry: Entry = { terminalId, workerId, socket, alive: true, misses: 0, slowSince: null, opened: false };
    entries.set(sessionId, entry);

    socket.on('pong', () => {
      entry.alive = true;
      entry.misses = 0;
    });
    socket.on('message', (raw: Buffer | string) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      if (text.length > MAX_PAYLOAD) return;
      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (!frame || typeof frame !== 'object') return;
      const message = frame as BrowserFrame;
      if (message.t === 'ping') {
        entry.alive = true;
        entry.misses = 0;
        send(socket, { t: 'pong' });
        return;
      }
      if (message.t === 'resize') {
        const c = Math.max(1, Math.min(1000, Math.trunc(Number(message.cols))));
        const r = Math.max(1, Math.min(1000, Math.trunc(Number(message.rows))));
        if (!Number.isFinite(c) || !Number.isFinite(r)) return;
        void gateway.resizeTerminal(workerId, terminalId, c, r).catch((error: unknown) => {
          log(`终端 resize 失败（${terminalId}）：${error instanceof Error ? error.message : String(error)}`);
        });
        return;
      }
      if (message.t === 'input' && typeof message.d === 'string' && message.d.length > 0 && message.d.length <= MAX_INPUT_CHARS) {
        gateway.sendTerminalInput(workerId, terminalId, message.d);
      }
    });
    socket.on('close', () => {
      // 设计稿 §3：标签页关掉 / 刷新时 PTY 留着（worker 侧 TERMINAL_LINGER_MS），这里只摘掉客户端；
      // 但要在 linger 表里记一笔，会话结束时 closeSession 才能主动发 terminal.close。
      forget(sessionId, entry);
      if (entry.opened) linger(sessionId, entry.workerId, entry.terminalId);
    });
    socket.on('error', () => {
      forget(sessionId, entry);
      if (entry.opened) linger(sessionId, entry.workerId, entry.terminalId);
    });
    options.onSocket?.(sessionId, socket);

    const openRetryMs = options.openRetryMs ?? DEFAULT_OPEN_RETRY_MS;
    const deadline = now() + openRetryMs;
    // 目录由 hub 算好（domain 的 terminalTarget）：会话跑完、worker 内存里已经查不到它时，旧会话的终端也能开。
    const openInput = { terminalId, sessionId, cols, rows, cwd: root };
    let opened = await gateway.openTerminal(workerId, openInput);
    while (!opened.ok && opened.code === 'not_ready' && now() < deadline && entries.get(sessionId) === entry) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (entries.get(sessionId) !== entry) return;
      opened = await gateway.openTerminal(workerId, openInput);
    }
    if (!opened.ok) {
      forget(sessionId, entry);
      send(socket, { t: 'error', message: opened.message });
      socket.close(1011, 'open failed');
      return;
    }
    entry.opened = true;
    if (entries.get(sessionId) !== entry) {
      // 打开期间窗口关了：PTY 留着，等下次复用；也记成 linger，会话结束时能主动收掉。
      linger(sessionId, entry.workerId, entry.terminalId);
      return;
    }
    lingering.delete(sessionId); // 复用成功：客户端已经接回来了
    send(socket, { t: 'ready', terminalId });
    // 复用还活着的 PTY：先把最近输出补回去，页面刷新后不会只剩一个空屏。
    if (opened.value.scrollback !== undefined && opened.value.scrollback !== '') {
      send(socket, { t: 'data', d: opened.value.scrollback });
    }
  }

  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, sessionId: string): Promise<void> {
    // §2.3 顺序：Host → Origin → cookie → session.read。前两步失败是 403，cookie 失败 401。
    if (!options.hostAllowed(request.headers.host)) {
      deny(socket, 403, 'Host 不被允许');
      return;
    }
    if (!originMatches(request.headers.origin, request.headers.host, request.socket.remoteAddress)) {
      deny(socket, 403, '来源不被允许');
      return;
    }
    const token = loginTokenOf(request.headers.cookie);
    if (token === '') {
      deny(socket, 401, '请先登录');
      return;
    }
    const subject = await options.authenticate(token);
    if (!subject) {
      deny(socket, 401, '请先登录');
      return;
    }
    const target = await options.target(subject, sessionId);
    if (!target.ok) {
      deny(socket, target.error.code === 'not_found' ? 404 : 403, target.error.message);
      return;
    }
    const query = new URL(request.url ?? '/', 'http://hub').searchParams;
    const cols = Math.max(1, Math.min(1000, Math.trunc(Number(query.get('cols')) || 80)));
    const rows = Math.max(1, Math.min(1000, Math.trunc(Number(query.get('rows')) || 24)));
    try {
      wss.handleUpgrade(request, socket, head, (ws) => {
        void start(ws, sessionId, target.value.workerId ?? 'local', target.value.root, cols, rows).catch((error: unknown) => {
          log(`终端启动失败（${sessionId}）：${error instanceof Error ? error.message : String(error)}`);
          send(ws, { t: 'error', message: '终端启动失败' });
          ws.close(1011, 'open failed');
        });
      });
    } catch (error) {
      log(`终端握手失败（${sessionId}）：${error instanceof Error ? error.message : String(error)}`);
      deny(socket, 400, '无法升级到 WebSocket');
    }
  }

  const heartbeat = setInterval(() => {
    for (const [sessionId, entry] of entries) {
      if (!entry.alive) {
        entry.misses += 1;
        if (entry.misses >= 2) {
          closeEntry(sessionId, entry, 1001, '心跳超时');
          continue;
        }
      } else {
        entry.misses = 0;
      }
      entry.alive = false;
      try {
        entry.socket.ping();
      } catch {
        // 下一轮判死
      }
    }
  }, heartbeatMs);
  heartbeat.unref();

  const bridge: TerminalBridge = {
    attach(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      const path = (request.url ?? '').split('?')[0] ?? '';
      const match = TERMINAL_PATH.exec(path);
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(match?.[1] ?? '');
      } catch {
        deny(socket, 403, '路径不对');
        return;
      }
      if (!match || sessionId === '') {
        deny(socket, 403, '路径不对');
        return;
      }
      void upgrade(request, socket, head, sessionId).catch((error: unknown) => {
        log(`终端升级失败（${sessionId}）：${error instanceof Error ? error.message : String(error)}`);
        deny(socket, 400, '无法升级到 WebSocket');
      });
    },

    onWorkerData(workerId: string, terminalId: string, data: string): void {
      const entry = entryOfTerminal(workerId, terminalId);
      if (entry) send(entry.socket, { t: 'data', d: data });
    },

    onWorkerExit(workerId: string, terminalId: string, code: number): void {
      // PTY 已经退出：linger 记录跟着清掉，别在会话结束时再对不存在的终端发 close。
      forgetLingering(workerId, terminalId);
      const entry = entryOfTerminal(workerId, terminalId);
      if (!entry) return;
      for (const [sessionId, candidate] of entries) {
        if (candidate === entry) {
          forget(sessionId, entry);
          break;
        }
      }
      entry.opened = false;
      send(entry.socket, { t: 'exit', code });
      try {
        entry.socket.close(1000, '终端已退出');
      } catch {
        // 已经关了
      }
    },

    closeSession(sessionId: string): void {
      const entry = entries.get(sessionId);
      const detached = lingering.get(sessionId);
      // 客户端已经断开的 linger 终端没有 entry，但 PTY 还在 worker 上：也要主动关。
      if (!entry && !detached) return;
      if (entry) {
        forget(sessionId, entry);
        entry.opened = false; // 主动发 close 了，close 事件别把它再记成 linger
        send(entry.socket, { t: 'exit', code: 0 });
        try {
          entry.socket.close(1000, '会话已结束');
        } catch {
          // 已经关了
        }
      }
      lingering.delete(sessionId);
      const workerId = entry?.workerId ?? detached!.workerId;
      const terminalId = entry?.terminalId ?? detached!.terminalId;
      void gateway.closeTerminal(workerId, terminalId).then(
        (closed) => {
          if (!closed.ok) log(`关闭终端失败（${terminalId}）：${closed.message ?? 'worker 没确认'}`);
        },
        (error: unknown) => log(`关闭终端失败（${terminalId}）：${error instanceof Error ? error.message : String(error)}`)
      );
    },

    closeWorker(workerId: string): void {
      // PTY 随 worker 一起没了：linger 记录直接丢，不发 terminal.close。
      for (const [sessionId, item] of [...lingering]) if (item.workerId === workerId) lingering.delete(sessionId);
      for (const [sessionId, entry] of [...entries]) {
        if (entry.workerId !== workerId) continue;
        forget(sessionId, entry);
        entry.opened = false;
        send(entry.socket, { t: 'error', message: '机器离线' });
        try {
          entry.socket.close(1011, 'worker offline');
        } catch {
          // 已经关了
        }
      }
    },

    knownTerminals(workerId?: string | null): ReadonlySet<string> {
      const known = new Set<string>();
      for (const entry of entries.values()) {
        if (workerId === undefined || workerId === null || entry.workerId === workerId) known.add(entry.terminalId);
      }
      // linger 的 PTY 也还开在 worker 上：worker 重连对账时别把它当残留关掉。
      for (const item of lingering.values()) {
        if (workerId === undefined || workerId === null || item.workerId === workerId) known.add(item.terminalId);
      }
      return known;
    },

    checkSlowClients(): void {
      const at = now();
      for (const [sessionId, entry] of entries) {
        let buffered = 0;
        try {
          buffered = entry.socket.bufferedAmount;
        } catch {
          buffered = 0;
        }
        if (buffered <= slowLimitBytes) {
          entry.slowSince = null;
          continue;
        }
        entry.slowSince ??= at;
        if (at - entry.slowSince < slowGraceMs) continue;
        log(`终端输出太慢，关闭连接（${sessionId}，积压 ${buffered} 字节）`);
        closeEntry(sessionId, entry, 1008, '终端输出太慢');
      }
    },

    close(): void {
      clearInterval(heartbeat);
      clearInterval(slowTimer);
      for (const entry of entries.values()) {
        entry.opened = false;
        try {
          entry.socket.close(1001, 'hub 正在关闭');
        } catch {
          // 已经关了
        }
      }
      entries.clear();
      lingering.clear();
      wss.close();
    }
  };

  const slowTimer = setInterval(() => bridge.checkSlowClients(), slowCheckMs);
  slowTimer.unref();

  return bridge;
}
