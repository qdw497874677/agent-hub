import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentDto, RpcChannel, RpcOutcome, RpcPort, ServerToWorker, WorkerToServer } from '@agent-hub/contract';
import {
  PROTOCOL_MISMATCH_CLOSE,
  PROTOCOL_VERSION,
  createRpcChannel,
  fsListDirectories,
  fsListFiles,
  fsMakeDirectory,
  fsReadFile,
  workerToServerSchema
} from '@agent-hub/contract';
import type {
  BuildInfo,
  DomainError,
  NodeGateway,
  Result,
  RuntimeOption,
  RuntimeStatus,
  SessionEvent,
  SessionId,
  WorkerCommand,
  WorkerStatus,
  WorkerUpdate
} from '@agent-hub/domain';
import { invalid, unavailable } from '@agent-hub/domain';

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
  /**
   * 认 hello：专属凭据，或退回共享 HUB_TOKEN（`sharedTokenOk` 由网关算好）。
   * 不给就只看共享令牌（老行为）。拒绝时 reason 原样放进关闭码 4401 的原因里。
   */
  authenticate?(hello: {
    readonly workerId: string;
    readonly credential?: string | undefined;
    readonly sharedTokenOk: boolean;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  onHello(worker: WorkerStatus, agents: AgentDto[], sessions: readonly string[]): void;
  // 以下回调都带上「是哪台 Worker 说的」：会话归不归它，由领域按库里的落点判断。
  onEvent(workerId: string, sessionId: SessionId, event: SessionEvent): void;
  onAgentSession(workerId: string, sessionId: SessionId, agentSessionRef: string): void;
  onOptions(workerId: string, sessionId: SessionId, options: readonly RuntimeOption[]): void;
  onStatus(workerId: string, sessionId: SessionId, status: RuntimeStatus, reason?: string): void;
  onWorkerGone(workerId: string, reason: string): void;
  /** Worker 报来更新进度（给日志用；状态本身网关会记着，出现在 workers() 里）。 */
  onUpdateStatus?(workerId: string, update: WorkerUpdate): void;
  onLog?(message: string): void;
  /**
   * 每条通过认证的连接一条 RPC 通道（端口）：组合根在这里挂 worker→hub 的方法（如 mcp.message），
   * 并绑定「是哪台 Worker」。网关只负责搬帧，不认识任何方法。
   */
  serve?(workerId: string, channel: RpcPort): void;
  /**
   * 接入握手：连接的第一帧是 enroll（配对码）时调用。成功后网关回 `enrolled` 并关闭这条连接。
   * 不给 = 不支持 WS 接入。
   */
  enroll?(request: {
    readonly code: string;
    readonly label: string;
    readonly host?: { hostname: string; platform: string; arch: string } | undefined;
    /** 对端地址：限流用。 */
    readonly address?: string | undefined;
  }): Promise<{ readonly ok: true; readonly workerId: string; readonly credential: string } | { readonly ok: false; readonly reason: string }>;
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
  build: BuildInfo | null;
  update: WorkerUpdate | null;
  /** 最近一次更新的目标提交：它重启后用新版本 hello 上来时，据此判定「更新完成」。 */
  updateTarget: string | null;
  /** 这条连接上的 RPC 通道；离线时为 null。 */
  channel: RpcChannel | null;
}

export interface ServerGateway {
  readonly gateway: NodeGateway;
  workers(): WorkerStatus[];
  /** 把领域核对过落点的会话接回这台 Worker 的路由（重连后不必再 resume）。 */
  adopt(workerId: string, sessionIds: readonly string[]): void;
  /** 这条会话此刻托管在哪台 Worker 上（null = 没有）。工具授权据此核对来源。 */
  hostOf(sessionId: string): string | null;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /**
   * 管理员断开一台在线 Worker（关闭码 4403，Worker 收到后不再重连）。不在线返回 false。
   * `revoked`：凭据已作废——用 4401 断开，并把它从登记表里拿掉。
   */
  disconnect(workerId: string, why?: 'admin' | 'revoked'): boolean;
  /** 让在线的 Worker 更新到这个提交（只发提交号）。不在线返回 false。 */
  requestUpdate(workerId: string, commit: string): boolean;
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
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;

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
    entry.channel?.close(`Worker「${entry.label}」断开了`);
    entry.channel = null;
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

    // 认 hello 要查库（异步）：帧按到达顺序串行处理，hello 后紧跟的补发帧才不会先于登记被丢掉。
    let inbox: Promise<void> = Promise.resolve();
    socket.on('message', (raw: Buffer) => {
      inbox = inbox.then(() => handle(raw)).catch((error: unknown) => {
        hooks.onLog?.(`处理 worker 帧失败：${error instanceof Error ? error.message : String(error)}`);
      });
    });

    const handle = async (raw: Buffer): Promise<void> => {
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

      if (frame.type === 'enroll') {
        if (entry) return;
        clearTimeout(helloTimer);
        if (frame.protocol !== undefined && frame.protocol !== PROTOCOL_VERSION) {
          socket.close(PROTOCOL_MISMATCH_CLOSE, `协议版本不兼容：worker v${frame.protocol}，hub v${PROTOCOL_VERSION}`);
          return;
        }
        const result = hooks.enroll
          ? await hooks.enroll({ code: frame.code, label: frame.label, host: frame.host, address })
          : ({ ok: false, reason: '这个 hub 不支持经长连接接入' } as const);
        if (!result.ok) {
          socket.close(4401, result.reason);
          return;
        }
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ kind: 'enrolled', workerId: result.workerId, credential: result.credential } satisfies ServerToWorker));
        socket.close(1000, '已接入');
        return;
      }

      if (frame.type === 'hello') {
        const sharedTokenOk = hooks.token === null || sameSecret(frame.token, hooks.token);
        const verdict = hooks.authenticate
          ? await hooks.authenticate({ workerId: frame.workerId, credential: frame.credential, sharedTokenOk })
          : sharedTokenOk
            ? ({ ok: true } as const)
            : ({ ok: false, reason: 'token 不匹配' } as const);
        if (!verdict.ok) {
          socket.close(4401, verdict.reason);
          return;
        }
        if (socket.readyState !== WebSocket.OPEN) return;
        if (frame.build && frame.build.protocol !== PROTOCOL_VERSION) {
          socket.close(
            PROTOCOL_MISMATCH_CLOSE,
            `协议版本不兼容：worker v${frame.build.protocol}，hub v${PROTOCOL_VERSION}，请在 worker 上运行 scripts/update-worker.sh`
          );
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
        const build = frame.build ?? null;
        const target = previous?.updateTarget ?? null;
        // 更新成功后 Worker 会退出重启：用目标版本重新 hello 上来，才算真正完成。
        const update: WorkerUpdate | null =
          target !== null && build?.commit === target
            ? { state: 'succeeded', message: `已重启到 ${target.slice(0, 7)}`, logTail: previous?.update?.logTail ?? '', at: now() }
            : (previous?.update ?? null);
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
          alive: true,
          build,
          update,
          updateTarget: target !== null && build?.commit === target ? null : target,
          channel: null
        };
        previous?.channel?.close('被同一台机器的新连接顶替');
        const current = socket;
        entry.channel = createRpcChannel({
          idPrefix: 'h',
          timeoutMs: requestTimeoutMs,
          send: (rpc) => {
            if (current.readyState !== WebSocket.OPEN) return false;
            current.send(JSON.stringify({ kind: 'rpc', frame: rpc } satisfies ServerToWorker));
            return true;
          }
        });
        hooks.serve?.(frame.workerId, entry.channel);
        registry.set(frame.workerId, entry);
        socket.send(JSON.stringify({ kind: 'welcome' } satisfies ServerToWorker));
        hooks.onHello(describe(entry), frame.agents, frame.sessions);
        return;
      }

      if (!entry || entry.socket !== socket) return; // 没 hello 过的连接说什么都不算
      entry.lastSeenAt = now();

      if (frame.type === 'rpc') {
        entry.channel?.receive(frame.frame);
        return;
      }
      if (frame.type === 'update_status') {
        entry.update = { state: frame.state, message: frame.message, logTail: frame.logTail, at: now() };
        if (frame.state === 'failed' || frame.state === 'refused') entry.updateTarget = null;
        hooks.onUpdateStatus?.(entry.workerId, entry.update);
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
    };

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
    (socket as WebSocket & { markKicked?: (reason: string) => void }).markKicked = (reason: string) => {
      closeReason = reason;
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
      ...(entry.socket === null && entry.reason !== undefined ? { reason: entry.reason } : {}),
      ...(entry.build ? { build: entry.build } : {}),
      ...(entry.update ? { update: entry.update } : {})
    };
    return status;
  }

  // 在线的排前面，同状态下本机在前，其次按名字：管理视图和选择器都按这个顺序显示。
  const rank = (w: WorkerStatus) => (w.state === 'online' ? 0 : 2) + (w.origin === 'local' ? 0 : 1);
  const statuses = (): WorkerStatus[] =>
    [...registry.values()].map(describe).sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));

  /** fs.* 请求：经这台的 RPC 通道问，断线 / 超时 / 对端报错都折成领域错误。 */
  function channelOf(workerId: string): RpcChannel | null {
    return online(workerId)?.channel ?? null;
  }
  const offline = (workerId: string) => ({ ok: false as const, error: unavailable(`Worker「${labelOf(workerId)}」不在线`) });
  function toDomain<T>(outcome: RpcOutcome<T>, what: string, workerId: string): Result<T, DomainError> {
    if (outcome.ok) return outcome;
    const { code, message } = outcome.error;
    if (code === 'invalid') return { ok: false, error: invalid(message) };
    if (code === 'timeout') return { ok: false, error: unavailable(`Worker「${labelOf(workerId)}」没有及时回复${what}`) };
    return { ok: false, error: unavailable(message) };
  }

  const gateway: NodeGateway = {
    async status(): Promise<WorkerStatus[]> {
      return statuses();
    },
    async dispatch(command: WorkerCommand): Promise<Result<void, DomainError>> {
      return dispatchTo(command);
    },
    async listDirectories(workerId: string, path: string) {
      const channel = channelOf(workerId);
      if (!channel) return offline(workerId);
      return toDomain(await channel.request(fsListDirectories, { path }), '目录列表', workerId);
    },
    async makeDirectory(workerId: string, parent: string, name: string) {
      const channel = channelOf(workerId);
      if (!channel) return offline(workerId);
      return toDomain(await channel.request(fsMakeDirectory, { parent, name }), '新建文件夹', workerId);
    },
    async listFiles(workerId: string, root: string, limit: number) {
      const channel = channelOf(workerId);
      if (!channel) return offline(workerId);
      return toDomain(await channel.request(fsListFiles, { root, limit }), '文件清单', workerId);
    },
    async readFile(workerId: string, path: string, maxBytes: number) {
      const channel = channelOf(workerId);
      if (!channel) return offline(workerId);
      const read = toDomain(await channel.request(fsReadFile, { path, maxBytes }), '文件', workerId);
      if (!read.ok) return read;
      return { ok: true, value: read.value.data === null ? null : new Uint8Array(Buffer.from(read.value.data, 'base64')) };
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
    hostOf(sessionId: string): string | null {
      return placement.get(sessionId) ?? null;
    },
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    },
    disconnect(workerId: string, why: 'admin' | 'revoked' = 'admin'): boolean {
      const socket = registry.get(workerId)?.socket;
      if (why === 'revoked') registry.delete(workerId); // 吊销了就不再列在机器里
      if (!socket) return false;
      const reason = why === 'revoked' ? '机器已被吊销' : '管理员断开';
      (socket as WebSocket & { markKicked?: (reason: string) => void }).markKicked?.(reason);
      socket.close(why === 'revoked' ? 4401 : 4403, reason);
      return true;
    },
    requestUpdate(workerId: string, commit: string): boolean {
      const entry = online(workerId);
      if (!entry?.socket) return false;
      entry.socket.send(JSON.stringify({ kind: 'update', commit } satisfies ServerToWorker));
      entry.updateTarget = commit;
      entry.update = { state: 'updating', message: `已发出更新指令 → ${commit.slice(0, 7)}`, logTail: '', at: now() };
      return true;
    },
    close(): void {
      clearInterval(heartbeat);
      for (const entry of registry.values()) entry.channel?.close('hub 正在关闭');
      for (const entry of registry.values()) entry.socket?.terminate();
      registry.clear();
      wss.close();
    }
  };
}

function toWire(command: WorkerCommand): ServerToWorker {
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
        options: command.options,
        ...(command.tools ? { tools: command.tools } : {})
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
