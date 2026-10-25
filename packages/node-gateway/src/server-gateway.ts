import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
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
  /** `sessions`：Worker 重连时报上的、它手上还活着的会话。 */
  onHello(worker: WorkerStatus, agents: AgentDto[], sessions: readonly string[]): void;
  onEvent(sessionId: SessionId, event: SessionEvent): void;
  onAgentSession(sessionId: SessionId, agentSessionRef: string): void;
  onOptions(sessionId: SessionId, options: readonly RuntimeOption[]): void;
  onStatus(sessionId: SessionId, status: RuntimeStatus, reason?: string): void;
  onWorkerGone(workerId: string, reason: string): void;
  onLog?(message: string): void;
}

export interface GatewayOptions {
  /** 心跳间隔。连续一个间隔没收到 pong 就判定离线并断开。 */
  readonly heartbeatMs?: number;
  /** 目录浏览这类请求-回复的超时。 */
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

interface Registered {
  readonly workerId: string;
  label: string;
  origin: WorkerStatus['origin'];
  /** null = 离线。离线的 Worker 留在登记表里：管理视图要能显示「上次见到是什么时候」。 */
  socket: WebSocket | null;
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
  const wss = new WebSocketServer({ noServer: true });
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
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

  wss.on('connection', (socket: WebSocket) => {
    let entry: Registered | null = null;
    let closeReason = '连接断开';

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
        if (hooks.token !== null && frame.token !== hooks.token) {
          socket.close(4401, 'token 不匹配');
          return;
        }
        const previous = registry.get(frame.workerId);
        if (previous?.socket && previous.socket !== socket) {
          // 同一台机器换了条连接（重连比旧连接的 close 先到）：新的说了算。
          const stale = previous.socket;
          previous.socket = null;
          stale.terminate();
        }
        entry = {
          workerId: frame.workerId,
          label: frame.label,
          origin: frame.origin,
          socket,
          agents: frame.agents,
          host: frame.host ?? null,
          roots: frame.roots,
          lastSeenAt: now(),
          alive: true
        };
        registry.set(frame.workerId, entry);
        for (const sessionId of frame.sessions) placement.set(sessionId, frame.workerId);
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
      if (frame.type === 'event') hooks.onEvent(frame.sessionId as SessionId, frame.event);
      else if (frame.type === 'agent_session') {
        hooks.onAgentSession(frame.sessionId as SessionId, frame.agentSessionRef);
      } else if (frame.type === 'options') {
        hooks.onOptions(frame.sessionId as SessionId, frame.options);
      } else if (frame.type === 'status') {
        if (frame.status !== 'running') placement.delete(frame.sessionId);
        else placement.set(frame.sessionId, entry.workerId);
        hooks.onStatus(frame.sessionId as SessionId, frame.status, frame.reason);
      }
    });

    socket.on('close', () => {
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
