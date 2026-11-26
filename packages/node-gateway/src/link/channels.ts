import { WebSocket } from 'ws';
import { canInvoke } from '@agent-hub/domain';
import type { ServerToWorker, WorkerToServer } from '@agent-hub/contract';
import {
  RpcFailure,
  procList,
  serviceList,
  serviceLogs,
  serviceStart,
  serviceStop,
  terminalClose,
  terminalList,
  terminalOpen,
  terminalResize,
  workdirTerminalInventory, workdirTerminalCreate, workdirTerminalAttach, workdirTerminalResize, workdirTerminalClose
} from '@agent-hub/contract';
import { TerminalNotReadyError } from '../terminal.ts';
import { ServiceHostError, type ServiceStateEvent } from '../service-host.ts';
import { message, type LinkCtx } from './ctx.ts';
import type { Transport } from './transport.ts';

export interface Channels {
  /** 键盘输入是单向帧：坏帧丢掉比让键盘卡住强。 */
  terminalInput(command: Extract<ServerToWorker, { kind: 'terminal_input' }>): void;
  workdirTerminalFrame(command: Extract<ServerToWorker, { kind: 'workdir_terminal_input_v1' | 'workdir_terminal_detach_v1' }>): void;
  sendTerminalData(terminalId: string, data: Uint8Array): void;
  sendTerminalExit(terminalId: string, code: number, signal?: number): void;
  sendServiceState(event: ServiceStateEvent): void;
  sendServiceLog(serviceId: string, chunk: string): void;
  /** 回收终端 / 本地服务与它们的合批缓冲（`close()` 的后半段）。 */
  close(): Promise<void>;
}

/** 会话结束 / 链路关闭：终端不能留着，否则 shell 成了孤儿。 */
export async function closeTerminals(ctx: LinkCtx, sessionId: string): Promise<void> {
  if (!ctx.options.terminal) return;
  try {
    await ctx.options.terminal.closeSession(sessionId);
  } catch (error) {
    ctx.options.onLog?.(`回收会话 ${sessionId} 的终端失败：${message(error)}`);
  }
}

/** 标准 base64（带 padding）。 */
const TERMINAL_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/**
 * 键盘输入是单向帧：坏帧丢掉比让键盘卡住强。Node 的 base64 解码器会静默吞坏字符，
 * 所以解完再编回去核对——不然一个非法字符只会让半个按键生效。
 */
function decodeTerminalInput(data: string): Buffer | null {
  if (data.length === 0) return Buffer.alloc(0);
  if (data.length % 4 !== 0 || !TERMINAL_BASE64.test(data)) return null;
  const bytes = Buffer.from(data, 'base64');
  return bytes.toString('base64') === data ? bytes : null;
}

