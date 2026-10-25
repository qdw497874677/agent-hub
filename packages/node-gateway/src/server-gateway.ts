import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentDto, ServerToWorker, WorkerToServer } from '@agent-hub/contract';
import { workerToServerSchema } from '@agent-hub/contract';
import type {
  DomainError,
  NodeGateway,
  Result,
  RuntimeOption,
  RuntimeStatus,
  SessionEvent,
  SessionId,
  WorkerCommand,
  WorkerStatus
} from '@agent-hub/domain';
import { unavailable } from '@agent-hub/domain';

export interface GatewayHooks {
  readonly token: string | null;
  /**
   * 只发给 server 自己拉起的那个子进程 worker 的口令。
   * 自称 `origin: 'local'` 却答不上它的连接一律按 remote 处理——
   * 「本机」会优先接新项目、新会话，不能谁报一句就当。null = 没有本机子进程。
   */
  readonly localSecret?: string | null;
  /**
   * `sessions`：Worker 重连时报上的、它手上还活着的会话。
   * 网关**不**凭这句话改路由：组合根让领域核对落点后，再用 `adopt()` 把核对过的那些接回来。
   */
  onHello(worker: WorkerStatus, agents: AgentDto[], sessions: readonly string[]): void;
  // 以下回调都带上「是哪台 Worker 说的」：会话归不归它，由领域按库里的落点判断。
  onEvent(workerId: string, sessionId: SessionId, event: SessionEvent): void;
  onAgentSession(workerId: string, sessionId: SessionId, agentSessionRef: string): void;
  onOptions(workerId: string, sessionId: SessionId, options: readonly RuntimeOption[]): void;
  onStatus(workerId: string, sessionId: SessionId, status: RuntimeStatus, reason?: string): void;
  onWorkerGone(workerId: string, reason: string): void;
  onLog?(message: string): void;
}

export interface GatewayOptions {
  /** 心跳间隔。连续一个间隔没收到 pong 就判定离线并断开。 */
  readonly heartbeatMs?: number;
  /** 目录浏览这类请求-回复的超时。 */
  readonly requestTimeoutMs?: number;
  /** 连上之后多久内必须 hello；不说话的连接不该一直占着。 */
  readonly helloTimeoutMs?: number;
  readonly now?: () => number;
}

