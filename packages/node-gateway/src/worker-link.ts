import { WebSocket } from 'ws';
import type { ServerToWorker, SessionEventDto, WorkerToServer } from '@agent-hub/contract';
import { PROTOCOL_MISMATCH_CLOSE, createRpcChannel, serverToWorkerSchema } from '@agent-hub/contract';
import { agentToDto } from '@agent-hub/contract/codec';
import type {
  AgentRuntime,
  BuildInfo,
  RuntimeOption,
  RuntimeSession,
  SessionEvent,
  StartSpec
} from '@agent-hub/domain';
import { asSessionId } from '@agent-hub/domain';
import type { WorkerFiles } from './worker-files.ts';
import type { UpdateReport } from './updater.ts';
import { createMcpEndpoint } from './mcp-endpoint.ts';
import { serveWorkerFiles } from './worker-fs-rpc.ts';

export interface WorkerLinkOptions {
  readonly url: string;
  readonly token: string;
  readonly workerId: string;
  readonly label: string;
  readonly origin?: 'local' | 'remote';
  /** server 拉起本机 worker 时给的口令（HUB_LOCAL_SECRET），证明 origin: 'local' 不是自封的。 */
  readonly localSecret?: string;
  /** 单台机器接入换来的专属凭据；有它时 hub 不看共享 token。 */
  readonly credential?: string;
  readonly runtimes: readonly AgentRuntime[];
  readonly onLog?: (message: string) => void;
  /**
   * 断线后自动重连（指数退避，封顶 `maxBackoffMs`）。默认开：
   * 一台远程机器不该因为 hub 重启一次就永久掉队，得有人 ssh 上去重开。
   * 重连后重新 hello，并报上手上还活着的会话，server 据此接回托管。
   * 关掉（`false`）时断线即调 `onClose`——给测试和一次性脚本用。
   */
  readonly reconnect?: boolean;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** 多久没收到 server 的 ping 就认为连接已死（半开连接不会触发 close）。0 = 不检测。 */
  readonly heartbeatTimeoutMs?: number;
  /** 机器信息与目录起点，出现在管理视图和目录选择器里。 */
  readonly host?: { readonly hostname: string; readonly platform: string; readonly arch: string };
  readonly roots?: readonly string[];
  /**
   * 这台机器上的文件操作（目录浏览、`@` 文件清单、附件落盘与回读、产出物大小），
   * 都过 WORKER_ROOTS 边界。不给就回「这台不支持」，附件也不落盘。
   */
  readonly files?: WorkerFiles;
  /** 连接（最终）关闭了：`reconnect: false` 时每次断线、或 `close()` 之后。 */
  readonly onClose?: (why?: { readonly code: number }) => void;
  /** 每次连上（含重连）。 */
  readonly onOpen?: () => void;
  /** adapter 拿到 agent 报的可调项时回调（ACP 在 session/new 就给了，Pi 要问一次）。 */
  readonly onOptions?: (sessionId: string, options: readonly RuntimeOption[]) => void;
  /** 这台跑的代码版本，hello 时报上去。 */
  readonly build?: BuildInfo;
  /**
   * hub 让它更新到某个提交。`report` 把进度回给 hub。不给就一律回「不支持远程更新」。
   * 同一时间只跑一次：正在更新时再来的指令直接拒绝。
   */
  /** 经长连接中转的工具调用等 hub 答复的上限。 */
  readonly toolTimeoutMs?: number;
  readonly onUpdate?: (commit: string, report: (status: UpdateReport) => void) => Promise<void>;
}

export interface WorkerLink {
  /** 双权威的桥：agent 自己的会话 id 要送回 server 存进 agentSessionRef。 */
  notifyAgentSessionRef(sessionId: string, agentSessionRef: string): void;
  /** agent 报上来的可调项当前值（模型、思考强度……）。 */
  notifyOptions(sessionId: string, options: readonly RuntimeOption[]): void;
  close(): Promise<void>;
}

/**
 * worker 侧。它只会做三件事：托管 agent 进程、把事件推上去、接受下行指令。
 * 它不知道任务、不知道画布、不知道权限——那些在 server 的内核里。
 */
type SessionCommand = Exclude<
  ServerToWorker,
  { kind: 'update' | 'rpc' | 'enrolled' }
>;

