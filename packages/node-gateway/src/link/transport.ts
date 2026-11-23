import { WebSocket } from 'ws';
import type { ServerToWorker, WorkerToServer } from '@agent-hub/contract';
import {
  PROTOCOL_MISMATCH_CLOSE,
  WORKER_CAPABILITY_DURABLE_DELIVERY,
  WORKER_CAPABILITY_METRICS,
  WORKER_CAPABILITY_NATIVE_BRANCH,
  WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT,
  createRpcChannel,
  linkEcho,
  serverToWorkerSchema
} from '@agent-hub/contract';
import { RECONNECT_POLICY, commandCapability, reconnectDelay, workerWatchdogMs } from '@agent-hub/domain';
import { agentToDto } from '@agent-hub/contract/codec';
import { sameReadiness } from '../harness-registry.ts';
import { serveWorkerFiles } from '../worker-fs-rpc.ts';
import { serveProjectGitBundleImport } from '../worker-fs-rpc.ts';
import { denial, type LinkCtx, type TransportHandlers } from './ctx.ts';

export interface Transport {
  /** 这条长连接上的 RPC 通道（端口的实现）。hub→worker 的 fs.*、worker→hub 的 mcp.message 都走它。 */
  readonly channel: ReturnType<typeof createRpcChannel>;
  /** 装配解码后的帧处理器（frames / channels）；必须在 `connect()` 前调用。 */
  attach(handlers: TransportHandlers): void;
  connect(): void;
  send(frame: WorkerToServer): void;
  /** agent 清单 = runtime 的描述 + 最近一次探测的就绪状态。 */
  probe(always: boolean): Promise<void>;
  selfCheck(): Promise<void>;
  reportInventory(): void;
  /** 停掉连接相关的定时器并关闭 RPC 通道（`close()` 的前半段）。 */
  close(): void;
}

