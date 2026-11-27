import type { WebSocket } from 'ws';
import type { ServerToWorker, WorkerToServer } from '@agent-hub/contract';
import { canInvoke, capabilityDenied } from '@agent-hub/domain';
import type { WorkerCapability } from '@agent-hub/domain';
import { createProviderRelay, type ProviderRelay } from '../provider-relay.ts';
import type {
  AgentAlias,
  AgentRuntime,
  BuildInfo,
  ResourceProbe,
  RuntimeOption,
  RuntimeSession,
  WorkerInventory
} from '@agent-hub/domain';
import type { WorkerFiles } from '../worker-files.ts';
import type { ProjectGitBundleImporter } from '../project-git-bundle-import.ts';
import type { WorkerAssets } from '../worker-assets.ts';
import type { ProcessInfo } from '../process-scan.ts';
import type { TerminalHost } from '../terminal.ts';
import type { WorkdirTerminalHost } from '../workdir-terminal.ts';
import type { ServiceHost } from '../service-host.ts';
import type { UpdateReport } from '../updater.ts';
import type { RuntimeManager } from '../runtime-jobs.ts';
import type { HarnessRegistry } from '../harness-registry.ts';

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
  /**
   * 轮换凭据（ADR 0030 D3）：hub 下发了新凭据，把它持久化（worker.env）。返回 true 才换用新凭据重连；
   * 没有这个回调 / 写失败 = 继续用旧的（hub 宽限期过了会判轮换失败、保留旧凭据）。
   */
  readonly onCredentialRotate?: (credential: string) => Promise<boolean>;
  readonly runtimes: readonly AgentRuntime[];
  /**
   * hub 下发了新的运行时别名（CAP-1）。worker 自己重建 harness 注册表并就地替换 runtimes：
   * 新建会话用新别名，正在跑的会话不受影响。不给 = 不支持热更新（老 worker 行为）。
   */
  readonly onAgentConfig?: (aliases: readonly AgentAlias[]) => void;
  /**
   * 各 harness 的就绪探测（端口适配器的组合）。连上后、每 `probeIntervalMs`、收到 hub 的 probe 指令时各跑一次，
   * 结果叠在 agent 清单上报给 hub。不给 = 不探测，hub 一律当 ready（和老 worker 一样）。
   */
  readonly readiness?: HarnessRegistry;
  /** 运行时安装（ADR 0010）：每个 agent 的来源随清单上报，hub 的 runtime_job 指令交给它。不给 = 不支持在线安装。 */
  readonly provisioner?: RuntimeManager;
  /** 定时重新探测的间隔。默认 5 分钟；0 = 不定时。 */
  readonly probeIntervalMs?: number;
  readonly onLog?: (message: string) => void;
  /**
   * 断线后自动重连（指数退避，封顶 `maxBackoffMs`）。默认开：
   * 一台远程机器不该因为 hub 重启一次就永久掉队，得有人 ssh 上去重开。
   * 重连后重新 hello，并报上手上还活着的会话，server 据此接回托管。
   * 关掉（`false`）时断线即调 `onClose`——给测试和一次性脚本用。
   */
  readonly reconnect?: boolean;
  /** 等 server welcome 的最长时间，过了就照旧补发（兼容不发 welcome 的老 hub）。默认 5 秒。 */
  readonly welcomeFallbackMs?: number;
  readonly initialBackoffMs?: number;
  /** 连上稳定多久才把重连次数清零（默认 60 秒，ADR 0030 Q2）。 */
  readonly stableMs?: number;
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
  /**
   * 项目 Git 对象导入（docs/design/project-git-access.md 第二个增量）：显式注入才启用。
   * 不注入 = hello 不声明 `project_git_bundle_import`、不注册 `ws.import_project_git_bundle`；
   * hub 在发送前就拒绝，不回退到带凭据的 RPC。
   */
  readonly gitBundleImport?: ProjectGitBundleImporter;
  /** ADR 0027 D10：新建 worktree 的位置（WORKER_WORKTREES_DIR）；省略 = 仓库旁 `.worktrees/`。 */
  readonly worktreesDir?: string;
  /** 组合工作空间（docs/design/multi-repo.md §12.5）：容器与成员只能落在这下面（WORKER_GROUPS_DIR）。省略 = 不支持。 */
  readonly groupsDir?: string;
  readonly plannedProofDir?: string;
  readonly plannedBaseAllowedOrigins?: readonly string[];
  /** hub 下发的技能与指令落在这里（专属目录）。不给就回「这台不支持」，会话也不带资产。 */
  readonly assets?: WorkerAssets;
  /**
   * 会话终端（docs/design/terminal.md）。没装 node-pty 时不给：
   * `terminal.*` 一律回 unsupported，界面不显示终端页签。
   */
  readonly terminal?: TerminalHost;
  readonly workdirTerminal?: WorkdirTerminalHost;
  /**
   * 会话服务（docs/design/session-service.md）：本地长驻进程的启停与日志。
   * 不给 = `ws.service_*` 一律回 unsupported，hub 侧显示「这台机器的 Worker 太旧」。
   */
  readonly service?: ServiceHost;
  /**
   * 只读的进程 / 端口清单（proc.list）：worker 侧扫 /proc，只收 cwd 在 roots 里的。
   * 不给 = 一律回 unsupported，hub 侧当作这台 Worker 不支持。
   */
  readonly processes?: () => readonly ProcessInfo[];
  /**
   * 终端原始输出旁路（docs/design/preview.md §5）：组合根拿它做预览端口发现。
   * 不给 = 什么都不做（老调用方 / 测试）。
   */
  readonly onTerminalOutput?: (sessionId: string, text: string) => void;
  /** 连接（最终）关闭了：`reconnect: false` 时每次断线、或 `close()` 之后。 */
  readonly onClose?: (why?: { readonly code: number }) => void;
  /** 每次连上（含重连）。 */
  readonly onOpen?: () => void;
  /** server 接受了这条连接（收到 welcome，或老 hub 下等满兜底时间）。 */
  readonly onAccepted?: () => void;
  /** 每次连上时问一次：有没有要补报的更新结果（比如启动守卫刚回退过）。返回的会作为 update_status 发出；发出后调 done。 */
  readonly pendingUpdateReport?: () => { report: UpdateReport; done: () => void } | null;
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
  /**
   * releases 布局下正在试运行的新版本（ADR 0030 D2）：每次 hello 前问一次，给了就在 hello 里带 update:{id, phase:'trial'}。
   * hub 观察 60 秒稳定后发 update_commit（→ onUpdateCommit），没通过发 update_abort（→ onUpdateAbort）。
   */
  readonly trialUpdate?: () => { readonly id: string; readonly inventory: boolean } | null;
  readonly onUpdateCommit?: (id: string) => void;
  readonly onUpdateAbort?: (id: string, reason: string) => void;
  /** 机器资源采样（ADR 0014）。给了就在 hello 里报 'metrics' 能力；hub 的 welcome 接受了才定时上报。 */
  readonly resources?: ResourceProbe;
  /** 资源上报间隔，默认 15 秒。 */
  readonly metricsIntervalMs?: number;
  /**
   * 回合结束后保活（CAP keep-alive）：进程闲置这么久（最后一次事件 / 最后一次 prompt 起算）就收掉，
   * 并报 `status:'ended'`。默认 15 分钟（900_000）；<= 0 = 不按空闲回收。
   */
  readonly sessionIdleMs?: number;
  /**
   * 每台 worker 同时保活的进程上限（默认 8）。新会话起来后超过上限，先收最久没活动的那个，
   * 同样报 `status:'ended'`。
   */
  readonly keepAliveMax?: number;
  /**
   * 每台机器同时 pinned（常驻）的会话上限，默认 16。超过时新的 pinned 启动
   * 直接回 `status:'ended'` + 一条 diagnostic，不进入保活。
   */
  readonly pinMax?: number;
  /**
   * 回合结束后仍有后台子代理在跑时，多久 `session/load` 重放一次把新输出拉回来
   * （opencode 的 ACP 适配器在那之后不再推 session/update）。默认 5000。
   */
  readonly resyncIntervalMs?: number;
  /** 连续多少轮没补到新事件就把间隔翻倍（5s → 10s → 20s → 40s，封顶 60s）；子代理没结束就一直拉。 */
  readonly resyncMaxIntervalMs?: number;
  /** 套件清单采集（ADR 0021 §7）：连上时、运行时任务结束后、每 `inventoryIntervalMs` 报一次。不给 = 不报。 */
  readonly inventory?: () => WorkerInventory;
  /** 默认 6 小时。 */
  readonly inventoryIntervalMs?: number;
}

