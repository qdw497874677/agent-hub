import { WebSocket } from 'ws';
import type { AgentDto, ServerToWorker, WorkerToServer } from '@agent-hub/contract';
import { serverToWorkerSchema } from '@agent-hub/contract';
import type {
  AgentRuntime,
  RuntimeOption,
  RuntimeSession,
  SessionEvent,
  StartSpec
} from '@agent-hub/domain';
import { asSessionId } from '@agent-hub/domain';

export interface WorkerLinkOptions {
  readonly url: string;
  readonly token: string;
  readonly workerId: string;
  readonly label: string;
  readonly origin?: 'local' | 'remote';
  readonly runtimes: readonly AgentRuntime[];
  readonly onLog?: (message: string) => void;
  /**
   * 连接断了。
   *
   * worker 不自带重连：它的两个监工（server 的 spawn、systemd）都比它更清楚该不该重开。
   * 之前不退出，server 被杀之后会留下孤儿 worker 连着新 server——
   * 界面上就出现「2/2 节点」，其中一台是上一代进程。
   */
  readonly onClose?: () => void;
  /** adapter 拿到 agent 报的可调项时回调（ACP 在 session/new 就给了，Pi 要问一次）。 */
  readonly onOptions?: (sessionId: string, options: readonly RuntimeOption[]) => void;
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
export function connectWorkerLink(options: WorkerLinkOptions): WorkerLink {
  const sessions = new Map<string, RuntimeSession>();
  /**
   * 每条会话一条串行队列。server 会连着发 start_session + prompt，
   * 而 start 是异步的（要拉起 agent 进程）——不排队的话 prompt 会先到，
   * 撞上「未知会话」。这是真发生过的失败，不是理论问题。
   */
  const starting = new Map<string, Promise<void>>();
  const socket = new WebSocket(options.url);
  let closed = false;

  const send = (frame: WorkerToServer): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  socket.on('open', () => {
    send({
      type: 'hello',
      workerId: options.workerId,
      label: options.label,
      origin: options.origin ?? 'local',
      token: options.token,
      agents: options.runtimes.map((runtime) => runtime.descriptor as unknown as AgentDto)
    });
    options.onLog?.(`已连上 ${options.url}`);
  });

  socket.on('close', () => {
    options.onLog?.('与 server 断开');
    options.onClose?.();
  });

  socket.on('error', (error: Error) => {
    options.onLog?.(`连接错误：${error.message}`);
  });

  socket.on('message', (raw: Buffer) => {
    const parsed = serverToWorkerSchema.safeParse(JSON.parse(raw.toString()));
    if (!parsed.success) {
      options.onLog?.(`server 发来无法解析的帧：${parsed.error.message}`);
      return;
    }
    void handle(parsed.data as ServerToWorker);
  });

  /**
   * 一条指令失败不能静默。之前 `runtime.start` 抛错时异常沉进未处理的 Promise，
   * 日志里只留下「未知会话」——真正的错误被吞掉了，排障只能靠猜。
   */
  async function handle(command: ServerToWorker): Promise<void> {
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

  async function run(command: ServerToWorker): Promise<void> {
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
      const result = await session.prompt(command.text);
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

    const spec: StartSpec = {
      sessionId: asSessionId(command.sessionId),
      taskId: command.taskId as StartSpec['taskId'],
      workspaceRoot: command.workspaceRoot,
      model: command.model,
      resume: command.resume,
      options: command.options
    };

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
    send({
      type: 'status',
      sessionId: command.sessionId,
      status: 'running'
    });

    void (async () => {
      try {
        for await (const event of session.events()) {
          send({ type: 'event', sessionId: command.sessionId, event });
          if (event.kind === 'ended') break;
        }
      } finally {
        sessions.delete(command.sessionId);
        // 必须报「结束了」：不报的话 server 会一直以为这条会话还有人托管，
        // 下次提问就不再拉起 agent，只把 prompt 发给一个不存在的会话。
        send({ type: 'status', sessionId: command.sessionId, status: 'ended' });
        await session.dispose();
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
      for (const session of sessions.values()) await session.dispose();
      sessions.clear();
      socket.close();
    }
  };
}

export type { SessionEvent };