/** 连接、重连退避、心跳、凭据轮换、编解码与欢迎握手。 */
export function installTransport(ctx: LinkCtx): Transport {
  const options = ctx.options;
  const { outbox } = ctx;
  const OUTBOX_LIMIT = 5_000;
  /** 老 hub 不发 welcome：等这么久没等到就照旧补发，别把输出永远憋在本地。 */
  const WELCOME_FALLBACK_MS = options.welcomeFallbackMs ?? 5_000;
  let handlers: TransportHandlers | null = null;

  const stopMetrics = (): void => {
    if (ctx.metricsTimer) clearInterval(ctx.metricsTimer);
    ctx.metricsTimer = null;
  };
  /** 资源帧不进 outbox：断线期间的旧采样没有意义，连回来再采就是了。 */
  function startMetrics(current: WebSocket): void {
    stopMetrics();
    const probe = options.resources;
    if (!probe) return;
    let busy = false;
    const tick = async (): Promise<void> => {
      if (busy || ctx.socket !== current || current.readyState !== WebSocket.OPEN) return;
      busy = true;
      try {
        const pids = new Map<string, number>();
        for (const [id, session] of ctx.sessions) {
          const pid = session.pid?.();
          if (typeof pid === 'number') pids.set(id, pid);
        }
        const sample = await probe.sample(pids);
        if (ctx.socket === current && current.readyState === WebSocket.OPEN) {
          current.send(JSON.stringify({ type: 'metrics', ...sample }));
        }
      } catch (error) {
        options.onLog?.(`资源采样失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        busy = false;
      }
    };
    void tick();
    ctx.metricsTimer = setInterval(() => void tick(), options.metricsIntervalMs ?? 15_000);
    ctx.metricsTimer.unref?.();
  }

  /** agent 清单 = runtime 的描述 + 最近一次探测的就绪状态。hub 只消费统一的 readiness，不认识具体 harness。 */
  const agentDtos = () => {
    const probed = options.readiness?.latest() ?? new Map();
    return options.runtimes.map((runtime) => {
      const dto = agentToDto(runtime.descriptor);
      const result = probed.get(runtime.descriptor.id);
      const readiness = result?.readiness;
      const provision = options.provisioner?.provisions().get(runtime.descriptor.id);
      // 启动时没装、后来在线装上的：启动时问不到模型，用探测拿到的那份
      const models = dto.models.length === 0 && result && result.models.length > 0 ? { models: [...result.models], defaultModel: result.defaultModel } : {};
      return { ...dto, ...models, ...(readiness ? { readiness } : {}), ...(provision ? { provision } : {}) };
    });
  };
  /** 跑一次探测；`always` 时无论变没变都报（「重新检测」要让界面看到刷新）。 */
  async function probe(always: boolean): Promise<void> {
    if (!options.readiness || ctx.closed) return;
    const before = options.readiness.latest();
    try {
      const after = await options.readiness.probeAll();
      for (const [agentId, result] of after) {
        if (result.readiness.state === 'unavailable') options.onLog?.(`${agentId} 暂不可用：${result.readiness.reason}`);
      }
      if (always || !sameReadiness(before, after)) send({ type: 'agents', agents: agentDtos() });
    } catch (error) {
      options.onLog?.(`探测 harness 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function selfCheck(): Promise<void> {
    if (!options.readiness || ctx.closed) return;
    try {
      const fresh = await options.readiness.selfCheckOnce();
      for (const [agentId, check] of fresh) {
        options.onLog?.(check.ok ? `${agentId} 模型自检通过${check.model ? `（${check.model}）` : ''}` : `${agentId} 模型自检失败：${check.reason ?? ''}`);
      }
      if (fresh.size > 0 && !ctx.closed) send({ type: 'agents', agents: agentDtos() });
    } catch (error) {
      options.onLog?.(`模型自检失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const probeInterval = options.probeIntervalMs ?? 5 * 60_000;
  /** 清单帧不进 outbox：断线期间的旧清单没意义，连回来会再报一次。 */
  function reportInventory(): void {
    if (!options.inventory || ctx.closed || !ctx.accepted || ctx.socket?.readyState !== WebSocket.OPEN) return;
    try {
      ctx.socket.send(JSON.stringify({ type: 'inventory', inventory: options.inventory() }));
    } catch (error) {
      options.onLog?.(`采集套件清单失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const inventoryTimer = options.inventory ? setInterval(reportInventory, options.inventoryIntervalMs ?? 6 * 60 * 60_000) : null;
  inventoryTimer?.unref?.();
  const probeTimer = options.readiness && probeInterval > 0 ? setInterval(() => void probe(false), probeInterval) : null;
  probeTimer?.unref?.();

  /**
   * 这条长连接上的 RPC 通道（端口的实现）。hub→worker 的 fs.*、worker→hub 的 mcp.message 都走它。
   * 不进 outbox：断线时在途调用直接以 closed 结束，比连回来后补发一个早已超时的调用诚实。
   */
  const channel = createRpcChannel({
    idPrefix: 'w',
    timeoutMs: options.toolTimeoutMs ?? 60_000,
    allow: (method) => {
      const reason = denial(ctx, method.capability);
      return reason ? { code: 'forbidden', message: reason } : null;
    },
    send: (frame) => {
      if (!ctx.socket || ctx.socket.readyState !== WebSocket.OPEN || !ctx.accepted) return false;
      ctx.socket.send(JSON.stringify({ type: 'rpc', frame } satisfies WorkerToServer));
      return true;
    }
  });
  serveWorkerFiles(channel, options.files, options.roots ?? [], {
    ...(options.worktreesDir ? { worktreesDir: options.worktreesDir } : {}),
    ...(options.groupsDir ? { groupsDir: options.groupsDir } : {})
  });
  // opt-in 的项目 Git 对象导入：不注入导入器就不注册 handler，也不在 hello 里声明能力。
  if (options.gitBundleImport) serveProjectGitBundleImport(channel, options.gitBundleImport);
  channel.handle(linkEcho, async ({ at }) => ({ at }));

  const send = (frame: WorkerToServer): void => {
    if (ctx.socket && ctx.socket.readyState === WebSocket.OPEN && ctx.accepted) {
      ctx.socket.send(JSON.stringify(frame));
      return;
    }
    if (ctx.closed) return;
    outbox.push(frame);
    if (outbox.length > OUTBOX_LIMIT) {
      outbox.shift();
      ctx.dropped += 1;
    }
  };

  const armWatchdog = (current: WebSocket): void => {
    const timeout = ctx.watchdogMs ?? options.heartbeatTimeoutMs ?? 30_000;
    if (timeout <= 0) return;
    if (ctx.watchdog) clearTimeout(ctx.watchdog);
    ctx.watchdog = setTimeout(() => {
      options.onLog?.(`${Math.round(timeout / 1000)} 秒没收到 server 心跳，断开重连`);
      current.terminate();
    }, timeout);
    ctx.watchdog.unref?.();
  };

  /** 连接被 server 接受：先报丢帧，再按原顺序补发断线期间攒下的帧。 */
  function flush(current: WebSocket): void {
    if (ctx.welcomeTimer) clearTimeout(ctx.welcomeTimer);
    ctx.welcomeTimer = null;
    if (ctx.accepted || ctx.socket !== current || current.readyState !== WebSocket.OPEN) return;
    ctx.accepted = true;
    if (ctx.dropped > 0) options.onLog?.(`断线太久，丢了 ${ctx.dropped} 帧最旧的输出`);
    ctx.dropped = 0;
    ctx.droppedReported = 0;
    for (const frame of outbox.splice(0)) current.send(JSON.stringify(frame));
    options.onAccepted?.();
    const pending = options.pendingUpdateReport?.();
    if (pending) {
      current.send(JSON.stringify({ type: 'update_status', ...pending.report }));
      pending.done();
    }
    // 每次连上都重新探测一次：机器上的登录状态可能在断线期间变了。
    // 第一次探测完后台跑一次模型自检（每个进程只跑一次，不挡任何东西），有结果再报一次清单。
    void probe(true).then(selfCheck);
    reportInventory();
  }

  async function rotateCredential(current: WebSocket, next: string): Promise<void> {
    if (ctx.socket !== current) {
      options.onLog?.('旧连接上要求轮换凭据，忽略');
      return;
    }
    if (!ctx.credential || !options.onCredentialRotate) {
      options.onLog?.('hub 要轮换凭据，但这台 Worker 不支持（没有专属凭据或不知道 worker.env 在哪），继续用旧凭据');
      return;
    }
    let saved = false;
    try {
      saved = await options.onCredentialRotate(next);
    } catch (error) {
      options.onLog?.(`保存新凭据失败：${error instanceof Error ? error.message : String(error)}，继续用旧凭据`);
      return;
    }
    if (!saved) return;
    // 磁盘已经是新凭据了，内存必须跟着走：否则之后的 connect() 还拿旧值，宽限期一过就再也连不上。
    ctx.credential = next;
    if (ctx.socket !== current) {
      options.onLog?.('凭据已轮换；当前连接已经换过，下一次重连会用新凭据');
      return;
    }
    options.onLog?.('凭据已轮换，用新凭据重连');
    current.close(1000, 'credential rotated');
  }

  function connect(): void {
    const current = new WebSocket(options.url);
    ctx.socket = current;

    current.on('open', () => {
      // 连上不立刻清零：连上就被踢的循环会每次都从 0.5 秒重来。稳定满一分钟才算数。
      if (ctx.stableTimer) clearTimeout(ctx.stableTimer);
      ctx.stableTimer = setTimeout(() => {
        if (ctx.socket === current) ctx.attempt = 0;
      }, options.stableMs ?? RECONNECT_POLICY.stableMs);
      ctx.stableTimer.unref?.();
      ctx.droppedReported = ctx.dropped;
      const trial = options.trialUpdate?.() ?? null;
      // hello 必须是第一帧：先于补发的积压事件，server 才知道这些事件是谁的。
      current.send(
        JSON.stringify({
          type: 'hello',
          workerId: options.workerId,
          label: options.label,
          origin: options.origin ?? 'local',
          token: options.token,
          ...(options.localSecret ? { localSecret: options.localSecret } : {}),
          ...(ctx.credential ? { credential: ctx.credential } : {}),
          agents: agentDtos(),
          ...(options.host ? { host: options.host } : {}),
          roots: [...(options.files?.roots ?? options.roots ?? [])],
          sessions: [...ctx.sessions.keys()],
          ...(options.build ? { build: options.build } : {}),
          // durable_delivery 无条件声明：本版 Worker 一定认带 deliveryId 的 prompt。
          // 项目 Git 导入只在显式注入导入器时声明：老 hub 不认识会丢掉这个字符串，不会误发。
          capabilities: [
            ...(options.resources ? [WORKER_CAPABILITY_METRICS] : []),
            ...(options.gitBundleImport ? [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] : []),
            WORKER_CAPABILITY_DURABLE_DELIVERY
          ],
          ...(ctx.droppedReported > 0 ? { dropped: ctx.droppedReported } : {}),
          ...(trial ? { update: { id: trial.id, phase: 'trial' as const, inventory: trial.inventory } } : {})
        } satisfies WorkerToServer)
      );
      options.onLog?.(`已连上 ${options.url}${ctx.sessions.size > 0 ? `，接回 ${ctx.sessions.size} 个会话` : ''}`);
      ctx.accepted = false;
      if (ctx.welcomeTimer) clearTimeout(ctx.welcomeTimer);
      ctx.welcomeTimer = setTimeout(() => flush(current), WELCOME_FALLBACK_MS);
      ctx.welcomeTimer.unref?.();
      armWatchdog(current);
      options.onOpen?.();
    });

    current.on('ping', () => armWatchdog(current));

    current.on('close', (code: number, reason: Buffer) => {
      if (ctx.watchdog) clearTimeout(ctx.watchdog);
      if (ctx.stableTimer) clearTimeout(ctx.stableTimer);
      if (ctx.socket === current) {
        ctx.socket = null;
        ctx.accepted = false;
        stopMetrics();
        if (ctx.welcomeTimer) clearTimeout(ctx.welcomeTimer);
      }
      if (ctx.socket === null) channel.close('与 hub 断开了，调用没有完成');
      if (code === PROTOCOL_MISMATCH_CLOSE) {
        // 协议对不上：重连也没用，把 hub 给的原因原样打出来，告诉人怎么修。
        options.onLog?.(`${reason.toString() || '与 hub 的协议版本不兼容'}。不再重连`);
        ctx.closed = true;
        options.onClose?.();
        return;
      }
      if (code === 4401 || code === 4403) {
        // token 错了、或管理员把这台机器断开了：重连多少次都一样，直接停，别刷屏。
        options.onLog?.(
          code === 4401 ? `hub 拒绝了这台机器（${reason.toString() || 'token 不匹配'}），不再重连` : '被管理员断开，不再重连'
        );
        ctx.closed = true;
        options.onClose?.({ code });
        return;
      }
      if (ctx.closed || options.reconnect === false) {
        options.onLog?.('与 server 断开');
        options.onClose?.();
        return;
      }
      const delay = reconnectDelay(ctx.attempt, Math.random(), {
        baseMs: options.initialBackoffMs ?? RECONNECT_POLICY.baseMs,
        capMs: options.maxBackoffMs ?? RECONNECT_POLICY.capMs
      });
      ctx.attempt += 1;
      options.onLog?.(`与 server 断开，${(delay / 1000).toFixed(1)} 秒后重连（第 ${ctx.attempt} 次）`);
      ctx.reconnectTimer = setTimeout(connect, delay);
    });

    current.on('error', (error: Error) => {
      options.onLog?.(`连接错误：${error.message}`);
    });

    current.on('message', (raw: Buffer) => {
      // 重连之后旧连接还会飘来几帧：它们代表的是 hub 对「上一条连接」的判断，
      // 照着做会把新连接的状态带偏（例如旧连接上的 credential_rotate 会覆盖新凭据）。
      if (ctx.socket !== current) {
        options.onLog?.('旧连接上还收到了指令，忽略');
        return;
      }
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
      const wired = handlers;
      if (!wired) return;
      if (command.kind === 'rpc') channel.receive(command.frame);
      else if (command.kind !== 'welcome' && command.kind !== 'enrolled' && denial(ctx, commandCapability(command.kind))) wired.refuse(command);
      else if (command.kind === 'update') void wired.update(command.commit);
      else if (command.kind === 'update_commit') options.onUpdateCommit?.(command.id);
      else if (command.kind === 'update_abort') options.onUpdateAbort?.(command.id, command.reason);
      else if (command.kind === 'welcome') {
        if (command.heartbeat) {
          ctx.watchdogMs = workerWatchdogMs(command.heartbeat);
          armWatchdog(current);
        }
        flush(current);
        // 老 hub 的 welcome 不带 accepts：不发 metrics，免得它每 15 秒记一条「无法解析的帧」
        if (command.accepts?.includes(WORKER_CAPABILITY_METRICS)) startMetrics(current);
        ctx.nativeBranch = command.accepts?.includes(WORKER_CAPABILITY_NATIVE_BRANCH) ?? false;
        ctx.granted = command.capabilities ?? null;
      }
      else if (command.kind === 'agent_config') options.onAgentConfig?.(command.aliases);
      else if (command.kind === 'probe') void probe(true);
      else if (command.kind === 'runtime_job') void wired.runtimeJob(command);
      else if (command.kind === 'provider_update') ctx.providerRelay.update(command.sessionId, { models: command.models });
      else if (command.kind === 'enrolled') return; // 只在 enroll 握手里出现
      else if (command.kind === 'credential_rotate') void rotateCredential(current, command.credential);
      else if (command.kind === 'terminal_input') wired.terminalInput(command);
      else void wired.handle(command);
    });
  }

  return {
    channel,
    attach(next: TransportHandlers): void {
      handlers = next;
    },
    connect,
    send,
    probe,
    selfCheck,
    reportInventory,
    close(): void {
      if (ctx.reconnectTimer) clearTimeout(ctx.reconnectTimer);
      if (probeTimer) clearInterval(probeTimer);
      if (inventoryTimer) clearInterval(inventoryTimer);
      stopMetrics();
      if (ctx.watchdog) clearTimeout(ctx.watchdog);
      channel.close('worker 正在退出');
    }
  };
}
