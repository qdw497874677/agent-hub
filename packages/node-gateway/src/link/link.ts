import type { RuntimeOption } from '@agent-hub/domain';
import type { ServiceStateEvent } from '../service-host.ts';
import { createLinkCtx, type WorkerLinkOptions } from './ctx.ts';
import { installTransport } from './transport.ts';
import { installChannels } from './channels.ts';
import { installSessions } from './sessions.ts';
import { installFrames } from './frames.ts';

export interface WorkerLink {
  /** 双权威的桥：agent 自己的会话 id 要送回 server 存进 agentSessionRef。 */
  notifyAgentSessionRef(sessionId: string, agentSessionRef: string): void;
  /** agent 报上来的可调项当前值（模型、思考强度……）。 */
  notifyOptions(sessionId: string, options: readonly RuntimeOption[]): void;
  /** ADR 0028：这一轮的原生标识。hub 不认（老 hub）就不发。 */
  notifyTurnRef(sessionId: string, turnRef: string, deliveryId?: string): void;
  /** 终端输出回传（base64 后进 `terminal_data`）。不进 outbox：断线期间的旧输出没有意义。 */
  sendTerminalData(terminalId: string, data: Uint8Array): void;
  /** 终端里的进程退出了。 */
  sendTerminalExit(terminalId: string, code: number, signal?: number): void;
  /** 服务状态变化（starting / running / failed / stopped）。 */
  sendServiceState(event: ServiceStateEvent): void;
  /** 服务输出（500ms 合批，只留尾部 16 KiB）。 */
  sendServiceLog(serviceId: string, chunk: string): void;
  /** 终端原始输出转给组合根（预览端口发现用）；没配 `onTerminalOutput` = 丢弃。 */
  forwardTerminalOutput(sessionId: string, text: string): void;
  /** 当前链路还有多少字节没发出去（终端背压用）。 */
  bufferedAmount(): number;
  /** 会话在这台机器上的工作目录；不在这台机器上跑 = undefined（终端据此报错）。 */
  workspaceOf(sessionId: string): string | undefined;
  /** 重新报一次 agent 清单（别名热应用之后调：hub 的机器页 / 模型选择器要立刻看到新清单）。 */
  reportInventory(): void;
  close(): Promise<void>;
}

/**
 * worker 侧。它只会做三件事：托管 agent 进程、把事件推上去、接受下行指令。
 * 它不知道任务、不知道画布、不知道权限——那些在 server 的内核里。
 */
export function connectWorkerLink(options: WorkerLinkOptions): WorkerLink {
  const ctx = createLinkCtx(options);
  const transport = installTransport(ctx);
  const channels = installChannels(ctx, transport);
  const sessions = installSessions(ctx, transport);
  const frames = installFrames(ctx, sessions, transport);
  transport.attach({
    handle: (command) => frames.handle(command),
    refuse: (command) => frames.refuse(command),
    update: (commit) => frames.update(commit),
    runtimeJob: (command) => frames.runtimeJob(command),
    terminalInput: (command) => channels.terminalInput(command)
  });
  transport.connect();

  return {
    notifyAgentSessionRef(sessionId: string, agentSessionRef: string): void {
      transport.send({ type: 'agent_session', sessionId, agentSessionRef });
    },
    notifyOptions(sessionId: string, options: readonly RuntimeOption[]): void {
      transport.send({ type: 'options', sessionId, options: [...options] });
    },
    notifyTurnRef(sessionId: string, turnRef: string, deliveryId?: string): void {
      if (ctx.nativeBranch) transport.send({ type: 'turn_ref', sessionId, turnRef, ...(deliveryId === undefined ? {} : { deliveryId }) });
    },
    sendTerminalData(terminalId: string, data: Uint8Array): void {
      channels.sendTerminalData(terminalId, data);
    },
    sendTerminalExit(terminalId: string, code: number, signal?: number): void {
      channels.sendTerminalExit(terminalId, code, signal);
    },
    sendServiceState(event: ServiceStateEvent): void {
      channels.sendServiceState(event);
    },
    sendServiceLog(serviceId: string, chunk: string): void {
      channels.sendServiceLog(serviceId, chunk);
    },
    forwardTerminalOutput(sessionId: string, text: string): void {
      ctx.options.onTerminalOutput?.(sessionId, text);
    },
    bufferedAmount(): number {
      return ctx.socket?.bufferedAmount ?? 0;
    },
    workspaceOf(sessionId: string): string | undefined {
      return ctx.workspaces.get(sessionId);
    },
    reportInventory: transport.reportInventory,
    async close(): Promise<void> {
      if (ctx.closed) return;
      ctx.closed = true;
      transport.close();
      await sessions.mcpEndpoint.close();
      await ctx.providerRelay.stop();
      await channels.close();
      await sessions.closeAll();
      if (ctx.socket) ctx.socket.close();
      else options.onClose?.();
    }
  };
}