/** 默认会话指令：长连接上所有「对某条会话做事」的帧。其余（welcome / rpc / 更新 / 安装 …）各有专门通路。 */
export type SessionCommand = Exclude<
  ServerToWorker,
  { kind: 'update' | 'update_commit' | 'update_abort' | 'rpc' | 'enrolled' | 'welcome' | 'probe' | 'runtime_job' | 'credential_rotate' | 'terminal_input' | 'workdir_terminal_input_v1' | 'workdir_terminal_detach_v1' | 'agent_config' }
>;

/** transport 把解码后的非会话帧交给门面装配好的处理器，避免模块间运行时循环依赖。 */
export interface TransportHandlers {
  handle(command: SessionCommand): Promise<void>;
  refuse(command: ServerToWorker): void;
  update(commit: string): Promise<void>;
  runtimeJob(command: Extract<ServerToWorker, { kind: 'runtime_job' }>): Promise<void>;
  terminalInput(command: Extract<ServerToWorker, { kind: 'terminal_input' }>): void;
  workdirTerminalFrame(command: Extract<ServerToWorker, { kind: 'workdir_terminal_input_v1' | 'workdir_terminal_detach_v1' }>): void;
}

/**
 * 一条 worker 链路的全部可变状态。各模块共享同一个实例：`sessions`/`workspaces` 的删改、
 * `starting` 的串行化、`seenDeliveries` 的去重都发生在这一份状态上，不存在副本。
 */
