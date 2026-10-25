import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentDto, ServerToWorker, WorkerToServer } from '@agent-hub/contract';
import { serverToWorkerSchema, workerToServerSchema } from '@agent-hub/contract';
import type {
  AgentDescriptor,
  DomainError,
  NodeGateway,
  Result,
  RuntimeOption,
  SessionEvent,
  SessionId,
  WorkerCommand,
  WorkerStatus
} from '@agent-hub/domain';
import { unavailable } from '@agent-hub/domain';

export interface GatewayHooks {
  readonly token: string | null;
  onHello(worker: WorkerStatus, agents: AgentDto[]): void;
  onEvent(sessionId: SessionId, event: SessionEvent): void;
  onAgentSession(sessionId: SessionId, agentSessionRef: string): void;
  onOptions(sessionId: SessionId, options: readonly RuntimeOption[]): void;
  onStatus(sessionId: SessionId, status: string, reason?: string): void;
  onWorkerGone(workerId: string): void;
  onLog?(message: string): void;
}

interface Connected {
  readonly workerId: string;
  readonly label: string;
  readonly socket: WebSocket;
  readonly agents: AgentDto[];
}

export interface ServerGateway {
  readonly gateway: NodeGateway;
  workers(): WorkerStatus[];
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

/**
 * server 侧的 worker 通道。指令下行、事件上行，一条 WebSocket 两条流。
 * v1 只有一个本地 worker，但这里按 workerId 索引——多机不是新代码，是更长的列表。
 */
export function createServerGateway(hooks: GatewayHooks): ServerGateway {
  const connected = new Map<string, Connected>();
  const wss = new WebSocketServer({ noServer: true });

  function dispatchTo(command: ServerToWorker): Result<void, DomainError> {
    const target = [...connected.values()].find((entry) => entry.socket.readyState === WebSocket.OPEN);
    if (!target) return { ok: false, error: unavailable('没有在线的 worker') };
    target.socket.send(JSON.stringify(command));
    return { ok: true, value: undefined };
  }

  wss.on('connection', (socket: WebSocket) => {
    let workerId: string | null = null;

    socket.on('message', (raw: Buffer) => {
      const parsed = workerToServerSchema.safeParse(JSON.parse(raw.toString()));
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
        workerId = frame.workerId;
        connected.set(workerId, {
          workerId,
          label: frame.label,
          socket,
          agents: frame.agents
        });
        hooks.onHello(
          {
            workerId,
            label: frame.label,
            origin: frame.origin,
            state: 'online'
          },
          frame.agents
        );
        return;
      }

      if (frame.type === 'event') hooks.onEvent(frame.sessionId as SessionId, frame.event);
      else if (frame.type === 'agent_session') {
        hooks.onAgentSession(frame.sessionId as SessionId, frame.agentSessionRef);
      } else if (frame.type === 'options') {
        hooks.onOptions(frame.sessionId as SessionId, frame.options);
      } else if (frame.type === 'status') hooks.onStatus(frame.sessionId as SessionId, frame.status, frame.reason);
    });

    socket.on('close', () => {
      if (workerId === null) return;
      connected.delete(workerId);
      hooks.onWorkerGone(workerId);
    });
  });

  const statuses = (): WorkerStatus[] =>
    [...connected.values()].map((entry) => ({
        workerId: entry.workerId,
        label: entry.label,
      origin: 'local' as const,
      state: 'online' as const
    }));

  const gateway: NodeGateway = {
    async status(): Promise<WorkerStatus[]> {
      return statuses();
    },
    async dispatch(command: WorkerCommand): Promise<Result<void, DomainError>> {
      return dispatchTo(toWire(command));
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
      for (const entry of connected.values()) entry.socket.terminate();
      connected.clear();
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
        model: command.model,
        workspaceRoot: command.workspaceRoot,
        origin: command.origin,
        resume: command.resume,
        options: command.options
      };
    case 'prompt':
      return { kind: 'prompt', sessionId: command.sessionId, text: command.text };
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

/** 让 server 侧也能把 worker 报上来的 AgentDto 还原成领域描述。 */
export function toDescriptor(dto: AgentDto): AgentDescriptor {
  return {
    id: dto.id as AgentDescriptor['id'],
    label: dto.label,
    capabilities: dto.capabilities as AgentDescriptor['capabilities'],
    models: dto.models,
    defaultModel: dto.defaultModel,
    options: dto.options as AgentDescriptor['options']
  };
}