/** 单帧上限：读文件的回复是 base64，附件上限之上留余量；再大就是有人在灌。 */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** 常量时间比较：逐字节 `!==` 会从响应时间里漏出「前几个字符对了」。 */
export function sameSecret(offered: string | undefined, expected: string): boolean {
  const a = Buffer.from(offered ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Registered {
  readonly workerId: string;
  label: string;
  origin: WorkerStatus['origin'];
  /** null = 离线。离线的 Worker 留在登记表里：管理视图要能显示「上次见到是什么时候」。 */
  socket: WebSocket | null;
  /** 这条连接的对端地址：同一台机器换连接（重连先于旧 close 到达）时用来认人。 */
  address: string | undefined;
  agents: AgentDto[];
  host: { hostname: string; platform: string; arch: string } | null;
  roots: string[];
  lastSeenAt: number;
  /** 心跳：发 ping 前置 false，收到 pong 置 true；下一轮还是 false 就是失联。 */
  alive: boolean;
  reason?: string;
}

/** 一次请求-回复（目录、文件清单、读文件）：按 requestId 对上，超时或断线都要给答复。 */
interface PendingRequest {
  readonly workerId: string;
  readonly settle: (reply: ReplyFrame | DomainError) => void;
  readonly timer: NodeJS.Timeout;
}

type ReplyFrame = Extract<WorkerToServer, { type: 'directories' | 'files' | 'file' }>;


export interface ServerGateway {
  readonly gateway: NodeGateway;
  workers(): WorkerStatus[];
  /** 把领域核对过落点的会话接回这台 Worker 的路由（重连后不必再 resume）。 */
  adopt(workerId: string, sessionIds: readonly string[]): void;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

/**
 * server 侧的 worker 通道。指令下行、事件上行，一条 WebSocket 两条流。
 *
 * 多机路由：start_session 带着落点（workerId）下来，网关记下「这条会话在哪台」，
 * 之后的 prompt / interrupt / set_option / dispose 都按这张表走——
 * 而不是像单机时那样「发给第一台在线的」。
 */
export function createServerGateway(hooks: GatewayHooks, options: GatewayOptions = {}): ServerGateway {
  const registry = new Map<string, Registered>();
  const placement = new Map<string, string>();
  const pending = new Map<string, PendingRequest>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  let requestSeq = 0;

  const online = (workerId: string): Registered | null => {
    const entry = registry.get(workerId);
    return entry?.socket && entry.socket.readyState === WebSocket.OPEN ? entry : null;
  };

  const labelOf = (workerId: string): string => registry.get(workerId)?.label ?? workerId;

  function sendTo(workerId: string, command: ServerToWorker): Result<void, DomainError> {
    const entry = online(workerId);
    if (!entry?.socket) return { ok: false, error: unavailable(`Worker「${labelOf(workerId)}」不在线`) };
    entry.socket.send(JSON.stringify(command));
    return { ok: true, value: undefined };
  }

  function dispatchTo(command: WorkerCommand): Result<void, DomainError> {
    if (command.kind === 'start_session') {
      const sent = sendTo(command.workerId, toWire(command));
      if (sent.ok) placement.set(command.sessionId, command.workerId);
      return sent;
    }
    const workerId = placement.get(command.sessionId);
    if (workerId === undefined) {
      return { ok: false, error: unavailable('这条会话此刻没有托管在任何 Worker 上') };
    }
    return sendTo(workerId, toWire(command));
  }

  function markOffline(entry: Registered, socket: WebSocket, reason: string): void {
    // 同一个 workerId 重连时旧连接晚一步关闭：别让它把新连接标成离线。
    if (entry.socket !== socket) return;
    entry.socket = null;
    entry.reason = reason;
    for (const [sessionId, workerId] of placement) {
      if (workerId === entry.workerId) placement.delete(sessionId);
    }
    for (const [requestId, request] of pending) {
      if (request.workerId !== entry.workerId) continue;
      clearTimeout(request.timer);
      pending.delete(requestId);
      request.settle(unavailable(`Worker「${entry.label}」断开了`));
    }
    hooks.onWorkerGone(entry.workerId, reason);
  }

  wss.on('connection', (socket: WebSocket, request?: IncomingMessage) => {
    const address = request?.socket.remoteAddress;
    let entry: Registered | null = null;
    let closeReason = '连接断开';
    const helloTimer = setTimeout(() => {
      if (!entry) socket.close(4408, '没有及时 hello');
    }, helloTimeoutMs);
    helloTimer.unref();

    socket.on('pong', () => {
      if (entry && entry.socket === socket) {
        entry.alive = true;
        entry.lastSeenAt = now();
      }
    });

    socket.on('message', (raw: Buffer) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        hooks.onLog?.('worker 发来的不是 JSON');
        return;
      }
      const parsed = workerToServerSchema.safeParse(json);
      if (!parsed.success) {
        hooks.onLog?.(`worker 发来无法解析的帧：${parsed.error.message}`);
        return;
      }
      const frame = parsed.data as WorkerToServer;

      if (frame.type === 'hello') {
        if (hooks.token !== null && !sameSecret(frame.token, hooks.token)) {
          socket.close(4401, 'token 不匹配');
          return;
        }
        const secret = hooks.localSecret ?? null;
        const provenLocal = secret !== null && sameSecret(frame.localSecret, secret);
        const previous = registry.get(frame.workerId);
        if (previous?.socket && previous.socket !== socket) {
          // 同一个 workerId 已经有条活连接：重连比旧连接的 close 先到是常事，但只认
          // 「答得上本机口令」或「从同一个地址来」的新连接（本机那台只认口令：经代理进来的也是回环地址）。其他人报同一个 id 一律拒——
          // 否则谁知道 id 谁就能把那台机器的会话和文件请求劫走。
          // 真断了的旧连接会在一个心跳内被判离线，到时候合法的重连自然能进来。
          if (!provenLocal && (previous.origin === 'local' || previous.address !== address)) {
            socket.close(4409, '这个 workerId 已经在线');
            return;
          }
          const stale = previous.socket;
          previous.socket = null;
          stale.terminate();
        }
        clearTimeout(helloTimer);
        entry = {
          workerId: frame.workerId,
          label: frame.label,
          origin: frame.origin === 'local' && provenLocal ? 'local' : 'remote',
          socket,
          address,
          agents: frame.agents,
          host: frame.host ?? null,
          roots: frame.roots,
          lastSeenAt: now(),
          alive: true
        };
        registry.set(frame.workerId, entry);
        hooks.onHello(describe(entry), frame.agents, frame.sessions);
        return;
      }

      if (!entry || entry.socket !== socket) return; // 没 hello 过的连接说什么都不算
      entry.lastSeenAt = now();

      if (frame.type === 'directories' || frame.type === 'files' || frame.type === 'file') {
        const request = pending.get(frame.requestId);
        if (!request || request.workerId !== entry.workerId) return;
        clearTimeout(request.timer);
        pending.delete(frame.requestId);
        request.settle(frame);
        return;
      }
      const from = entry.workerId;
      if (frame.type === 'event') hooks.onEvent(from, frame.sessionId as SessionId, frame.event);
      else if (frame.type === 'agent_session') {
        hooks.onAgentSession(from, frame.sessionId as SessionId, frame.agentSessionRef);
      } else if (frame.type === 'options') {
        hooks.onOptions(from, frame.sessionId as SessionId, frame.options);
      } else if (frame.type === 'status') {
        // 路由只由 start_session / adopt 建立；一台 Worker 报「running」不能把别人的会话改道到自己身上，
        // 报「结束」也只能划掉确实路由到它的那条。
        if (frame.status !== 'running' && placement.get(frame.sessionId) === from) placement.delete(frame.sessionId);
        hooks.onStatus(from, frame.sessionId as SessionId, frame.status, frame.reason);
      }
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (entry) markOffline(entry, socket, closeReason);
    });

    socket.on('error', () => {
      closeReason = '连接出错';
    });

    // 给心跳用：超时的时候先把原因写好，再 terminate 触发 close。
    (socket as WebSocket & { markTimeout?: () => void }).markTimeout = () => {
      closeReason = '心跳超时';
    };
  });

  const heartbeat = setInterval(() => {
    for (const entry of registry.values()) {
      const socket = entry.socket;
      if (!socket) continue;
      if (!entry.alive) {
        (socket as WebSocket & { markTimeout?: () => void }).markTimeout?.();
        socket.terminate();
        continue;
      }
      entry.alive = false;
      try {
        socket.ping();
      } catch {
        // 下一轮会因为没有 pong 被判离线
      }
    }
  }, heartbeatMs);
  heartbeat.unref();

  function describe(entry: Registered): WorkerStatus {
    let sessionCount = 0;
    for (const workerId of placement.values()) if (workerId === entry.workerId) sessionCount += 1;
    const status: WorkerStatus = {
      workerId: entry.workerId,
      label: entry.label,
      origin: entry.origin,
      state: entry.socket ? 'online' : 'offline',
      agentIds: entry.agents.map((agent) => agent.id),
      roots: entry.roots,
      lastSeenAt: entry.lastSeenAt,
      sessionCount,
      ...(entry.host ? { hostname: entry.host.hostname, platform: `${entry.host.platform}/${entry.host.arch}` } : {}),
      ...(entry.socket === null && entry.reason !== undefined ? { reason: entry.reason } : {})
    };
    return status;
  }

  // 在线的排前面，同状态下本机在前，其次按名字：管理视图和选择器都按这个顺序显示。
  const rank = (w: WorkerStatus) => (w.state === 'online' ? 0 : 2) + (w.origin === 'local' ? 0 : 1);
  const statuses = (): WorkerStatus[] =>
    [...registry.values()].map(describe).sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));

  function request(
    workerId: string,
    what: string,
    build: (requestId: string) => ServerToWorker
  ): Promise<Result<ReplyFrame, DomainError>> {
    return new Promise((resolve) => {
      requestSeq += 1;
      const requestId = `req-${requestSeq}`;
      const settle = (reply: ReplyFrame | DomainError): void =>
        resolve('type' in reply ? { ok: true, value: reply } : { ok: false, error: reply });
      const timer = setTimeout(() => {
        pending.delete(requestId);
        settle(unavailable(`Worker「${labelOf(workerId)}」没有及时回复${what}`));
      }, requestTimeoutMs);
      pending.set(requestId, { workerId, settle, timer });
      const sent = sendTo(workerId, build(requestId));
      if (!sent.ok) {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(sent);
      }
    });
  }

  const gateway: NodeGateway = {
    async status(): Promise<WorkerStatus[]> {
      return statuses();
    },
    async dispatch(command: WorkerCommand): Promise<Result<void, DomainError>> {
      return dispatchTo(command);
    },
    async listDirectories(workerId: string, path: string) {
      const reply = await request(workerId, '目录列表', (requestId) => ({ kind: 'list_directories', requestId, path }));
      if (!reply.ok) return reply;
      const frame = reply.value;
      if (frame.type !== 'directories') return { ok: false, error: unavailable('Worker 回错了帧') };
      if (frame.error !== undefined) return { ok: false, error: unavailable(frame.error) };
      return { ok: true, value: { path: frame.path, exists: frame.exists, entries: frame.entries } };
    },
    async listFiles(workerId: string, root: string, limit: number) {
      const reply = await request(workerId, '文件清单', (requestId) => ({ kind: 'list_files', requestId, root, limit }));
      if (!reply.ok) return reply;
      const frame = reply.value;
      if (frame.type !== 'files') return { ok: false, error: unavailable('Worker 回错了帧') };
      if (frame.error !== undefined) return { ok: false, error: unavailable(frame.error) };
      return { ok: true, value: { files: frame.files, truncated: frame.truncated } };
    },
    async readFile(workerId: string, path: string, maxBytes: number) {
      const reply = await request(workerId, '文件', (requestId) => ({ kind: 'read_file', requestId, path, maxBytes }));
      if (!reply.ok) return reply;
      const frame = reply.value;
      if (frame.type !== 'file') return { ok: false, error: unavailable('Worker 回错了帧') };
      if (frame.error !== undefined) return { ok: false, error: unavailable(frame.error) };
      return { ok: true, value: frame.data === null ? null : new Uint8Array(Buffer.from(frame.data, 'base64')) };
    }
  };

  return {
    gateway,
    workers(): WorkerStatus[] {
      return statuses();
    },
    adopt(workerId: string, sessionIds: readonly string[]): void {
      if (!online(workerId)) return;
      for (const sessionId of sessionIds) placement.set(sessionId, workerId);
    },
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    },
    close(): void {
      clearInterval(heartbeat);
      for (const request of pending.values()) clearTimeout(request.timer);
      pending.clear();
      for (const entry of registry.values()) entry.socket?.terminate();
      registry.clear();
      wss.close();
    }
  };
}

function toWire(command: WorkerCommand): Exclude<ServerToWorker, { kind: 'list_directories' | 'list_files' | 'read_file' }> {
  switch (command.kind) {
    case 'start_session':
      return {
        kind: 'start_session',
        sessionId: command.sessionId,
        taskId: command.taskId,
        agentId: command.agentId,
        workspaceRoot: command.workspaceRoot,
        origin: command.origin,
        resume: command.resume,
        options: command.options
      };
    case 'prompt':
      return { kind: 'prompt', sessionId: command.sessionId, text: command.text, parts: [...command.parts] };
    case 'interrupt':
      return { kind: 'interrupt', sessionId: command.sessionId };
    case 'dispose':
      return { kind: 'dispose', sessionId: command.sessionId };
    case 'set_option':
      return {
        kind: 'set_option',
        sessionId: command.sessionId,
        optionId: command.optionId,
        value: command.value
      };
  }
}