/** 终端、本地服务、进程清单通道。 */
export function installChannels(ctx: LinkCtx, transport: Transport): Channels {
  const options = ctx.options;
  const channel = transport.channel;

  /**
   * 终端 RPC（docs/design/terminal.md §5）：hub 只转终端号，cwd 和 shell 都由这台机器决定。
   * 没装 node-pty / 组合根没装配 = unsupported，界面不显示终端页签。
   */
  const terminal = options.terminal;
  const terminalUnavailable = (): never => {
    throw new RpcFailure('unsupported', '这台 Worker 不支持终端');
  };
  channel.handle(terminalOpen, async ({ terminalId, sessionId, cols, rows, cwd }) => {
    if (!terminal) return terminalUnavailable();
    try {
      return await terminal.open({ terminalId, sessionId, cols, rows, cwd });
    } catch (error) {
      throw new RpcFailure(error instanceof TerminalNotReadyError ? 'not_ready' : 'failed', message(error));
    }
  });
  channel.handle(terminalResize, async ({ terminalId, cols, rows }) => {
    if (!terminal) return terminalUnavailable();
    try {
      return await terminal.resize(terminalId, cols, rows);
    } catch (error) {
      throw new RpcFailure('failed', message(error));
    }
  });
  channel.handle(terminalClose, async ({ terminalId }) => {
    if (!terminal) return terminalUnavailable();
    try {
      return await terminal.close(terminalId);
    } catch (error) {
      throw new RpcFailure('failed', message(error));
    }
  });
  channel.handle(terminalList, async () => ({ terminals: terminal ? terminal.list() : [] }));
  const wdt = options.workdirTerminal;
  if (wdt) {
    channel.handle(workdirTerminalInventory, () => wdt.inventory());
    channel.handle(workdirTerminalCreate, (input) => wdt.create(input));
    channel.handle(workdirTerminalAttach, (input) => wdt.attach(input));
    channel.handle(workdirTerminalResize, (input) => wdt.resize(input));
    channel.handle(workdirTerminalClose, (input) => wdt.close(input));
  }

  /**
   * 会话服务 RPC（docs/design/session-service.md §4）：root 边界、端口就绪、重拉退避都在
   * ServiceHost 里，这里只做「没有装配就 unsupported」和错误码翻译。
   */
  const service = options.service;
  /** 500ms 合批：Docker 式的构建日志一刷就是几十行，逐条发会把链路打满。 */
  const SERVICE_LOG_INTERVAL_MS = 500;
  const SERVICE_LOG_FRAME_MAX = 16_384;
  const serviceLogBuffers = new Map<string, string>();
  const serviceLogTimers = new Map<string, NodeJS.Timeout>();
  const serviceUnavailable = (): never => {
    throw new RpcFailure('unsupported', '这台 Worker 不支持本地服务');
  };
  const serviceFailure = (error: unknown): RpcFailure =>
    new RpcFailure(error instanceof ServiceHostError ? error.code : 'failed', message(error));
  channel.handle(serviceStart, async (input) => {
    if (!service) return serviceUnavailable();
    try {
      return await service.start({
        serviceId: input.serviceId,
        root: input.root,
        command: input.command,
        port: input.port ?? null,
        env: input.env ?? {},
        restart: input.restart
      });
    } catch (error) {
      throw serviceFailure(error);
    }
  });
  channel.handle(serviceStop, async ({ serviceId, signal }) => {
    if (!service) return serviceUnavailable();
    try {
      return await service.stop(serviceId, signal);
    } catch (error) {
      throw serviceFailure(error);
    }
  });
  channel.handle(serviceList, async () => ({ services: service ? [...service.list()] : [] }));
  channel.handle(serviceLogs, async ({ serviceId, maxBytes }) => {
    if (!service) return serviceUnavailable();
    try {
      return { tail: service.logs(serviceId, maxBytes) };
    } catch (error) {
      throw serviceFailure(error);
    }
  });

  /** 只读进程清单：worker 侧扫描，hub 只展示；没有装配 = 老 Worker。 */
  channel.handle(procList, async () => {
    if (!options.processes) throw new RpcFailure('unsupported', '这台 Worker 不支持进程清单');
    return { processes: [...options.processes()] };
  });

  return {
    workdirTerminalFrame(command) {
      if (!wdt || !ctx.accepted || !canInvoke(ctx.granted, 'sessions')) return;
      if (command.kind === 'workdir_terminal_detach_v1') wdt.detach(command);
      else { const data = decodeTerminalInput(command.data); if (data) wdt.input({ ...command, data }); }
    },
    terminalInput(command: Extract<ServerToWorker, { kind: 'terminal_input' }>): void {
      if (!options.terminal) return;
      const bytes = decodeTerminalInput(command.data);
      if (bytes === null) {
        options.onLog?.(`终端 ${command.terminalId} 的输入不是合法 base64，忽略`);
        return;
      }
      if (bytes.length === 0) return;
      if (!options.terminal.write(command.terminalId, bytes)) options.onLog?.(`终端 ${command.terminalId} 不存在，输入丢弃`);
    },
    sendTerminalData(terminalId: string, data: Uint8Array): void {
      // 不进 outbox：断线几十秒后补发一屏旧像素既没用又挤占补发额度，重连后 hub 会让人重开终端。
      if (!ctx.socket || ctx.socket.readyState !== WebSocket.OPEN || !ctx.accepted) return;
      ctx.socket.send(JSON.stringify({ type: 'terminal_data', terminalId, data: Buffer.from(data).toString('base64') } satisfies WorkerToServer));
    },
    sendTerminalExit(terminalId: string, code: number, signal?: number): void {
      if (!ctx.socket || ctx.socket.readyState !== WebSocket.OPEN || !ctx.accepted) return;
      ctx.socket.send(JSON.stringify({ type: 'terminal_exit', terminalId, code, ...(signal === undefined ? {} : { signal }) } satisfies WorkerToServer));
    },
    sendServiceState(event: ServiceStateEvent): void {
      transport.send({
        type: 'service_state',
        serviceId: event.serviceId,
        state: event.state,
        ...(event.pid === null ? {} : { pid: event.pid }),
        ...(event.detail === null ? {} : { detail: event.detail }),
        ...(event.port === null ? {} : { port: event.port })
      });
    },
    sendServiceLog(serviceId: string, chunk: string): void {
      if (chunk === '') return;
      const pending = (serviceLogBuffers.get(serviceId) ?? '') + chunk;
      serviceLogBuffers.set(serviceId, pending.length > SERVICE_LOG_FRAME_MAX ? pending.slice(-SERVICE_LOG_FRAME_MAX) : pending);
      if (serviceLogTimers.has(serviceId)) return;
      const timer = setTimeout(() => {
        serviceLogTimers.delete(serviceId);
        const text = serviceLogBuffers.get(serviceId) ?? '';
        serviceLogBuffers.delete(serviceId);
        if (text === '') return;
        transport.send({ type: 'service_log', serviceId, chunk: text });
      }, SERVICE_LOG_INTERVAL_MS);
      timer.unref?.();
      serviceLogTimers.set(serviceId, timer);
    },
    async close(): Promise<void> {
      await options.workdirTerminal?.disposeAll();
      await options.terminal?.disposeAll().catch((error: unknown) => options.onLog?.(`回收终端失败：${message(error)}`));
      options.service?.dispose();
      for (const timer of serviceLogTimers.values()) clearTimeout(timer);
      serviceLogTimers.clear();
      serviceLogBuffers.clear();
    }
  };
}