export function connectWorkerLink(options: WorkerLinkOptions): WorkerLink {
  const sessions = new Map<string, RuntimeSession>();
  /** 会话的工作目录：解析产出物的相对路径用。 */
  const workspaces = new Map<string, string>();
  /**
   * 每条会话一条串行队列。server 会连着发 start_session + prompt，
   * 而 start 是异步的（要拉起 agent 进程）——不排队的话 prompt 会先到，
   * 撞上「未知会话」。这是真发生过的失败，不是理论问题。
   */
  const starting = new Map<string, Promise<void>>();
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  /**
   * 断线期间产生的帧先攒着，连回来按顺序补发。agent 不会因为网络抖一下就停：
   * 不攒的话那段输出就永远丢了（server 那边 journal 有幂等保护，补发不会写两遍）。
   * 有上限：断太久就丢最旧的，并在补发时说一声。
   */
  const outbox: WorkerToServer[] = [];
  const OUTBOX_LIMIT = 5_000;
  let dropped = 0;
  let updating = false;

  /**
   * 这条长连接上的 RPC 通道（端口的实现）。hub→worker 的 fs.*、worker→hub 的 mcp.message 都走它。
   * 不进 outbox：断线时在途调用直接以 closed 结束，比连回来后补发一个早已超时的调用诚实。
   */
  const channel = createRpcChannel({
    idPrefix: 'w',
    timeoutMs: options.toolTimeoutMs ?? 60_000,
    send: (frame) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ type: 'rpc', frame } satisfies WorkerToServer));
      return true;
    }
  });
  serveWorkerFiles(channel, options.files, options.roots ?? []);
  /** agent 连的本机 MCP 入口：薄适配器，只把 JSON-RPC 经通道交给 hub。 */
  const mcpEndpoint = createMcpEndpoint(channel);

  const send = (frame: WorkerToServer): void => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
      return;
    }
    if (closed) return;
    outbox.push(frame);
    if (outbox.length > OUTBOX_LIMIT) {
      outbox.shift();
      dropped += 1;
    }
  };

  const armWatchdog = (current: WebSocket): void => {
    const timeout = options.heartbeatTimeoutMs ?? 30_000;
    if (timeout <= 0) return;
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      options.onLog?.(`${Math.round(timeout / 1000)} 秒没收到 server 心跳，断开重连`);
      current.terminate();
    }, timeout);
    watchdog.unref?.();
  };

  function connect(): void {
    const current = new WebSocket(options.url);
    socket = current;

    current.on('open', () => {
      attempt = 0;
      // hello 必须是第一帧：先于补发的积压事件，server 才知道这些事件是谁的。
      current.send(
        JSON.stringify({
          type: 'hello',
          workerId: options.workerId,
          label: options.label,
          origin: options.origin ?? 'local',
          token: options.token,
          ...(options.localSecret ? { localSecret: options.localSecret } : {}),
          ...(options.credential ? { credential: options.credential } : {}),
          agents: options.runtimes.map((runtime) => agentToDto(runtime.descriptor)),
          ...(options.host ? { host: options.host } : {}),
          roots: [...(options.files?.roots ?? options.roots ?? [])],
          sessions: [...sessions.keys()],
          ...(options.build ? { build: options.build } : {})
        } satisfies WorkerToServer)
      );
      options.onLog?.(`已连上 ${options.url}${sessions.size > 0 ? `，接回 ${sessions.size} 个会话` : ''}`);
      if (dropped > 0) options.onLog?.(`断线太久，丢了 ${dropped} 帧最旧的输出`);
      dropped = 0;
      for (const frame of outbox.splice(0)) current.send(JSON.stringify(frame));
      armWatchdog(current);
      options.onOpen?.();
    });

    current.on('ping', () => armWatchdog(current));

    current.on('close', (code: number, reason: Buffer) => {
      if (watchdog) clearTimeout(watchdog);
      if (socket === current) socket = null;
      if (socket === null) channel.close('与 hub 断开了，调用没有完成');
      if (code === PROTOCOL_MISMATCH_CLOSE) {
        // 协议对不上：重连也没用，把 hub 给的原因原样打出来，告诉人怎么修。
        options.onLog?.(`${reason.toString() || '与 hub 的协议版本不兼容'}。不再重连`);
        closed = true;
        options.onClose?.();
        return;
      }
      if (code === 4401 || code === 4403) {
        // token 错了、或管理员把这台机器断开了：重连多少次都一样，直接停，别刷屏。
        options.onLog?.(
          code === 4401 ? `hub 拒绝了这台机器（${reason.toString() || 'token 不匹配'}），不再重连` : '被管理员断开，不再重连'
        );
        closed = true;
        options.onClose?.({ code });
        return;
      }
      if (closed || options.reconnect === false) {
        options.onLog?.('与 server 断开');
        options.onClose?.();
        return;
      }
      const base = options.initialBackoffMs ?? 500;
      const cap = options.maxBackoffMs ?? 15_000;
      const delay = Math.min(cap, base * 2 ** attempt) * (0.8 + Math.random() * 0.4);
      attempt += 1;
      options.onLog?.(`与 server 断开，${(delay / 1000).toFixed(1)} 秒后重连（第 ${attempt} 次）`);
      reconnectTimer = setTimeout(connect, delay);
    });

    current.on('error', (error: Error) => {
      options.onLog?.(`连接错误：${error.message}`);
    });

    current.on('message', (raw: Buffer) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        options.onLog?.('server 发来的不是 JSON');
        return;
      }
      const parsed = serverToWorkerSchema.safeParse(json);
      if (!parsed.success) {
        options.onLog?.(`server 发来无法解析的帧：${parsed.error.message}`);
        return;
      }
      const command = parsed.data as ServerToWorker;
      if (command.kind === 'rpc') channel.receive(command.frame);
      else if (command.kind === 'update') void update(command.commit);
      else if (command.kind === 'enrolled') return; // 只在 enroll 握手里出现
      else void handle(command);
    });
  }

  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  async function update(commit: string): Promise<void> {
    const report = (status: UpdateReport): void => send({ type: 'update_status', ...status });
    if (!options.onUpdate) return report({ state: 'refused', message: '这台 Worker 不支持远程更新', logTail: '' });
    if (updating) return report({ state: 'refused', message: '已经在更新了', logTail: '' });
    updating = true;
    try {
      await options.onUpdate(commit, report);
    } catch (error) {
      report({ state: 'failed', message: `更新出错：${message(error)}`, logTail: '' });
    } finally {
      updating = false;
    }
  }

  /** 上传的附件由 hub 随 prompt 发来（base64），在 agent 读它之前落进这台机器的项目目录。 */
  async function persistParts(parts: Extract<ServerToWorker, { kind: 'prompt' }>['parts']): Promise<void> {
    for (const part of parts) {
      if (part.kind === 'mention') continue;
      if (!part.path.includes('/.agent-hub/attachments/')) throw new Error(`附件路径不对：${part.path}`);
      if (!options.files) throw new Error('这台 Worker 不支持接收附件');
      await options.files.writeFile(part.path, new Uint8Array(Buffer.from(part.data, 'base64')));
    }
  }

  /** 产出物大小只有这台机器量得到：相对路径按会话的工作目录解析。 */
  async function withBytes(sessionId: string, event: SessionEvent): Promise<SessionEvent> {
    if (event.kind !== 'artifact' || !options.files) return event;
    const root = workspaces.get(sessionId);
    const absolute = event.path.startsWith('/') ? event.path : root ? `${root.replace(/\/+$/, '')}/${event.path}` : null;
    if (absolute === null) return event;
    const bytes = await options.files.stat(absolute);
    return bytes === null ? event : { ...event, bytes };
  }

  connect();

  /**
   * 一条指令失败不能静默。之前 `runtime.start` 抛错时异常沉进未处理的 Promise，
   * 日志里只留下「未知会话」——真正的错误被吞掉了，排障只能靠猜。
   */
  async function handle(command: SessionCommand): Promise<void> {
    try {
      await run(command);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.onLog?.(`${command.kind} 指令失败：${reason}`);
      send({
        type: 'event',
        sessionId: command.sessionId,
        event: { kind: 'ended', outcome: 'failed', reason: `${command.kind} 失败：${reason}` }
      });
      sessions.delete(command.sessionId);
    }
  }

  async function run(command: SessionCommand): Promise<void> {
    if (command.kind === 'start_session') {
      const started = startSession(command);
      starting.set(command.sessionId, started.catch(() => undefined));
      try {
        await started;
      } finally {
        starting.delete(command.sessionId);
      }
      return;
    }

    const sessionId = command.sessionId;
    const pendingStart = starting.get(sessionId);
    if (pendingStart) await pendingStart;
    const session = sessions.get(sessionId);
    if (!session) {
      // server 以为这条会话还活着（它只在收到 ended 时才忘掉）。
      // 主动告诉它「已经不在了」，它下一次点击就会重新拉起，而不是又一次撞空。
      options.onLog?.(`未知会话：${sessionId}`);
      send({ type: 'status', sessionId, status: 'gone' });
      return;
    }
    if (command.kind === 'prompt') {
      await persistParts(command.parts);
      const result = await session.prompt({ text: command.text, parts: command.parts });
      if (!result.ok) {
        send({
          type: 'event',
          sessionId,
          event: { kind: 'diagnostic', level: 'error', text: result.error.message }
        });
      }
      return;
    }
    if (command.kind === 'interrupt') {
      await session.interrupt();
      return;
    }
    if (command.kind === 'set_option') {
      const changed = await session.changeOption(command.optionId, command.value);
      if (!changed.ok) {
        send({
          type: 'event',
          sessionId,
          event: { kind: 'diagnostic', level: 'error', text: changed.error.message }
        });
        return;
      }
      send({ type: 'options', sessionId, options: [...changed.value] });
      return;
    }
    await session.dispose();
    sessions.delete(sessionId);
  }

  /** relay：URL 填成本机 MCP 入口，令牌不变。 */
  async function toolAccess(tools: NonNullable<StartSpec['tools']>): Promise<NonNullable<StartSpec['tools']>> {
    return { ...tools, url: await mcpEndpoint.url() };
  }

  async function startSession(command: Extract<ServerToWorker, { kind: 'start_session' }>): Promise<void> {
    const runtime = options.runtimes.find((candidate) => candidate.descriptor.id === command.agentId);
    if (!runtime) {
      send({
        type: 'event',
        sessionId: command.sessionId,
        event: { kind: 'ended', outcome: 'failed', reason: `worker 未安装 ${command.agentId}` }
      });
      return;
    }

    const outside = options.files ? await options.files.check(command.workspaceRoot) : null;
    if (outside !== null) {
      send({ type: 'event', sessionId: command.sessionId, event: { kind: 'ended', outcome: 'failed', reason: outside } });
      return;
    }

    const spec: StartSpec = {
      sessionId: asSessionId(command.sessionId),
      taskId: command.taskId as StartSpec['taskId'],
      workspaceRoot: command.workspaceRoot,
      resume: command.resume,
      options: command.options,
      ...(command.tools ? { tools: await toolAccess(command.tools) } : {})
    };

    // 同一会话又来一次 start（比如断线后 server 重新托管）：先收掉旧的那份 agent。
    // 否则旧进程成了孤儿，它结束时还会把新会话的托管和工具令牌一起带走。
    const previous = sessions.get(command.sessionId);
    if (previous) {
      sessions.delete(command.sessionId);
      workspaces.delete(command.sessionId);
      await previous.dispose().catch(() => {});
    }

    const started = await runtime.start(spec);
    if (!started.ok) {
      options.onLog?.(`${command.agentId} 启动失败：${started.error.message}`);
      send({
        type: 'event',
        sessionId: command.sessionId,
        event: { kind: 'ended', outcome: 'failed', reason: started.error.message }
      });
      return;
    }

    const session = started.value;
    sessions.set(command.sessionId, session);
    workspaces.set(command.sessionId, command.workspaceRoot);
    send({
      type: 'status',
      sessionId: command.sessionId,
      status: 'running'
    });

    void (async () => {
      try {
        for await (const event of session.events()) {
          const enriched = await withBytes(command.sessionId, event);
          send({ type: 'event', sessionId: command.sessionId, event: enriched as SessionEventDto });
          if (event.kind === 'ended') break;
        }
      } finally {
        // 已被同 id 的新 start 顶掉：新的那份才是这条会话，旧的不许再报 ended
        // （否则 server 会撤掉新会话的托管和刚签的工具令牌）；dispose 由顶替方做过了。
        if (sessions.get(command.sessionId) === session) {
          sessions.delete(command.sessionId);
          workspaces.delete(command.sessionId);
          // 必须报「结束了」：不报的话 server 会一直以为这条会话还有人托管，
          // 下次提问就不再拉起 agent，只把 prompt 发给一个不存在的会话。
          send({ type: 'status', sessionId: command.sessionId, status: 'ended' });
          await session.dispose();
        }
      }
    })();
  }

  return {
    notifyAgentSessionRef(sessionId: string, agentSessionRef: string): void {
      send({ type: 'agent_session', sessionId, agentSessionRef });
    },
    notifyOptions(sessionId: string, options: readonly RuntimeOption[]): void {
      send({ type: 'options', sessionId, options: [...options] });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdog) clearTimeout(watchdog);
      channel.close('worker 正在退出');
      await mcpEndpoint.close();
      for (const session of sessions.values()) await session.dispose();
      sessions.clear();
      if (socket) socket.close();
      else options.onClose?.();
    }
  };
}

export type { SessionEvent };