export interface LinkCtx {
  readonly options: WorkerLinkOptions;
  /** 模型提供商的本机中继（ADR 0013）：只听 loopback，按会话发令牌。 */
  readonly providerRelay: ProviderRelay;
  /** 经 hub 中转时 hub 给的是路径：按自己连的 hub 地址补全（ws→http，去掉 /worker）。 */
  readonly hubHttp: string;

  socket: WebSocket | null;
  closed: boolean;
  /** 当前凭据：轮换成功后换成新的（只在内存和 worker.env 里，不进日志）。 */
  credential: string | undefined;
  /** hub 的 welcome 说它认原生分叉的帧（ADR 0028）。 */
  nativeBranch: boolean;
  /** hub 在 welcome 里给的能力上限（ADR 0030 D3「双端强制」）；没给（老 hub / 本机 / 共享令牌）= 不限。 */
  granted: readonly string[] | null;
  attempt: number;
  reconnectTimer: NodeJS.Timeout | null;
  watchdog: NodeJS.Timeout | null;
  /** hub 在 welcome 里给的心跳参数算出的看门狗（ADR 0030 D1）；没给就用 heartbeatTimeoutMs。 */
  watchdogMs: number | null;
  /** 连上满这么久才把重连次数清零（Q2）。 */
  stableTimer: NodeJS.Timeout | null;
  /** 上一次断线丢掉的帧数：下一次 hello 报给 hub。 */
  droppedReported: number;
  /**
   * 断线期间产生的帧先攒着，连回来按顺序补发。agent 不会因为网络抖一下就停：
   * 不攒的话那段输出就永远丢了（server 那边 journal 有幂等保护，补发不会写两遍）。
   * 有上限：断太久就丢最旧的，并在补发时说一声。
   */
  readonly outbox: WorkerToServer[];
  dropped: number;
  /** server 认了这条连接（收到 welcome）才算能发：被 4409 顶回去的连接上发的帧会整段丢掉。 */
  accepted: boolean;
  welcomeTimer: NodeJS.Timeout | null;
  updating: boolean;
  metricsTimer: NodeJS.Timeout | null;

  readonly sessions: Map<string, RuntimeSession>;
  /** 会话的工作目录：解析产出物的相对路径用。 */
  readonly workspaces: Map<string, string>;
  /** 每条活进程的 agentId：同 id 再次 start 时判断能不能直接复用。 */
  readonly sessionAgents: Map<string, string>;
  /** 活进程拿到的 provider 中转身份（slug|baseUrl|token）：换了就不能复用旧进程。 */
  readonly sessionProviders: Map<string, string>;
  /** 最后一次活动（收到事件 / 收到 prompt）的时间，空闲回收与上限回收都按它排序。 */
  readonly lastActivity: Map<string, number>;
  readonly idleTimers: Map<string, NodeJS.Timeout>;
  /** 正在跑一轮的会话：这期间不算空闲，prompt 收尾后再起算。 */
  readonly prompting: Set<string>;
  /** 常驻会话：不按空闲回收、不占保活上限（任务里长期用的那条）。 */
  readonly pinnedSessions: Set<string>;
  /**
   * 每条会话一条串行队列。server 会连着发 start_session + prompt，
   * 而 start 是异步的（要拉起 agent 进程）——不排队的话 prompt 会先到，
   * 撞上「未知会话」。这是真发生过的失败，不是理论问题。
   */
  readonly starting: Map<string, Promise<void>>;
  /** 最近送达过的 deliveryId（ADR 0031 去重，最多记 1000 个）。 */
  readonly seenDeliveries: Set<string>;
}

export function createLinkCtx(options: WorkerLinkOptions): LinkCtx {
  const hubHttp = (() => {
    try {
      const url = new URL(options.url);
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/worker\/?$/, '').replace(/\/+$/, '')}`;
    } catch {
      return '';
    }
  })();
  return {
    options,
    providerRelay: createProviderRelay(),
    hubHttp,
    socket: null,
    closed: false,
    credential: options.credential,
    nativeBranch: false,
    granted: null,
    attempt: 0,
    reconnectTimer: null,
    watchdog: null,
    watchdogMs: null,
    stableTimer: null,
    droppedReported: 0,
    outbox: [],
    dropped: 0,
    accepted: false,
    welcomeTimer: null,
    updating: false,
    metricsTimer: null,
    sessions: new Map<string, RuntimeSession>(),
    workspaces: new Map<string, string>(),
    sessionAgents: new Map<string, string>(),
    sessionProviders: new Map<string, string>(),
    lastActivity: new Map<string, number>(),
    idleTimers: new Map<string, NodeJS.Timeout>(),
    prompting: new Set<string>(),
    pinnedSessions: new Set<string>(),
    starting: new Map<string, Promise<void>>(),
    seenDeliveries: new Set<string>()
  };
}

/** 越权的指令：返回拒绝原因；能执行就返回 null。 */
export const denial = (ctx: LinkCtx, needed: string | undefined): string | null =>
  canInvoke(ctx.granted, needed as WorkerCapability | undefined) ? null : capabilityDenied(needed as WorkerCapability);

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 经 hub 中转时 hub 给的是路径：按自己连的 hub 地址补全。 */
export const upstreamUrl = (ctx: LinkCtx, baseUrl: string): string =>
  baseUrl.startsWith('/') ? ctx.hubHttp + baseUrl : baseUrl;
