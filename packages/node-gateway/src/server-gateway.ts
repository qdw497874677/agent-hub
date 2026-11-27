import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { ProcessInfo, WorkspaceBrowser } from '@agent-hub/domain';
import { createRemoteBrowsers } from './remote-workspace-browser.ts';
import type { ProjectGitBundleImportInput, ProjectGitBundleImportOutcome } from './project-git-bundle-import.ts';
import type { AgentDto, RpcChannel, RpcOutcome, RpcPort, ServerToWorker, SessionAssetRequestWire, WorkerToServer } from '@agent-hub/contract';
import {
  PROTOCOL_MISMATCH_CLOSE,
  PROTOCOL_VERSION,
  WORKER_CAPABILITY_BRANCH_ATTEMPT,
  WORKER_CAPABILITY_DURABLE_DELIVERY,
  WORKER_CAPABILITY_METRICS,
  WORKER_CAPABILITY_NATIVE_BRANCH,
  WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT,
  WORKER_CAPABILITY_SESSION_START_READY,
  WORKER_CAPABILITY_SESSION_START_NATIVE_REF,
  WORKER_CAPABILITY_OPTION_RECEIPT,
  WORKER_CAPABILITY_WORKDIR_TERMINAL_V1,
  WORKER_CAPABILITY_WORKSPACE_MUTATION_SAFETY_V1,
  workdirTerminalInventory, workdirTerminalCreate, workdirTerminalAttach, workdirTerminalResize, workdirTerminalClose,
  serverToWorkerSchema,
  assetsSync,
  providerTest,
  createRpcChannel,
  fsListDirectories,
  fsListFiles,
  fsMakeDirectory,
  fsReadFile,
  procList,
  serviceList,
  serviceLogs,
  serviceStart,
  serviceStop,
  terminalClose,
  terminalList,
  terminalOpen,
  terminalResize,
  workerToServerSchema,
  wsAddWorktree,
  wsRunSetup,
  wsClone,
  wsInspect,
  wsCheckRepo,
  wsGroupInit,
  wsGroupRemove,
  wsNewWorktree,
  wsRemove,
  wsSaveWip,
  wsPreview,
  wsCommit,
  wsPush,
  wsPublishRef,
  wsPrepareDelegationWorktree,
  wsInspectPlannedWorktree,
  wsCreatePlannedWorktree,
  wsVerifyPlannedWorktree,
  wsResolvePlannedBase,
  wsPreparePlannedBase,
  wsImportCommit,
  wsImportProjectGitBundle,
  wsGh,
  wsStatus,
  linkEcho
} from '@agent-hub/contract';
import { DEFAULT_HEARTBEAT, allowsFor, decideTrial, initialLink, isUnknownOutcomeEnded, linkIsDead, reduceLink } from '@agent-hub/domain';
import type { HeartbeatPolicy, LinkEvent, LinkHealth } from '@agent-hub/domain';
import type {
  AgentAlias,
  AssetDelivery,
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
  WorkerUpdate,
  WorkspaceGit,
  RuntimeJob,
  ProviderProtocol,
  ProviderModel,
  DebounceState,
  ResourceSample,
  WorkerResources,
  WorkerInventory,
  ComponentPin
} from '@agent-hub/domain';
import { canInvoke, capabilityDenied, commandCapability, forbidden } from '@agent-hub/domain';
import type { WorkerCapability } from '@agent-hub/domain';
import type { ServiceGateway, ServiceRuntime, ServiceState } from '@agent-hub/domain';
import { assessPressure, detectDrift, conflict, debouncePressure, initialDebounce, invalid, unavailable } from '@agent-hub/domain';

/** hub 留给每台机器的安装日志上限（字符，取末尾）。 */
const RUNTIME_LOG_LIMIT = 16_000;

export interface WorkerConnectionObservation {
  readonly connectionId: string;
  readonly workerId: string;
  readonly origin: 'local' | 'remote';
  readonly enrollment: { readonly enrolledBy: string; readonly createdAt: number } | null;
  readonly kind: 'connected' | 'disconnected';
  readonly at: number;
}

/** A terminal install report from the same eligible connection that received the job. */
export interface WorkerRuntimeInstallObservation {
  readonly connectionId: string;
  readonly workerId: string;
  readonly origin: 'local' | 'remote';
  readonly enrollment: { readonly enrolledBy: string; readonly createdAt: number } | null;
  readonly action: 'install';
  readonly state: 'succeeded' | 'failed' | 'refused';
  readonly at: number;
}

/** Current Hub-side placement/generation at receipt; unkeyed frames do not prove their runtime of origin. */
export interface SessionStartMetadata {
  readonly attemptId: string;
  readonly connectionId: string;
  readonly isCurrent: () => boolean;
  /** Only present on an accepted keyed ready report, never on unkeyed callbacks. */
  readonly ready?: { readonly agentSessionRef?: string; readonly options?: readonly RuntimeOption[] };
}

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
   * 不给就只看共享令牌（裸传输：单测/嵌入式直用）。拒绝时 reason 原样放进关闭码 4401 的原因里。
   */
  authenticate?(hello: {
    readonly workerId: string;
    readonly credential?: string | undefined;
    readonly sharedTokenOk: boolean;
    /** 来源地址 / 报的版本：认过就记到凭据上（ADR 0030 D3）。 */
    readonly address?: string | null;
    readonly userAgent?: string | null;
  }): Promise<{ readonly ok: true; readonly capabilities?: readonly string[]; readonly via?: 'credential' | 'shared'; readonly enrollment?: { readonly workerId: string; readonly enrolledBy: string; readonly createdAt: number } } | { readonly ok: false; readonly reason: string }>;
  /** Best-effort observation of locally proven or credential-authenticated connections. */
  onConnectionObservation?(observation: WorkerConnectionObservation): void;
  /** Best-effort, sanitized terminal install observations; independent of runtime job UX. */
  onObservedRuntimeInstall?(observation: WorkerRuntimeInstallObservation): void;
  /** 经反向代理进来时，来源地址取 X-Forwarded-For 最后一跳（HUB_TRUST_PROXY=1）。默认只信 socket 地址。 */
  readonly trustProxy?: boolean;
  onHello(worker: WorkerStatus, agents: AgentDto[], sessions: readonly string[]): void;
  /** Worker 重新探测后报来新的 agent 清单（就绪状态变了，或是「重新检测」的结果）。 */
  onAgents?(worker: WorkerStatus, agents: AgentDto[]): void;
  // 以下回调都带上「是哪台 Worker 说的」：会话归不归它，由领域按库里的落点判断。
  onEvent(workerId: string, sessionId: SessionId, event: SessionEvent, sessionStart?: SessionStartMetadata): void;
  onAgentSession(workerId: string, sessionId: SessionId, agentSessionRef: string, sessionStart?: SessionStartMetadata): void;
  onOptions(workerId: string, sessionId: SessionId, options: readonly RuntimeOption[], sessionStart?: SessionStartMetadata): void;
  onOptionReceipt?(workerId: string, sessionId: SessionId, requestId: string, optionId: string, outcome: 'applied' | 'rejected' | 'unknown', options: readonly RuntimeOption[] | undefined, isCurrent: () => boolean): void;
  /** ADR 0028：这一轮的原生标识 / 带 branch 的启动结果。 */
  onTurnRef?(workerId: string, sessionId: SessionId, turnRef: string, deliveryId?: string): void;
  onBranchResult?(workerId: string, sessionId: SessionId, outcome: 'native' | 'failed', reason?: string): void;
  onBranchAttemptResult?(workerId: string, sessionId: SessionId, attemptId: string, outcome: 'native' | 'plain' | 'both_failed', agentSessionRef?: string): void;
  onSessionStartChanged?(workerId: string, sessionId: SessionId, sessionStart?: SessionStartMetadata): void;
  /** Check isCurrent immediately before each asynchronous side effect; it expires on any new ownership attempt. */
  onSessionStartEnded?(workerId: string, sessionId: SessionId, startAttemptId: string, isCurrent: () => boolean): void;
  onPromptStartRefused?(workerId: string, sessionId: SessionId, deliveryId: string): void;
  onStatus(workerId: string, sessionId: SessionId, status: RuntimeStatus, reason?: string, sessionStart?: SessionStartMetadata): void;
  onWorkerGone(workerId: string, reason: string): void;
  /**
   * 交互式终端（docs/design/terminal.md）：
   * - `knownTerminals`：hub 上还挂着的 terminalId，worker 重连对账时据此清理自己不认识的残留 PTY。
   * - 两个回调按 terminalId 把 worker 的输出 / 退出送回桥接层；桥接层自己找是哪个浏览器。
   */
  knownTerminals?(workerId: string): ReadonlySet<string>;
  onTerminalData?(workerId: string, terminalId: string, data: string): void;
  onTerminalExit?(workerId: string, terminalId: string, code: number, signal?: number): void;
  onWorkdirTerminalData?(workerId: string, epoch: string, terminalId: string, data: string): void;
  onWorkdirTerminalExit?(workerId: string, epoch: string, terminalId: string, code: number): void;
  onWorkdirTerminalConnected?(workerId: string): void;
  /**
   * 会话服务（docs/design/session-service.md）：
   * - `onServiceState` / `onServiceLog`：worker 主动推的状态与输出，hub 据此落库。
   * - `onServiceMissing`：重连对账时，hub 记着 running / starting 但 worker 上已经没有这条服务
   *   （机器重启后没拉起来）。是否真的标 failed 由领域决定。
   */
  onServiceState?(workerId: string, event: { serviceId: string; state: ServiceState; pid?: number | null; detail?: string | null; port?: number | null }): void;
  onServiceLog?(workerId: string, serviceId: string, chunk: string): void;
  onServiceMissing?(workerId: string, serviceId: string): void;
  /** hub 上还没结束（running / starting）的服务 id：对账时逐个问 worker 还在不在。 */
  knownServices?(workerId: string): Promise<ReadonlySet<string>> | ReadonlySet<string>;
  /** Worker 报来更新进度（给日志用；状态本身网关会记着，出现在 workers() 里）。 */
  onUpdateStatus?(workerId: string, update: WorkerUpdate): void;
  /** 运行时任务结束（成功 / 失败 / 被拒）。 */
  onRuntimeJob?(workerId: string, job: RuntimeJob): void;
  /** 这台 Worker 期望装着的组件（hub 的 component_pins，ADR 0021 P2 才写入）；不给 = 没有期望。 */
  expectedComponents?(workerId: string): readonly ComponentPin[];
  /**
   * 这台 Worker 存着的自定义运行时别名（CAP-1）。连接建立后推一帧让它热应用；
   * 不给 / 返回 null = 没配过，不发帧（老 hub 行为）。
   */
  agentConfig?(workerId: string): Promise<readonly AgentAlias[] | null> | readonly AgentAlias[] | null;
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
  /** Frozen at startup: block affected workspace mutations on unverified or incompatible Workers. */
  readonly workspaceMutationSafetyRequired?: boolean;
  /** 心跳间隔。连续一个间隔没收到 pong 就判定离线并断开。 */
  readonly heartbeatMs?: number;
  /** 试运行检查间隔（ADR 0030 D2）；默认 2 秒。 */
  readonly trialTickMs?: number;
  /** 试运行稳定窗口 / 总时限；测试里调小。 */
  readonly trialStableMs?: number;
  readonly trialTimeoutMs?: number;
  /** 连续漏几次 pong 判离线（ADR 0030 Q1，默认 2）。 */
  readonly missLimit?: number;
  /** 应用层回声间隔（默认 30 秒）；0 = 不做。 */
  readonly echoMs?: number;
  /** 回声超时（默认 10 秒）。 */
  readonly echoTimeoutMs?: number;
  /** 目录浏览这类请求-回复的超时。 */
  readonly requestTimeoutMs?: number;
  /** 项目 Git bundle 导入的上限（默认 5 分钟）：要经 WS 传 ≤ 8 MiB 再落盘 / 建 ref。 */
  readonly projectGitBundleTimeoutMs?: number;
  /** 连上之后多久内必须 hello；不说话的连接不该一直占着。 */
  readonly helloTimeoutMs?: number;
  readonly sessionStartTimeoutMs?: number;
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

/** hub 侧闸门：hub 发出的方法要凭据允许；对端（Worker）发来的请求只走 control 类，照样问一句。 */
function gate(entry: { readonly capabilities: readonly string[] | null }) {
  return (method: { readonly name: string; readonly capability?: string }) =>
    canInvoke(entry.capabilities, method.capability as WorkerCapability | undefined)
      ? null
      : { code: 'forbidden', message: capabilityDenied(method.capability as WorkerCapability) };
}

/** 来源地址：默认 socket 对端；信任代理时取 X-Forwarded-For 最后一跳（代理自己加的那段，伪造不了）。 */
export function clientAddressOf(request: IncomingMessage | undefined, trustProxy: boolean): string | undefined {
  const socketAddress = request?.socket.remoteAddress?.replace(/^::ffff:/, '');
  if (!trustProxy) return socketAddress;
  const header = request?.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  const last = raw?.split(',').map((part) => part.trim()).filter(Boolean).at(-1);
  return last?.replace(/^::ffff:/, '') ?? socketAddress;
}

interface Registered {
  readonly workerId: string;
  /** Internal identity for this accepted socket, independent of observation. */
  readonly startConnectionId: string;
  readonly closeObservation: () => void;
  observationIdentity: Omit<WorkerRuntimeInstallObservation, 'action' | 'state' | 'at'> | null;
  observedInstallJobId: string | null;
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
  /** 连接健康（ADR 0030 D1）。 */
  link: LinkHealth;
  /** 被踢 / 吊销：断开后记为 rejected 而不是 disconnected。 */
  kicked: boolean;
  reason?: string;
  build: BuildInfo | null;
  update: WorkerUpdate | null;
  /** 最近一次运行时安装 / 卸载任务（ADR 0010）。 */
  runtimeJob: RuntimeJob | null;
  /** 最近一次上报的套件清单（ADR 0021）。 */
  inventory: WorkerInventory | null;
  /** 最近一次更新的目标提交：它重启后用新版本 hello 上来时，据此判定「更新完成」。 */
  updateTarget: string | null;
  /** 正在试运行的新版本（ADR 0030 D2）：hub 观察它，决定 update_commit / update_abort。 */
  trial: { id: string; startedAt: number; commit: string | null; inventoryApplied: boolean } | null;
  /** 这条连接上的 RPC 通道；离线时为 null。 */
  channel: RpcChannel | null;
  /** 凭据允许的能力（ADR 0030 D3）；null = 不限（本机 / 共享令牌 / 老凭据前的行为）。 */
  capabilities: readonly string[] | null;
  /** 这条连接的 Worker 声明了 durable_delivery 没有（#269）；每次 hello 重建。 */
  durableDelivery: boolean;
  sessionStartReady: boolean;
  sessionStartNativeRef: boolean;
  optionReceipt: boolean;
  branchAttempt: boolean;
  branchAttemptAgents: Set<string>;
  helloAgents: AgentDto[];
  /** Attempts sent on this connection only; never restored on reconnect. */
  branchAttempts: Map<string, { attemptId: string; sourceRef: string }>;
  /** 这条连接的 Worker 显式 opt-in 了项目 Git bundle 导入没有（hello 能力）；每次 hello 重建。 */
  projectGitBundleImport: boolean;
  workdirTerminal: boolean;
  workspaceMutationSafety: boolean;
  /** 这条连接做过终端对账没有（重连 / inventory 只做一次）。 */
  terminalReconciled: boolean;
  /** 这条连接做过服务对账没有。 */
  serviceReconciled: boolean;
  /** 这次连接的来历：给界面显示「上次连上 · 来自 · 版本」。 */
  connection: { at: number; address: string | null; version: string | null };
}

/** 终端 RPC 的结果：失败保留 worker 的 code（如 `unsupported`），桥接层据此隐藏页签。 */
export type TerminalOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface TerminalOpened {
  readonly cols: number;
  readonly rows: number;
  readonly reused: boolean;
  /** 复用终端时的最近输出（base64）：回调给新连上的浏览器，接上滚屏。 */
  readonly scrollback?: string;
}

export interface WorkdirTerminalGateway {
  inventory(): Promise<TerminalOutcome<{ epoch: string; terminals: readonly { terminalId: string; workspaceId: string; state: 'running' | 'closing' }[] }>>;
  create(input: { terminalId: string; workspaceId: string; cwd: string; epoch: string }): Promise<TerminalOutcome<{ state: 'running' | 'closing' | 'ended' }>>;
  attach(input: { terminalId: string; epoch: string; cols: number; rows: number }): Promise<TerminalOutcome<TerminalOpened>>;
  resize(input: { terminalId: string; epoch: string; cols: number; rows: number }): Promise<TerminalOutcome<{ ok: true }>>;
  close(input: { terminalId: string; epoch: string }): Promise<TerminalOutcome<{ exited: boolean }>>;
  detach(input: { terminalId: string; epoch: string }): void;
  input(input: { terminalId: string; epoch: string; data: string }): boolean;
}

export interface ServerGateway {
  workdirTerminals(workerId: string): WorkdirTerminalGateway;
  /** Last-known positive negotiation, retained while the registry entry survives disconnect. Not an authorization check. */
  workdirTerminalSupported(workerId: string): boolean;
  /** Current uniquely authenticated connection explicitly supports the complete mutation safety protocol. */
  workspaceMutationSafe(workerId: string): boolean;
  readonly gateway: NodeGateway;
  supportsBranchAttempt(workerId: string, agentId: string): boolean;
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
  /** 经已认证的连接下发轮换后的新凭据（ADR 0030 D3）。只给凭专属凭据连上的；不在线返回 false。 */
  rotateCredential(workerId: string, credential: string): boolean;
  /** 让在线的 Worker 立刻重新探测各 harness 是否可用。不在线返回 false；老 Worker 收到会忽略。 */
  requestProbe(workerId: string): boolean;
  /**
   * 下发这台 Worker 的自定义运行时别名（CAP-1）。不在线返回 false，不抛错。
   * 老 Worker 收到不认这个帧，只会记一行日志；空数组 = 让它回到 ACP_AGENTS。
   */
  sendAgentConfig(workerId: string, aliases: readonly AgentAlias[]): boolean;
  /** 下发运行时安装 / 卸载任务，记为 running。不在线返回 false；老 Worker 收到只记日志（界面上它不报 provision，根本不会发）。 */
  requestRuntimeJob(workerId: string, job: RuntimeJob): boolean;
  /** 资产中心的投递端口：把清单推下去（assets.sync），Worker 回头经 assets.fetch 取内容。 */
  readonly assets: AssetDelivery;
  /** 让这台 Worker 测一个模型提供商（GET {baseUrl}/models）；经 hub 中转时 baseUrl 是 hub 上的临时中转路径。 */
  /** 这台机器最近 1 小时的资源采样（只在内存里，hub 重启就没了；ADR 0014）。 */
  metrics(workerId: string): readonly ResourceSample[];
  /** 「资源满了就拒绝新会话」开关（持久化在 hub 设置里，启动时和改动时同步进来）。 */
  setRefuseWhenFull(workerIds: Iterable<string>): void;
  testProvider(workerId: string, input: { protocol: ProviderProtocol; baseUrl: string; apiKey: string }): Promise<Result<{ ok: boolean; status: number; message: string; models: string[] }, DomainError>>;
  /**
   * 会话进行中热更新 provider 的模型定义（只有 extra 这类请求参数即时生效，不重启 agent）。
   * 尽力而为：离线 / 凭据不允许 / 老 Worker 不认都返回 false，不抛错。
   */
  updateProvider(sessionId: string, workerId: string, models: readonly ProviderModel[]): boolean;
  /**
   * 交互式终端（docs/design/terminal.md §6）。都像 updateProvider 一样尽力而为：
   * worker 离线 / 凭据没有 `sessions` / 老 worker 不认，一律 `{ok:false}`，不抛错。
   */
  openTerminal(
    workerId: string,
    input: {
      readonly terminalId: string;
      readonly sessionId: string;
      readonly cols: number;
      readonly rows: number;
      readonly cwd?: string;
    }
  ): Promise<TerminalOutcome<TerminalOpened>>;
  resizeTerminal(workerId: string, terminalId: string, cols: number, rows: number): Promise<TerminalOutcome<{ readonly ok: true }>>;
  closeTerminal(workerId: string, terminalId: string): Promise<TerminalOutcome<{ readonly ok: true }>>;
  listTerminals(workerId: string): Promise<TerminalOutcome<readonly { readonly terminalId: string; readonly sessionId: string }[]>>;
  /** 浏览器按键 / 粘贴：直接走帧，不等 RPC 回复。离线返回 false。 */
  sendTerminalInput(workerId: string, terminalId: string, data: string): boolean;
  /** worker 重连后对账：关掉 hub 不认识、worker 上还活着的 PTY。 */
  reconcileTerminals(workerId: string): Promise<void>;
  /** 那台 Worker 上的会话服务（ws.service_*）。 */
  services(workerId: string): ServiceGateway;
  /** 那台 Worker 上 cwd 落在允许目录里的进程 / 监听端口（只读，`proc.list`）。 */
  processes(workerId: string): Promise<Result<readonly ProcessInfo[], DomainError>>;
  /** worker 重连后对账：hub 记着在跑、worker 上却没有的服务（机器重启后没拉起来）。 */
  reconcileServices(workerId: string): Promise<void>;
  /** 远端 Worker 上的工作空间文件浏览（ADR 0025）。 */
  browser(workerId: string): WorkspaceBrowser;
  /**
   * 组合工作空间（docs/design/multi-repo.md §12.1 / §12.5）：容器目录 + 成员 worktree。
   * 还没进 domain 的 NodeGateway 端口（那一步在别的 lane 做），先挂在网关自己身上给用例用。
   */
  groups(workerId: string): WorkspaceGroupOps;
  /**
   * 项目 Git bundle 导入（docs/design/project-git-access.md 第二个增量）：**独立的**网关方法，
   * 不挂到通用 `WorkspaceGit` 上，也不回退到任何带凭据的本地 / RPC 路径。
   *
   * - Worker 离线 → `unavailable`；凭据没有 `git` → `forbidden`；
   * - 这条连接没有声明 opt-in 能力（老 / 未启用隔离的 Worker）→ 发送前就 `not_implemented`，一个字节都不发；
   * - 聚合超时 → `unavailable`，消息说明「结果未知、不要自动重放」（导入可能已经在 Worker 上完成）。
   */
  importProjectGitBundle(workerId: string, input: ProjectGitBundleImportInput): Promise<Result<ProjectGitBundleImportOutcome, DomainError>>;
  close(): void;
}

/**
 * 组合工作空间的三个 RPC（`ws.group_init` / `ws.group_remove` / `ws.new_worktree`）。
 * 和 `WorkspaceGit` 一样：离线 / 超时 / 对端报错都折成 `Result`，不抛错。
 *
 * `init` 只传段名（slug / name）：容器根由那台 Worker 的 `WORKER_GROUPS_DIR` 算，
 * 网关这一侧不拼路径——运维改过配置后 hub 猜出来的路径必然错。
 */
export interface WorkspaceGroupOps {
  init(input: {
    readonly slug: string;
    readonly name: string;
    readonly id: string;
  }): Promise<Result<{ readonly root: string }, DomainError>>;
  remove(input: { readonly root: string; readonly id: string }): Promise<Result<{ readonly removed: boolean }, DomainError>>;
  newWorktree(input: {
    readonly repoPath: string;
    readonly path: string;
    readonly branch: string;
    readonly base?: string | null;
    /** 私有 HTTPS 仓库的令牌（只交给 Worker 的 git）。 */
    readonly auth?: { readonly header: string };
  }): Promise<Result<{ readonly path: string; readonly branch: string }, DomainError>>;
}

/**
 * server 侧的 worker 通道。指令下行、事件上行，一条 WebSocket 两条流。
 *
 * 多机路由：start_session 带着落点（workerId）下来，网关记下「这条会话在哪台」，
 * 之后的 prompt / interrupt / set_option / dispose 都按这张表走——
 * 而不是像单机时那样「发给第一台在线的」。
 */
export function createServerGateway(hooks: GatewayHooks, options: GatewayOptions = {}): ServerGateway {
  const workspaceMutationSafetyRequired = options.workspaceMutationSafetyRequired === true;
  const registry = new Map<string, Registered>();
  const placement = new Map<string, string>();
  // Readiness is bound to the socket and generation, never inferred from hello/adopt.
  const starts = new Map<string, { workerId: string; socket: WebSocket; attemptId: string; startedAt: number; state: 'starting' | 'ready' | 'failed'; reason?: 'runtime' | 'configuration'; deliveries: Map<string, number>; seen: Uint8Array }>();
  const optionRequests = new Map<string, { requestId: string; optionId: string; socket: WebSocket; workerId: string; start: unknown; consumed: boolean }>();
  const endedStarts = new Map<string, { workerId: string; socket: WebSocket; attemptId: string }>();
  // Cleanly ended generations may still have attachment preparation in flight.
  // This proof is independent of the end-cleanup guard and never survives its socket.
  const retiredProofs = new Map<WebSocket, Map<string, { sessionId: string; attemptId: string; deliveryId: string }>>();
  // Once full, unseen IDs are never admitted as proof for this generation.
  const MAX_REFUSAL_PROOFS_PER_START = 1024;
  const MAX_RETIRED_REFUSAL_PROOFS_PER_SOCKET = 1024;
  // Fixed-size, fail-closed replay filter. False positives only suppress a
  // refusal proof; an old ID can never become fresh after its turn completes.
  function markSeen(seen: Uint8Array, id: string): boolean {
    const hash = createHash('sha256').update(id).digest();
    let present = true;
    for (let i = 0; i < 4; i++) {
      const bit = hash.readUInt32LE(i * 4) % (seen.length * 8);
      const index = bit >>> 3;
      const mask = 1 << (bit & 7);
      if (!(seen[index]! & mask)) present = false;
      seen[index] = seen[index]! | mask;
    }
    return present;
  }
  const managedSessions = new Set<string>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT.intervalMs;
  const policy: HeartbeatPolicy = {
    intervalMs: heartbeatMs,
    missLimit: options.missLimit ?? DEFAULT_HEARTBEAT.missLimit,
    echoMs: options.echoMs ?? DEFAULT_HEARTBEAT.echoMs,
    echoTimeoutMs: options.echoTimeoutMs ?? DEFAULT_HEARTBEAT.echoTimeoutMs
  };
  const feed = (entry: Registered, event: LinkEvent): void => {
    entry.link = reduceLink(entry.link, event, now(), policy);
  };
  /** 问一句 link.echo：回来了量往返；老 Worker 不认也算活着；超时 / 断线记为卡住。 */
  async function echo(entry: Registered): Promise<void> {
    const channel = entry.channel;
    const socket = entry.socket;
    if (!channel || !socket) return;
    const started = now();
    const outcome = await channel.request(linkEcho, { at: started }, { timeoutMs: policy.echoTimeoutMs });
    if (entry.socket !== socket) return; // 期间换了连接：这次结果不算
    if (outcome.ok) feed(entry, { type: 'echo', rttMs: Math.max(0, now() - started) });
    else if (outcome.error.code === 'unknown_method') feed(entry, { type: 'echo', rttMs: null });
    else feed(entry, { type: 'echo_failed' });
  }
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const projectGitBundleTimeoutMs = options.projectGitBundleTimeoutMs ?? 5 * 60_000;

  const online = (workerId: string): Registered | null => {
    const entry = registry.get(workerId);
    return entry?.socket && entry.socket.readyState === WebSocket.OPEN ? entry : null;
  };
  function sessionStartConnection(workerId: string): string | null {
    const entry = online(workerId);
    return entry && entry.sessionStartReady && entry.sessionStartNativeRef && entry.durableDelivery && canInvoke(entry.capabilities, 'sessions')
      ? entry.startConnectionId : null;
  }
  function sessionStartMetadata(sessionId: string, workerId: string, entry: Registered, socket: WebSocket): SessionStartMetadata | undefined {
    const start = starts.get(sessionId);
    const isCurrent = () => !!start && starts.get(sessionId) === start && start.socket === socket && start.workerId === workerId
      && registry.get(workerId) === entry && entry.socket === socket && socket.readyState === WebSocket.OPEN && placement.get(sessionId) === workerId;
    if (!start || !isCurrent()) return undefined;
    return { attemptId: start.attemptId, connectionId: entry.startConnectionId, isCurrent };
  }
  function sessionStartReadiness(sessionId: SessionId, workerId?: string | null) {
    const start = starts.get(sessionId);
    const target = workerId ?? start?.workerId ?? placement.get(sessionId);
    if (!target) return { state: 'untracked' as const };
    const entry = online(target);
    if (!entry) return { state: 'offline' as const };
    if (!entry.sessionStartReady || !entry.durableDelivery) return { state: 'upgrade_required' as const };
    if (!start || start.workerId !== target || start.socket !== entry.socket || placement.get(sessionId) !== target) return { state: 'untracked' as const };
    if (start.state === 'ready') return { state: 'ready' as const, startAttemptId: start.attemptId };
    if (start.state === 'failed') return { state: 'failed' as const, reason: start.reason ?? 'runtime' as const };
    if (now() - start.startedAt >= (options.sessionStartTimeoutMs ?? 90_000)) return { state: 'failed' as const, reason: 'timed_out' as const };
    return { state: 'starting' as const };
  }
  function invalidateSocket(socket: WebSocket): void {
    for (const [id, start] of starts) if (start.socket === socket) starts.delete(id);
    for (const [id, end] of endedStarts) if (end.socket === socket) endedStarts.delete(id);
    retiredProofs.delete(socket);
  }
  function retireStart(sessionId: string, start: { socket: WebSocket; attemptId: string; deliveries: Map<string, number> }): void {
    let proofs = retiredProofs.get(start.socket);
    for (const [deliveryId, count] of start.deliveries) {
      if (count !== 1) continue;
      if (!proofs) retiredProofs.set(start.socket, proofs = new Map());
      if (proofs.size >= MAX_RETIRED_REFUSAL_PROOFS_PER_SOCKET) break;
      proofs.set(JSON.stringify([sessionId, start.attemptId, deliveryId]), { sessionId, attemptId: start.attemptId, deliveryId });
    }
  }
  const supportsBranchAttempt = (workerId: string, agentId: string): boolean => {
    const entry = online(workerId);
    const helloAgent = entry?.helloAgents.find((agent) => agent.id === agentId);
    const currentAgent = entry?.agents.find((agent) => agent.id === agentId);
    return !!entry && entry.branchAttempt && entry.branchAttemptAgents.has(agentId)
      && !!helloAgent && !!currentAgent && allowsFor(helloAgent.capabilities, 'branch_at_turn')
      && allowsFor(currentAgent.capabilities, 'branch_at_turn') && canInvoke(entry.capabilities, 'sessions');
  };

  // 资源（ADR 0014）：每台一个环形缓冲 + 防抖状态，只在内存里
  const METRICS_RETENTION_MS = 60 * 60_000;
  const METRICS_MAX_POINTS = 300;
  const usage = new Map<string, { samples: ResourceSample[]; debounce: DebounceState }>();
  let refusePolicy = new Set<string>();

  function recordMetrics(workerId: string, sample: ResourceSample): void {
    const state = usage.get(workerId) ?? { samples: [], debounce: initialDebounce };
    // 时间用 hub 的钟：Worker 的钟可能不准，而 CPU「持续 1 分钟」要按到达时间算
    const stamped: ResourceSample = { ...sample, at: now() };
    const pressure = assessPressure(stamped, state.samples);
    state.debounce = debouncePressure(state.debounce, pressure);
    state.samples.push(stamped);
    const cutoff = stamped.at - METRICS_RETENTION_MS;
    while (state.samples.length > 0 && (state.samples[0]!.at < cutoff || state.samples.length > METRICS_MAX_POINTS)) state.samples.shift();
    usage.set(workerId, state);
  }

  function resourcesOf(entry: Registered): WorkerResources | undefined {
    if (!entry.socket) return undefined; // 离线机器的旧数值没有意义
    const state = usage.get(entry.workerId);
    const latest = state?.samples.at(-1);
    if (!state || !latest) return undefined;
    const refuseWhenFull = refusePolicy.has(entry.workerId);
    const pressure = state.debounce.current;
    return { sample: latest, pressure, refuseWhenFull, refusing: refuseWhenFull && pressure.level === 'full' };
  }

  const labelOf = (workerId: string): string => registry.get(workerId)?.label ?? workerId;

  function sendTo(workerId: string, command: ServerToWorker): Result<void, DomainError> {
    const entry = online(workerId);
    if (!entry?.socket) return { ok: false, error: command.kind === 'prompt' && command.deliveryId
      ? { ...unavailable(`Worker「${labelOf(workerId)}」不在线`), deliveryDeferred: true }
      : unavailable(`Worker「${labelOf(workerId)}」不在线`) };
    const needed = commandCapability(command.kind);
    if (!canInvoke(entry.capabilities, needed)) {
      const error = forbidden(capabilityDenied(needed as WorkerCapability));
      return { ok: false, error: command.kind === 'prompt' && command.deliveryId ? { ...error, deliveryDeferred: true } : error };
    }
    if (command.kind === 'start_session' && command.branchAttemptId !== undefined) {
      if (!command.branch || command.resume !== null || !command.branchAttemptId || command.branchAttemptId.length > 128)
        return { ok: false, error: invalid('branchAttemptId requires a valid branch and attempt id') };
      if (!supportsBranchAttempt(workerId, command.agentId)) return { ok: false, error: conflict('Worker does not support branch_attempt; command not sent') };
    }
    if (command.kind === 'prompt' && command.deliveryId) {
      const readiness = sessionStartReadiness(command.sessionId as SessionId, workerId);
      if (readiness.state !== 'ready' || readiness.startAttemptId !== command.startAttemptId) {
        return { ok: false, error: { ...conflict('Session start readiness changed before prompt dispatch; command not sent'), deliveryDeferred: true } };
      }
    }
    // Reserve before send: even an exception may have handed off bytes. If the
    // ID is ever retried, neither receipt can prove which dispatch was refused.
    let newProof: { deliveries: Map<string, number>; deliveryId: string } | undefined;
    if (command.kind === 'prompt' && command.deliveryId && command.startAttemptId) {
      // A receipt for an earlier generation cannot identify which dispatch a
      // delivery-only callback refers to once this ID is sent again.
      for (const [proofSocket, retired] of retiredProofs) {
        for (const [key, proof] of retired) if (proof.sessionId === command.sessionId && proof.deliveryId === command.deliveryId) retired.delete(key);
        if (!retired.size) retiredProofs.delete(proofSocket);
      }
      const start = starts.get(command.sessionId);
      if (start && start.socket === entry.socket && start.attemptId === command.startAttemptId) {
        const seen = markSeen(start.seen, command.deliveryId);
        if (start.deliveries.has(command.deliveryId)) start.deliveries.set(command.deliveryId, 2);
        else if (start.deliveries.size < MAX_REFUSAL_PROOFS_PER_START) {
          if (!seen) {
            start.deliveries.set(command.deliveryId, 2);
            newProof = { deliveries: start.deliveries, deliveryId: command.deliveryId };
          }
        }
      }
    }
    // A send exception is ambiguous: never mark it as provably unsent.
    try {
      entry.socket.send(JSON.stringify(command));
    } catch {
      return { ok: false, error: unavailable('Worker send failed; delivery outcome unknown, do not automatically replay') };
    }
    if (newProof) newProof.deliveries.set(newProof.deliveryId, 1);
    if (command.kind === 'start_session') {
      entry.branchAttempts.delete(command.sessionId);
      if (command.branchAttemptId !== undefined && command.branch) entry.branchAttempts.set(command.sessionId, { attemptId: command.branchAttemptId, sourceRef: command.branch.fromAgentSessionRef });
    } else if (command.kind === 'dispose') entry.branchAttempts.delete(command.sessionId);
    return { ok: true, value: undefined };
  }

  /**
   * 会话进行中把 provider 的模型定义热更新给 worker（只有 extra 这类请求参数即时生效，不重启 agent）。
   * 尽力而为：worker 离线 / 凭据不允许 / 老 worker 不认这个帧都只返回 false，不抛错。
   */
  function updateProvider(sessionId: string, workerId: string, models: readonly ProviderModel[]): boolean {
    const entry = online(workerId);
    if (!entry?.socket || !canInvoke(entry.capabilities, 'sessions')) return false;
    const frame: ServerToWorker = { kind: 'provider_update', sessionId, models: models.map((model) => ({ ...model })) };
    entry.socket.send(JSON.stringify(frame));
    return true;
  }

  /* ── 交互式终端（docs/design/terminal.md §6） ── */

  const terminalUnavailable = (workerId: string): { ok: false; code: string; message: string } => ({
    ok: false,
    code: 'unavailable',
    message: `Worker「${labelOf(workerId)}」不在线`
  });

  /** 终端 RPC 的前置闸门：离线、凭据没有 `sessions` 都在这里挡掉。 */
  function terminalBlocked(workerId: string): { ok: false; code: string; message: string } | null {
    const entry = online(workerId);
    if (!entry?.channel) return terminalUnavailable(workerId);
    if (!canInvoke(entry.capabilities, 'sessions')) return { ok: false, code: 'forbidden', message: capabilityDenied('sessions') };
    return null;
  }

  async function openTerminal(
    workerId: string,
    input: {
      readonly terminalId: string;
      readonly sessionId: string;
      readonly cols: number;
      readonly rows: number;
      readonly cwd?: string;
    }
  ): Promise<TerminalOutcome<TerminalOpened>> {
    const blocked = terminalBlocked(workerId);
    if (blocked) return blocked;
    const entry = online(workerId)!;
    // Check the actual dispatch connection, not a bridge's earlier snapshot.
    if (entry.workdirTerminal) return { ok: false, code: 'unsupported', message: '此 Worker 使用独立工作目录终端，不支持新建会话终端' };
    const outcome = await entry.channel!.request(terminalOpen, {
      terminalId: input.terminalId,
      sessionId: input.sessionId,
      cols: input.cols,
      rows: input.rows,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd })
    });
    return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, code: outcome.error.code, message: outcome.error.message };
  }

  async function resizeTerminal(workerId: string, terminalId: string, cols: number, rows: number): Promise<TerminalOutcome<{ ok: true }>> {
    const blocked = terminalBlocked(workerId);
    if (blocked) return blocked;
    const outcome = await online(workerId)!.channel!.request(terminalResize, { terminalId, cols, rows });
    return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, code: outcome.error.code, message: outcome.error.message };
  }

  async function closeTerminal(workerId: string, terminalId: string): Promise<TerminalOutcome<{ ok: true }>> {
    const blocked = terminalBlocked(workerId);
    if (blocked) return blocked;
    const outcome = await online(workerId)!.channel!.request(terminalClose, { terminalId });
    return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, code: outcome.error.code, message: outcome.error.message };
  }

  async function listTerminals(workerId: string): Promise<TerminalOutcome<readonly { terminalId: string; sessionId: string }[]>> {
    const blocked = terminalBlocked(workerId);
    if (blocked) return blocked;
    const outcome = await online(workerId)!.channel!.request(terminalList, {});
    return outcome.ok ? { ok: true, value: outcome.value.terminals } : { ok: false, code: outcome.error.code, message: outcome.error.message };
  }

  /** 浏览器输入直接走帧（不等回复）：worker 按 terminalId 找回 PTY。 */
  function sendTerminalInput(workerId: string, terminalId: string, data: string): boolean {
    const entry = online(workerId);
    if (!entry?.socket || !canInvoke(entry.capabilities, 'sessions')) return false;
    entry.socket.send(JSON.stringify({ kind: 'terminal_input', terminalId, data } satisfies ServerToWorker));
    return true;
  }

  function workdirTerminals(workerId: string): WorkdirTerminalGateway {
    async function call<T>(invoke: (channel: RpcChannel) => Promise<RpcOutcome<T>>): Promise<TerminalOutcome<T>> {
      const entry = online(workerId);
      if (!entry?.channel || !entry.socket) return terminalUnavailable(workerId);
      if (!entry.observationIdentity || !entry.workdirTerminal) return { ok: false, code: 'unsupported', message: 'Worker does not support workdir terminals' };
      if (!canInvoke(entry.capabilities, 'sessions')) return { ok: false, code: 'forbidden', message: capabilityDenied('sessions') };
      const socket = entry.socket, channel = entry.channel;
      const result = await invoke(channel);
      if (registry.get(workerId) !== entry || entry.socket !== socket || entry.channel !== channel || !entry.observationIdentity || socket.readyState !== WebSocket.OPEN)
        return { ok: false, code: 'stale', message: 'Worker connection changed' };
      return result.ok ? { ok: true, value: result.value } : { ok: false, code: result.error.code, message: result.error.message };
    }
    function send(frame: ServerToWorker): boolean {
      const entry = online(workerId);
      if (!entry?.socket || !entry.observationIdentity || !entry.workdirTerminal || !canInvoke(entry.capabilities, 'sessions') || !serverToWorkerSchema.safeParse(frame).success) return false;
      try { entry.socket.send(JSON.stringify(frame)); return true; } catch { return false; }
    }
    return {
      inventory: () => call((channel) => channel.request(workdirTerminalInventory, {})),
      create: (input) => call((channel) => channel.request(workdirTerminalCreate, input)),
      attach: (input) => call((channel) => channel.request(workdirTerminalAttach, input)),
      resize: (input) => call((channel) => channel.request(workdirTerminalResize, input)),
      close: (input) => call((channel) => channel.request(workdirTerminalClose, input)),
      detach: (input) => { send({ kind: 'workdir_terminal_detach_v1', ...input }); },
      input: (input) => send({ kind: 'workdir_terminal_input_v1', ...input })
    };
  }

  /**
   * worker 重连后对账：hub 重启会丢掉内存里的终端表，worker 上的 PTY 却还活着。
   * 把 hub 不认识的 terminalId 全关掉；对账失败只记日志，不影响 worker 使用。
   */
  async function reconcileTerminals(workerId: string): Promise<void> {
    const entry = online(workerId);
    if (!entry?.channel || !canInvoke(entry.capabilities, 'sessions') || entry.terminalReconciled) return;
    entry.terminalReconciled = true;
    const listed = await listTerminals(workerId);
    if (!listed.ok) {
      hooks.onLog?.(`终端对账失败（${workerId}）：${listed.message}`);
      return;
    }
    const known = hooks.knownTerminals?.(workerId) ?? new Set<string>();
    for (const terminal of listed.value) {
      if (known.has(terminal.terminalId)) continue;
      const closed = await closeTerminal(workerId, terminal.terminalId);
      if (!closed.ok) hooks.onLog?.(`清理残留终端失败（${terminal.terminalId}）：${closed.message}`);
    }
  }


  /* ── 会话服务（docs/design/session-service.md §4） ── */

  /** 服务 RPC 的前置闸门：离线、凭据没有 `service` 都在这里挡掉。 */
  function serviceGate(workerId: string): Result<RpcChannel, DomainError> {
    const entry = online(workerId);
    if (!entry?.channel) return { ok: false, error: unavailable(`Worker「${labelOf(workerId)}」不在线`) };
    if (!canInvoke(entry.capabilities, 'service')) return { ok: false, error: forbidden(capabilityDenied('service')) };
    return { ok: true, value: entry.channel };
  }

  /**
   * `ws.service.*`：只搬参数、折错误，不做任何状态推断——状态由 worker 的 `service_state` 推上来。
   * stop 可能等 3 秒宽限再 SIGKILL，超时给足。
   */
  function services(workerId: string): ServiceGateway {
    return {
      async start(input) {
        const gate = serviceGate(workerId);
        if (!gate.ok) return gate;
        const outcome = await gate.value.request(
          serviceStart,
          { serviceId: input.serviceId, root: input.root, command: input.command, port: input.port, env: input.env, restart: input.restart },
          { timeoutMs: 20_000 }
        );
        if (!outcome.ok) return toDomain(outcome, '启动本地服务', workerId);
        return { ok: true, value: { pid: outcome.value.pid, port: outcome.value.port ?? null } };
      },
      async stop(serviceId, signal) {
        const gate = serviceGate(workerId);
        if (!gate.ok) return gate;
        const outcome = await gate.value.request(serviceStop, { serviceId, ...(signal === undefined ? {} : { signal }) }, { timeoutMs: 15_000 });
        return toDomain(outcome, '停止本地服务', workerId);
      },
      async list() {
        const gate = serviceGate(workerId);
        if (!gate.ok) return gate;
        const outcome = await gate.value.request(serviceList, {}, { timeoutMs: 15_000 });
        if (!outcome.ok) return toDomain(outcome, '查看本地服务', workerId);
        const list: ServiceRuntime[] = outcome.value.services.map((item) => ({
          serviceId: item.serviceId as ServiceRuntime['serviceId'],
          pid: item.pid,
          state: item.state,
          port: item.port ?? null
        }));
        return { ok: true, value: list };
      },
      async logs(serviceId, maxBytes) {
        const gate = serviceGate(workerId);
        if (!gate.ok) return gate;
        const outcome = await gate.value.request(serviceLogs, { serviceId, ...(maxBytes === undefined ? {} : { maxBytes }) }, { timeoutMs: 15_000 });
        return toDomain(outcome, '读取本地服务日志', workerId);
      }
    };
  }

  /**
   * `proc.list`：只读进程 / 端口清单，不做任何状态推断。
   * 和 services 用同一道闸门（在线 + `service` 能力）；返回结构就是 domain 的 ProcessInfo。
   */
  async function processes(workerId: string): Promise<Result<readonly ProcessInfo[], DomainError>> {
    const gate = serviceGate(workerId);
    if (!gate.ok) return gate;
    const outcome = await gate.value.request(procList, {}, { timeoutMs: 15_000 });
    if (!outcome.ok) return toDomain(outcome, '查看进程清单', workerId);
    return { ok: true, value: outcome.value.processes };
  }

  /**
   * worker 重连后对账：hub 记着在跑、worker 上却没有的服务，按「机器重启后没拉起来」处理。
   * 只报缺的，不凭 list 改状态——worker 会在状态真的变了的时候推 `service_state`。
   */
  async function reconcileServices(workerId: string): Promise<void> {
    const entry = online(workerId);
    if (!entry?.channel || !canInvoke(entry.capabilities, 'service') || entry.serviceReconciled) return;
    entry.serviceReconciled = true;
    const listed = await services(workerId).list();
    if (!listed.ok) {
      hooks.onLog?.(`服务对账失败（${workerId}）：${listed.error.message}`);
      return;
    }
    const alive = new Set(listed.value.map((service) => service.serviceId));
    const known = (await hooks.knownServices?.(workerId)) ?? new Set<string>();
    for (const serviceId of known) {
      if (!alive.has(serviceId as ServiceRuntime['serviceId'])) hooks.onServiceMissing?.(workerId, serviceId);
    }
  }

  function dispatchTo(command: WorkerCommand): Result<void, DomainError> {
    if (command.kind === 'start_session') {
      const entry = online(command.workerId);
      const explicitAttempt = command.startAttemptId;
      if (command.expectedStartConnectionId !== undefined && explicitAttempt === undefined)
        return { ok: false, error: invalid('expectedStartConnectionId requires startAttemptId; command not sent') };
      if (explicitAttempt !== undefined) {
        if (typeof explicitAttempt !== 'string' || explicitAttempt.length === 0 || explicitAttempt.length > 128)
          return { ok: false, error: invalid('Invalid startAttemptId; command not sent') };
        if (!entry?.socket) return { ok: false, error: unavailable('Worker offline; command not sent') };
        if (!entry.sessionStartReady || !entry.durableDelivery)
          return { ok: false, error: conflict('Worker does not support session start readiness and durable delivery; command not sent') };
        if (!canInvoke(entry.capabilities, 'sessions'))
          return { ok: false, error: forbidden(`${capabilityDenied('sessions')}; command not sent`) };
        if (command.expectedStartConnectionId !== undefined) {
          if (!entry.sessionStartNativeRef)
            return { ok: false, error: conflict('Worker does not support session start native ref proof; command not sent') };
          if (command.expectedStartConnectionId !== entry.startConnectionId)
            return { ok: false, error: conflict('Worker connection changed; command not sent') };
        }
        if (command.branchAttemptId !== undefined) {
          if (!command.branch || command.resume !== null || !command.branchAttemptId || command.branchAttemptId.length > 128)
            return { ok: false, error: invalid('branchAttemptId requires a valid branch and attempt id; command not sent') };
          if (!supportsBranchAttempt(command.workerId, command.agentId))
            return { ok: false, error: conflict('Worker does not support branch_attempt; command not sent') };
        }
        const current = starts.get(command.sessionId);
        const ended = endedStarts.get(command.sessionId);
        const retired = [...retiredProofs.values()].some((proofs) =>
          [...proofs.values()].some((proof) => proof.sessionId === command.sessionId && proof.attemptId === explicitAttempt));
        if (current?.attemptId === explicitAttempt || ended?.attemptId === explicitAttempt || retired)
          return { ok: false, error: conflict('Session start attempt already tracked; command not sent again') };
      }
      optionRequests.delete(command.sessionId);
      endedStarts.delete(command.sessionId);
      const old = starts.get(command.sessionId);
      if (old && online(old.workerId)?.socket === old.socket) retireStart(command.sessionId, old);
      starts.delete(command.sessionId);
      placement.delete(command.sessionId);
      const wire = toWire(command);
      if (wire.kind !== 'start_session') throw new Error('invalid start command');
      const attemptId = entry?.sessionStartReady && entry.durableDelivery ? explicitAttempt ?? randomUUID() : undefined;
      if (attemptId && entry?.socket) {
        managedSessions.add(command.sessionId);
        starts.set(command.sessionId, { workerId: command.workerId, socket: entry.socket, attemptId, startedAt: now(), state: 'starting', deliveries: new Map(), seen: new Uint8Array(32_768) });
      }
      const sent = sendTo(command.workerId, { ...wire, ...(attemptId ? { startAttemptId: attemptId } : {}) });
      if (sent.ok) placement.set(command.sessionId, command.workerId);
      // An explicit send exception is ambiguous: retain the generation in memory
      // to prevent an in-process replay. Durable cross-restart fencing is the caller's job.
      else if (explicitAttempt === undefined) starts.delete(command.sessionId);
      return sent;
    }
    if (command.kind === 'dispose') endedStarts.delete(command.sessionId);
    const workerId = placement.get(command.sessionId);
    if (workerId === undefined) {
      if (command.kind === 'prompt' && command.deliveryId) return { ok: false, error: { ...unavailable('Session placement changed before prompt dispatch; command not sent'), deliveryDeferred: true } };
      return { ok: false, error: unavailable('这条会话此刻没有托管在任何 Worker 上') };
    }
    if (command.kind === 'dispose') {
      optionRequests.delete(command.sessionId);
      const old = starts.get(command.sessionId);
      if (old && online(old.workerId)?.socket === old.socket) retireStart(command.sessionId, old);
      starts.delete(command.sessionId);
    }
    if (command.kind === 'set_option') {
      optionRequests.delete(command.sessionId);
      const entry = online(workerId);
      const wire = toWire(command);
      if (wire.kind !== 'set_option') throw new Error('invalid option command');
      if (command.requestId && entry?.socket && entry.optionReceipt) {
        const request = { requestId: command.requestId, optionId: command.optionId, socket: entry.socket, workerId, start: starts.get(command.sessionId), consumed: false };
        optionRequests.set(command.sessionId, request);
        const timer = setTimeout(() => { if (optionRequests.get(command.sessionId) === request) optionRequests.delete(command.sessionId); }, 30_000);
        timer.unref();
        return sendTo(workerId, wire);
      }
      const { requestId: _requestId, ...legacy } = wire;
      return sendTo(workerId, legacy);
    }
    return sendTo(workerId, toWire(command));
  }

  function markOffline(entry: Registered, socket: WebSocket, reason: string): void {
    // 同一个 workerId 重连时旧连接晚一步关闭：别让它把新连接标成离线。
    if (entry.socket !== socket) return;
    invalidateSocket(socket);
    entry.socket = null;
    entry.terminalReconciled = false;
    entry.serviceReconciled = false;
    entry.reason = reason;
    feed(entry, { type: 'closed', rejected: entry.kicked });
    remoteBrowsers.workerGone(entry.workerId);
    for (const [sessionId, workerId] of placement) {
      if (workerId === entry.workerId) placement.delete(sessionId);
    }
    entry.channel?.close(`Worker「${entry.label}」断开了`);
    entry.channel = null;
    hooks.onWorkerGone(entry.workerId, reason);
  }

  wss.on('connection', (socket: WebSocket, request?: IncomingMessage) => {
    const address = request?.socket.remoteAddress;
    const clientAddress = clientAddressOf(request, hooks.trustProxy === true) ?? null;
    let entry: Registered | null = null;
    let accepted = false;
    // The first hello owns this socket, even while authentication is pending.
    let helloStarted = false;
    let closeObservation = (): void => {};
    let closeReason = '连接断开';
    const helloTimer = setTimeout(() => {
      if (!entry) socket.close(4408, '没有及时 hello');
    }, helloTimeoutMs);
    helloTimer.unref();

    socket.on('pong', () => {
      if (entry && entry.socket === socket) {
        entry.alive = true;
        feed(entry, { type: 'pong' });
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
        // Ready snapshots may contain provider data; never log their validation details.
        if (typeof json === 'object' && json !== null && 'type' in json && json.type === 'session_start_result') hooks.onLog?.('worker 发来无法解析的 session_start_result 帧');
        else hooks.onLog?.(`worker 发来无法解析的帧：${parsed.error.message}`);
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
        // Repeated hellos are harmlessly ignored: they must never re-register this socket.
        if (helloStarted) return;
        helloStarted = true;
        // 本机子进程的口令：hub 每次启动换一个，只有它自己知道（不落盘、不外传），用来证明 origin: 'local' 不是自封的。
        const secret = hooks.localSecret ?? null;
        const provenLocal = secret !== null && sameSecret(frame.localSecret, secret);
        // SEC：配了 HUB_TOKEN 就只认它；没配时不再放行无凭据的 worker——只认 hub 自己拉起的本机子进程。
        // 没有 authenticate 钩子的是裸传输（单测/嵌入式直用），那里没有凭据模型，维持旧的「无 token 即放行」。
        const sharedTokenOk = hooks.token !== null
          ? sameSecret(frame.token, hooks.token)
          : hooks.authenticate !== undefined
            ? provenLocal
            : true;
        const verdict = hooks.authenticate
          ? await hooks.authenticate({
              workerId: frame.workerId,
              credential: frame.credential,
              sharedTokenOk,
              address: clientAddress,
              userAgent: frame.build?.commit ?? null
            })
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
            // WebSocket 的关闭原因最多 123 字节（UTF-8），这段中文很容易超；超了 socket.close 会抛，连接反而不关。
            `协议版本不兼容：worker v${frame.build.protocol}，hub v${PROTOCOL_VERSION}，请运行 scripts/update-worker.sh（v4 起资产不再默认全给）`
          );
          return;
        }
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
          invalidateSocket(stale);
          previous.closeObservation();
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
          startConnectionId: randomUUID(),
          closeObservation: () => closeObservation(),
          observationIdentity: null,
          observedInstallJobId: null,
          label: frame.label,
          origin: frame.origin === 'local' && provenLocal ? 'local' : 'remote',
          socket,
          address,
          agents: frame.agents,
          host: frame.host ?? null,
          roots: frame.roots,
          lastSeenAt: now(),
          alive: true,
          link: reduceLink(previous?.link ?? initialLink(now()), { type: 'connected' }, now(), policy),
          kicked: false,
          build,
          update,
          runtimeJob: previous?.runtimeJob ?? null,
          inventory: previous?.inventory ?? null,
          updateTarget: target !== null && build?.commit === target ? null : target,
          trial: frame.update
            ? {
                id: frame.update.id,
                startedAt: previous?.trial?.id === frame.update.id ? previous.trial.startedAt : now(),
                commit: build?.commit ?? null,
                inventoryApplied: !frame.update.inventory
              }
            : null,
          channel: null,
          capabilities: verdict.capabilities ?? null,
          durableDelivery: frame.capabilities?.includes(WORKER_CAPABILITY_DURABLE_DELIVERY) === true,
          sessionStartReady: frame.capabilities?.includes(WORKER_CAPABILITY_SESSION_START_READY) === true,
          sessionStartNativeRef: frame.capabilities?.includes(WORKER_CAPABILITY_SESSION_START_NATIVE_REF) === true,
          optionReceipt: frame.capabilities?.includes(WORKER_CAPABILITY_OPTION_RECEIPT) === true,
          branchAttempt: frame.capabilities?.includes(WORKER_CAPABILITY_BRANCH_ATTEMPT) === true,
          branchAttemptAgents: new Set(frame.branchAttemptAgents ?? []),
          helloAgents: frame.agents,
          branchAttempts: new Map(),
          projectGitBundleImport: frame.capabilities?.includes(WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT) === true,
          workdirTerminal: frame.capabilities?.includes(WORKER_CAPABILITY_WORKDIR_TERMINAL_V1) === true,
          workspaceMutationSafety: frame.capabilities?.includes(WORKER_CAPABILITY_WORKSPACE_MUTATION_SAFETY_V1) === true,
          terminalReconciled: false,
          serviceReconciled: false,
          connection: { at: now(), address: clientAddress, version: build?.commit ?? null }
        };
        previous?.channel?.close('被同一台机器的新连接顶替');
        const current = socket;
        if (entry.trial) {
          entry.update = {
            state: 'trial',
            message: `试运行中：${entry.trial.commit?.slice(0, 7) ?? '新版本'}（稳定 60 秒且没有重连就提交）`,
            logTail: entry.update?.logTail ?? '',
            at: now(),
            trialRemainingMs: trialStableMs,
            trialDeadlineAt: entry.trial.startedAt + trialTimeoutMs
          };
          hooks.onUpdateStatus?.(entry.workerId, entry.update);
        }
        entry.channel = createRpcChannel({
          idPrefix: 'h',
          timeoutMs: requestTimeoutMs,
          allow: gate(entry),
          send: (rpc) => {
            if (current.readyState !== WebSocket.OPEN) return false;
            current.send(JSON.stringify({ kind: 'rpc', frame: rpc } satisfies ServerToWorker));
            return true;
          }
        });
        remoteBrowsers.serve(frame.workerId, entry.channel);
        hooks.serve?.(frame.workerId, entry.channel);
        registry.set(frame.workerId, entry);
        socket.send(
          JSON.stringify({
            kind: 'welcome',
            accepts: [WORKER_CAPABILITY_METRICS, WORKER_CAPABILITY_NATIVE_BRANCH, WORKER_CAPABILITY_SESSION_START_READY],
            heartbeat: { intervalMs: policy.intervalMs, missLimit: policy.missLimit, echoMs: policy.echoMs },
            ...(entry.capabilities ? { capabilities: [...entry.capabilities] } : {})
          } satisfies ServerToWorker)
        );
        if (!accepted) {
          accepted = true;
          const binding = 'enrollment' in verdict && verdict.via === 'credential' && verdict.enrollment?.workerId === frame.workerId
            ? { enrolledBy: verdict.enrollment.enrolledBy, createdAt: verdict.enrollment.createdAt }
            : null;
          const origin = entry.origin;
          if (origin === 'local' || binding !== null) {
            const observation = { connectionId: randomUUID(), workerId: frame.workerId, origin, enrollment: origin === 'local' ? null : binding };
            entry.observationIdentity = observation;
            const emit = (kind: WorkerConnectionObservation['kind']): void => {
              try { hooks.onConnectionObservation?.({ ...observation, enrollment: observation.enrollment ? { ...observation.enrollment } : null, kind, at: now() }); } catch { /* Observers cannot affect the connection. */ }
            };
            let closed = false;
            closeObservation = () => {
              if (closed) return;
              closed = true;
              emit('disconnected');
            };
            emit('connected');
          }
        }
        if (frame.dropped) hooks.onLog?.(`Worker「${frame.label}」上次断线期间丢了 ${frame.dropped} 帧输出`);
        // 自定义运行时别名（CAP-1）：这台机器存过就推一帧，worker 自己热应用（新建会话生效）。
        // 老 hub 没有这个钩子 = 不发；老 worker 不认 = 记一行日志，连接照旧。
        // 存过就推，**空的也推**：清空别名时如果 worker 离线，下次连上来要能被拉回 ACP_AGENTS，
        // 否则它还在用 agents.json 里的旧别名。null = 从没配过，不发。
        const storedAliases = await hooks.agentConfig?.(frame.workerId);
        if (storedAliases !== null && storedAliases !== undefined) sendAgentConfig(frame.workerId, storedAliases);
        if (policy.echoMs > 0) void echo(entry);
        hooks.onHello(describe(entry), frame.agents, frame.sessions);
        if (registry.get(entry.workerId) === entry && entry.socket === socket && socket.readyState === WebSocket.OPEN && entry.observationIdentity && entry.workdirTerminal && canInvoke(entry.capabilities, 'sessions')) hooks.onWorkdirTerminalConnected?.(entry.workerId);
        void reconcileTerminals(entry.workerId);
        void reconcileServices(entry.workerId);
        return;
      }

      if (!entry || entry.socket !== socket || registry.get(entry.workerId) !== entry || socket.readyState !== WebSocket.OPEN) return; // 当前连接以外的帧不算
      entry.lastSeenAt = now();

      if (frame.type === 'rpc') {
        entry.channel?.receive(frame.frame);
        return;
      }
      if (frame.type === 'agents') {
        entry.agents = frame.agents;
        hooks.onAgents?.(describe(entry), frame.agents);
        return;
      }
      if (frame.type === 'runtime_job_status') {
        const job = entry.runtimeJob;
        // 只认当前那个任务的进度：旧任务迟到的帧、别人编的 jobId 一律丢掉
        if (!job || job.jobId !== frame.jobId) return;
        const terminal = frame.state !== 'running';
        const log = (job.log + frame.lines.map((line) => `${line}\n`).join('')).slice(-RUNTIME_LOG_LIMIT);
        entry.runtimeJob = {
          ...job,
          state: frame.state,
          message: frame.message || job.message,
          log,
          endedAt: terminal ? now() : null,
          ...(frame.version !== undefined && frame.version !== null ? { version: frame.version } : {}),
          ...(frame.component ? { result: frame.component } : {})
        };
        const updatedJob = entry.runtimeJob;
        if ((frame.state === 'succeeded' || frame.state === 'failed' || frame.state === 'refused') &&
            entry.observedInstallJobId === frame.jobId && entry.observationIdentity && socket.readyState === WebSocket.OPEN) {
          entry.observedInstallJobId = null;
          const identity = entry.observationIdentity;
          try {
            hooks.onObservedRuntimeInstall?.({ ...identity, enrollment: identity.enrollment ? { ...identity.enrollment } : null, action: 'install', state: frame.state, at: now() });
          } catch { /* Observers cannot affect runtime job processing. */ }
        }
        if (terminal) hooks.onRuntimeJob?.(entry.workerId, updatedJob);
        return;
      }
      if (frame.type === 'inventory') {
        entry.inventory = frame.inventory as WorkerInventory;
        if (entry.trial) entry.trial.inventoryApplied = true;
        // hello 里没带上 terminal.list 的老 worker，等 inventory 落地后再对一次账
        void reconcileTerminals(entry.workerId);
        void reconcileServices(entry.workerId);
        return;
      }
      if (frame.type === 'metrics') {
        const { type: _type, ...sample } = frame;
        recordMetrics(entry.workerId, sample);
        return;
      }
      if (frame.type === 'update_status') {
        entry.update = { state: frame.state, message: frame.message, logTail: frame.logTail, at: now() };
        if (frame.state === 'failed' || frame.state === 'refused' || frame.state === 'rolled_back') entry.updateTarget = null;
        hooks.onUpdateStatus?.(entry.workerId, entry.update);
        return;
      }
      const from = entry.workerId;
      if (frame.type === 'workdir_terminal_data_v1') {
        if (entry.observationIdentity && entry.workdirTerminal && canInvoke(entry.capabilities, 'sessions')) hooks.onWorkdirTerminalData?.(from, frame.epoch, frame.terminalId, frame.data);
        return;
      }
      if (frame.type === 'workdir_terminal_exit_v1') {
        if (entry.observationIdentity && entry.workdirTerminal && canInvoke(entry.capabilities, 'sessions')) hooks.onWorkdirTerminalExit?.(from, frame.epoch, frame.terminalId, frame.code);
        return;
      }
      if (frame.type === 'terminal_data') {
        hooks.onTerminalData?.(from, frame.terminalId, frame.data);
        return;
      }
      if (frame.type === 'terminal_exit') {
        hooks.onTerminalExit?.(from, frame.terminalId, frame.code, frame.signal);
        return;
      }
      if (frame.type === 'service_state') {
        hooks.onServiceState?.(from, {
          serviceId: frame.serviceId,
          state: frame.state,
          pid: frame.pid ?? null,
          detail: frame.detail ?? null,
          port: frame.port ?? null
        });
        return;
      }
      if (frame.type === 'service_log') {
        hooks.onServiceLog?.(from, frame.serviceId, frame.chunk);
        return;
      }
      if (frame.type === 'event') {
        if (frame.event.kind === 'ended' && frame.event.deliveryId && !isUnknownOutcomeEnded(frame.event)) {
          const deliveryId = frame.event.deliveryId;
          const start = starts.get(frame.sessionId);
          // A reused ID is ambiguous: an unkeyed-generation ended event might
          // belong to an earlier dispatch, so leave its proof fail-closed.
          if (start && start.socket === socket && start.workerId === from && placement.get(frame.sessionId) === from && start.deliveries.get(deliveryId) === 1) start.deliveries.delete(deliveryId);
          const proofs = retiredProofs.get(socket);
          if (proofs) {
            for (const [key, proof] of proofs) if (proof.sessionId === frame.sessionId && proof.deliveryId === deliveryId) proofs.delete(key);
            if (!proofs.size) retiredProofs.delete(socket);
          }
        }
        hooks.onEvent(from, frame.sessionId as SessionId, frame.event, sessionStartMetadata(frame.sessionId, from, entry, socket));
      }
      else if (frame.type === 'agent_session') {
        hooks.onAgentSession(from, frame.sessionId as SessionId, frame.agentSessionRef, sessionStartMetadata(frame.sessionId, from, entry, socket));
      } else if (frame.type === 'turn_ref') {
        hooks.onTurnRef?.(from, frame.sessionId as SessionId, frame.turnRef, frame.deliveryId);
      } else if (frame.type === 'branch_result') {
        hooks.onBranchResult?.(from, frame.sessionId as SessionId, frame.outcome, frame.reason);
      } else if (frame.type === 'branch_attempt_result') {
        const attempt = entry.branchAttempts.get(frame.sessionId);
        if (!attempt || attempt.attemptId !== frame.attemptId || placement.get(frame.sessionId) !== from) return;
        if (frame.outcome !== 'both_failed' && frame.agentSessionRef === attempt.sourceRef) return;
        entry.branchAttempts.delete(frame.sessionId);
        hooks.onBranchAttemptResult?.(from, frame.sessionId as SessionId, frame.attemptId, frame.outcome, frame.outcome === 'both_failed' ? undefined : frame.agentSessionRef);
      } else if (frame.type === 'session_start_result') {
        const start = starts.get(frame.sessionId);
        if (!start || start.socket !== socket || start.workerId !== from || start.attemptId !== frame.startAttemptId || placement.get(frame.sessionId) !== from) return;
        if (frame.state === 'ended') {
          retireStart(frame.sessionId, start);
          starts.delete(frame.sessionId);
          placement.delete(frame.sessionId);
          entry.branchAttempts.delete(frame.sessionId);
          const end = { workerId: from, socket, attemptId: frame.startAttemptId };
          endedStarts.set(frame.sessionId, end);
          hooks.onSessionStartEnded?.(from, frame.sessionId as SessionId, frame.startAttemptId, () => endedStarts.get(frame.sessionId) === end);
        } else {
          if (start.state !== 'starting') return;
          start.state = frame.state;
          if (frame.state === 'failed') start.reason = frame.reason ?? 'runtime';
        }
        const metadata = sessionStartMetadata(frame.sessionId, from, entry, socket);
        hooks.onSessionStartChanged?.(from, frame.sessionId as SessionId, metadata && frame.state === 'ready'
          ? { ...metadata, ready: { ...(frame.agentSessionRef === undefined ? {} : { agentSessionRef: frame.agentSessionRef }), ...(frame.options === undefined ? {} : { options: frame.options }) } }
          : metadata);
      } else if (frame.type === 'prompt_start_refused') {
        const start = starts.get(frame.sessionId);
        if (start && start.socket === socket && start.workerId === from && start.attemptId === frame.startAttemptId && placement.get(frame.sessionId) === from && start.deliveries.get(frame.deliveryId) === 1) {
          // Retain consumed proof so redispatch cannot authorize a replay.
          start.deliveries.set(frame.deliveryId, 2);
          // Admission was refused despite readiness; require an explicit retry
          // and a fresh generation rather than resending this delivery here.
          if (start.state === 'ready') {
            start.state = 'failed';
            start.reason = 'runtime';
            hooks.onSessionStartChanged?.(from, frame.sessionId as SessionId, sessionStartMetadata(frame.sessionId, from, entry, socket));
          }
        } else {
          const proofs = retiredProofs.get(socket);
          const key = JSON.stringify([frame.sessionId, frame.startAttemptId, frame.deliveryId]);
          if (!proofs?.delete(key)) return;
          if (!proofs.size) retiredProofs.delete(socket);
        }
        hooks.onPromptStartRefused?.(from, frame.sessionId as SessionId, frame.deliveryId);
      } else if (frame.type === 'options') {
        hooks.onOptions(from, frame.sessionId as SessionId, frame.options, sessionStartMetadata(frame.sessionId, from, entry, socket));
      } else if (frame.type === 'option_receipt') {
        const request = optionRequests.get(frame.sessionId);
        const current = () => optionRequests.get(frame.sessionId) === request && request?.socket === socket && request.workerId === from && placement.get(frame.sessionId) === from && starts.get(frame.sessionId) === request.start && entry?.socket === socket;
        if (!request || request.consumed || !current() || request.requestId !== frame.requestId || request.optionId !== frame.optionId) return;
        request.consumed = true;
        hooks.onOptionReceipt?.(from, frame.sessionId as SessionId, frame.requestId, frame.optionId, frame.outcome, frame.options, current);
      } else if (frame.type === 'status') {
        if ((frame.status === 'ended' || frame.status === 'gone') && managedSessions.has(frame.sessionId)) return;
        // 路由只由 start_session / adopt 建立；一台 Worker 报「running」不能把别人的会话改道到自己身上，
        // 报「结束」也只能划掉确实路由到它的那条。`idle` 是「这一轮结束了、进程还在」，路由得留着。
        if ((frame.status === 'ended' || frame.status === 'gone') && placement.get(frame.sessionId) === from) {
          placement.delete(frame.sessionId);
          entry.branchAttempts.delete(frame.sessionId);
        }
        hooks.onStatus(from, frame.sessionId as SessionId, frame.status, frame.reason, sessionStartMetadata(frame.sessionId, from, entry, socket));
      }
    };

    socket.on('close', () => {
      clearTimeout(helloTimer);
      closeObservation();
      if (entry) markOffline(entry, socket, closeReason);
      // 任务跑到一半断了：先记成失败，别让它永远「安装中」挡住下一个任务；同一个任务的进度帧之后若还能回来，照样认
      if (entry?.runtimeJob?.state === 'running' && entry.socket === null) {
        entry.runtimeJob = { ...entry.runtimeJob, state: 'failed', message: '连接断开，任务结果未知（连回来后看这台机器的状态）', endedAt: now() };
      }
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
        feed(entry, { type: 'missed' });
        if (linkIsDead(entry.link, policy)) {
          (socket as WebSocket & { markTimeout?: () => void }).markTimeout?.();
          socket.terminate();
          continue;
        }
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

  // 试运行观察（ADR 0030 D2）：领域策略决定提交 / 回退 / 继续等，这里只负责发帧和记状态
  const trialStableMs = options.trialStableMs ?? 60_000;
  const trialTimeoutMs = options.trialTimeoutMs ?? 5 * 60_000;
  const trials = setInterval(() => {
    for (const entry of registry.values()) {
      const trial = entry.trial;
      if (!trial) continue;
      const decision = decideTrial(
        { startedAt: trial.startedAt, connectedAt: entry.link.connectedAt ?? trial.startedAt, link: entry.link.state, inventoryApplied: trial.inventoryApplied, online: entry.socket !== null },
        now(),
        trialStableMs,
        trialTimeoutMs
      );
      const short = trial.commit?.slice(0, 7) ?? '新版本';
      if (decision.kind === 'wait') {
        if (entry.update?.state === 'trial') entry.update = { ...entry.update, at: now(), trialRemainingMs: decision.remainingMs, trialDeadlineAt: decision.deadlineAt };
        continue;
      }
      const socket = entry.socket;
      const frame: ServerToWorker =
        decision.kind === 'commit' ? { kind: 'update_commit', id: trial.id } : { kind: 'update_abort', id: trial.id, reason: decision.reason };
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
      entry.trial = null;
      entry.updateTarget = null;
      entry.update =
        decision.kind === 'commit'
          ? { state: 'succeeded', message: `试运行通过，已提交 ${short}`, logTail: entry.update?.logTail ?? '', at: now() }
          : { state: 'failed', message: `${decision.reason}，${socket ? '已让 Worker 切回上一个版本' : 'Worker 离线，由它的启动守卫切回上一个版本'}`, logTail: entry.update?.logTail ?? '', at: now() };
      hooks.onLog?.(`worker ${entry.workerId} 试运行 ${short}：${decision.kind}`);
      hooks.onUpdateStatus?.(entry.workerId, entry.update);
    }
  }, options.trialTickMs ?? 2_000);
  trials.unref();
  const echoes =
    policy.echoMs > 0
      ? setInterval(() => {
          for (const entry of registry.values()) if (entry.socket) void echo(entry);
        }, policy.echoMs)
      : null;
  echoes?.unref();

  function describe(entry: Registered): WorkerStatus {
    let sessionCount = 0;
    for (const workerId of placement.values()) if (workerId === entry.workerId) sessionCount += 1;
    const status: WorkerStatus = {
      workerId: entry.workerId,
      label: entry.label,
      origin: entry.origin,
      state: entry.socket ? 'online' : 'offline',
      agentIds: entry.agents.map((agent) => agent.id),
      agentModels: entry.agents.map((agent) => ({
        agentId: agent.id,
        models: agent.models,
        defaultModel: agent.defaultModel,
        ...(agent.nativeHandoff === true && sessionStartConnection(entry.workerId) !== null ? { nativeHandoff: true as const } : {}),
        ...(agent.readiness ? { readiness: agent.readiness } : {}),
        ...(agent.provision ? { provision: agent.provision } : {}),
        ...(agent.providers?.length ? { providers: agent.providers } : {})
      })),
      roots: entry.roots,
      lastSeenAt: entry.lastSeenAt,
      link: { state: entry.link.state, since: entry.link.since, rttMs: entry.link.rttMs, connectedAt: entry.link.connectedAt },
      connection: { connectedAt: entry.connection.at, address: entry.connection.address, version: entry.connection.version },
      ...(entry.capabilities ? { capabilities: [...entry.capabilities] } : {}),
      sessionCount,
      ...(entry.host ? { hostname: entry.host.hostname, platform: `${entry.host.platform}/${entry.host.arch}` } : {}),
      ...(entry.socket === null && entry.reason !== undefined ? { reason: entry.reason } : {}),
      ...(entry.build ? { build: entry.build } : {}),
      ...(entry.update ? { update: entry.update } : {}),
      ...(entry.runtimeJob ? { runtimeJob: entry.runtimeJob } : {}),
      ...(entry.inventory ? { inventory: entry.inventory, drift: detectDrift(hooks.expectedComponents?.(entry.workerId) ?? [], entry.inventory) } : {})
    };
    const resources = resourcesOf(entry);
    return resources ? { ...status, resources } : status;
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
  /** 项目 Git 导入在「可能已有副作用」后的统一说法：不假装失败，也不允许自动重放。 */
  const projectGitBundleUnknown = (workerId: string) => ({
    ok: false as const,
    error: unavailable(`Worker「${labelOf(workerId)}」没有确认项目 Git bundle 导入的结果（可能已创建 ref），结果未知；先核对 ref，不要自动重放`)
  });
  function toDomain<T>(outcome: RpcOutcome<T>, what: string, workerId: string): Result<T, DomainError> {
    if (outcome.ok) return outcome;
    const { code, message } = outcome.error;
    if (code === 'invalid') return { ok: false, error: invalid(message) };
    if (code === 'conflict') return { ok: false, error: conflict(message) };
    if (code === 'forbidden') return { ok: false, error: forbidden(message) };
    if (code === 'not_found') return { ok: false, error: { code: 'not_found', message } };
    if (code === 'timeout') return { ok: false, error: unavailable(`Worker「${labelOf(workerId)}」没有及时回复${what}`) };
    return { ok: false, error: unavailable(message) };
  }
  function mutationSafeEntry(entry: Registered): boolean {
    return registry.get(entry.workerId) === entry && !!entry.observationIdentity && !!entry.channel &&
      entry.socket?.readyState === WebSocket.OPEN && entry.workspaceMutationSafety;
  }
  /** Scoped to fenced mutations: never infer completion from generic handler/transport errors. */
  async function settledMutation<T>(workerId: string, run: (channel: RpcChannel) => Promise<RpcOutcome<T>>, what: string): Promise<Result<T, DomainError>> {
    const entry = online(workerId);
    if (!entry?.channel || !entry.socket) {
      const result = offline(workerId);
      return { ok: false, error: { ...result.error, operationSettled: true } };
    }
    if (workspaceMutationSafetyRequired && !mutationSafeEntry(entry)) {
      return { ok: false, error: { ...unavailable(`Worker「${labelOf(workerId)}」未通过工作空间安全能力验证，操作未发送`), operationSettled: true } };
    }
    const { socket, channel } = entry;
    const outcome = await run(channel);
    if (registry.get(workerId) !== entry || entry.socket !== socket || entry.channel !== channel || socket.readyState !== WebSocket.OPEN)
      return { ok: false, error: unavailable(`Worker「${labelOf(workerId)}」连接已改变，${what}结果未知`) };
    if (outcome.ok) return outcome;
    const { code, message } = outcome.error;
    const codes = ['invalid', 'conflict', 'not_found', 'forbidden', 'unavailable', 'not_implemented'] as const;
    const explicit = codes.find((item) => code === `operation_settled_${item}`);
    if (explicit) return { ok: false, error: { code: explicit, message, operationSettled: true } };
    // These RPC codes are generated before a handler can execute.
    if (code === 'unknown_method' || code === 'unsupported' || code === 'bad_params' || code === 'forbidden') {
      const mapped = toDomain<T>(outcome, what, workerId);
      return mapped.ok ? mapped : { ok: false, error: { ...mapped.error, operationSettled: true } };
    }
    return toDomain(outcome, what, workerId);
  }

  /** Planned operations and probes require an authenticated, unchanged worker connection. */
  async function plannedRequest<T>(workerId: string, run: (channel: RpcChannel) => Promise<RpcOutcome<T>>, what: string, reconcileOnly = false, readOnly = false): Promise<Result<T, DomainError>> {
    const entry = online(workerId);
    if (!entry?.channel || !entry.socket || !entry.observationIdentity) {
      const error = unavailable(`Worker「${labelOf(workerId)}」未通过身份验证或不在线，${what}未发送`);
      return { ok: false, error: reconcileOnly ? error : { ...error, operationSettled: true } };
    }
    const { channel, socket, observationIdentity } = entry;
    const outcome = await run(channel);
    if (registry.get(workerId) !== entry || entry.channel !== channel || entry.socket !== socket || entry.observationIdentity !== observationIdentity || socket.readyState !== WebSocket.OPEN)
      return { ok: false, error: unavailable(`Worker「${labelOf(workerId)}」连接已改变，${what}结果未知`) };
    if (outcome.ok) return outcome;
    if (readOnly) {
      const mapped = toDomain<T>(outcome, what, workerId);
      return mapped.ok ? mapped : { ok: false, error: { code: mapped.error.code, message: `${what}失败` } };
    }
    const codes = ['invalid', 'conflict', 'not_found', 'forbidden', 'unavailable', 'not_implemented'] as const;
    const explicit = codes.find((item) => outcome.error.code === `operation_settled_${item}`);
    if (explicit && !reconcileOnly) return { ok: false, error: { code: explicit, message: `${what}失败`, operationSettled: true } };
    if (!reconcileOnly && ['unknown_method', 'unsupported', 'bad_params', 'forbidden'].includes(outcome.error.code)) {
      const mapped = toDomain<T>(outcome, what, workerId);
      return mapped.ok ? mapped : { ok: false, error: { code: mapped.error.code, message: `${what}未执行`, operationSettled: true } };
    }
    return { ok: false, error: unavailable(`${what}结果未知`) };
  }

  function requestProbe(workerId: string): boolean {
    const entry = online(workerId);
    if (!entry?.socket) return false;
    entry.socket.send(JSON.stringify({ kind: 'probe' } satisfies ServerToWorker));
    return true;
  }

  /**
   * 自定义运行时别名（CAP-1）：连上就推一帧给 worker 热应用。
   * 尽力而为——离线 / 老 worker 不认都只返回 false，不抛错。
   */
  function sendAgentConfig(workerId: string, aliases: readonly AgentAlias[]): boolean {
    const entry = online(workerId);
    if (!entry?.socket) return false;
    const frame: ServerToWorker = {
      kind: 'agent_config',
      aliases: aliases.map((alias) => ({
        id: alias.id,
        label: alias.label,
        command: alias.command,
        args: [...alias.args],
        ...(alias.models !== undefined ? { models: [...alias.models] } : {}),
        ...(alias.defaultModel !== undefined ? { defaultModel: alias.defaultModel } : {})
      }))
    };
    entry.socket.send(JSON.stringify(frame));
    return true;
  }

  const gateway: NodeGateway = {
    sessionStartConnection,
    sessionStartReadiness,
    retrySessionStart(sessionId: SessionId, workerId?: string | null): void {
      const end = endedStarts.get(sessionId);
      if (end && (!workerId || end.workerId === workerId)) endedStarts.delete(sessionId);
      const start = starts.get(sessionId);
      if (start && (!workerId || start.workerId === workerId) && sessionStartReadiness(sessionId, workerId).state === 'failed') starts.delete(sessionId);
    },
    async status(): Promise<WorkerStatus[]> {
      return statuses();
    },
    async probe(workerId: string): Promise<boolean> {
      return requestProbe(workerId);
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
    },
    git(workerId: string): WorkspaceGit {
      const call = async <T>(run: (channel: RpcChannel) => Promise<RpcOutcome<T>>, what: string): Promise<Result<T, DomainError>> => {
        const channel = channelOf(workerId);
        if (!channel) return offline(workerId);
        return toDomain(await run(channel), what, workerId);
      };
      // clone / fetch 走网络，给足时间；其余是本地 git，默认超时就够
      const slow = { timeoutMs: 10 * 60_000 };
      return {
        inspect: (path) => call((c) => c.request(wsInspect, { path }), '目录探测'),
        inspectPlannedWorktree: (input) => plannedRequest(workerId, (c) => c.request(wsInspectPlannedWorktree, input), '检查计划来源', false, true),
        createPlannedWorktree: (input) => plannedRequest(workerId, (c) => c.request(wsCreatePlannedWorktree, input, slow), '执行计划检出', input.reconcileOnly),
        verifyPlannedWorktree: (input) => plannedRequest(workerId, (c) => c.request(wsVerifyPlannedWorktree, input, slow), '验证计划检出', false, true),
        resolvePlannedBase: (input) => plannedRequest(workerId, (c) => c.request(wsResolvePlannedBase, input, slow), '探测计划底座', false, true),
        preparePlannedBase: (input) => plannedRequest(workerId, (c) => c.request(wsPreparePlannedBase, input, slow), '准备计划底座', input.reconcileOnly),
        checkRepo: (repoUrl, branch, auth) => call((c) => c.request(wsCheckRepo, { repoUrl, branch, ...(auth ? { auth } : {}) }, { timeoutMs: 30_000 }), '检查仓库'),
        clone: (input) => settledMutation(workerId, (c) => c.request(wsClone, { ...input, branch: input.branch ?? null, ...(input.auth ? { auth: input.auth } : {}) }, slow), '下载仓库'),
        addWorktree: (input) => settledMutation(workerId, (c) => c.request(wsAddWorktree, { ...input, base: input.base ?? null, ...(input.auth ? { auth: input.auth } : {}) }, slow), '新开分支'),
        status: (path) => call((c) => c.request(wsStatus, { path }), '检查改动'),
        saveWip: (path, message, auth) => call((c) => c.request(wsSaveWip, { path, message, ...(auth ? { auth } : {}) }, slow), '提交并推送'),
        preview: (path, maxPatchBytes, options) =>
          call(
            (c) =>
              c.request(
                wsPreview,
                { path, maxPatchBytes, ...(options?.redactSensitive ? { redactSensitive: true } : {}) },
                { timeoutMs: 60_000 }
              ),
            '读取改动'
          ),
        commit: (path, input) => call((c) => c.request(wsCommit, { path, ...input }, { timeoutMs: 120_000 }), '提交'),
        push: (path, auth) => call((c) => c.request(wsPush, { path, ...(auth ? { auth } : {}) }, slow), '推送'),
        publishRef: (input) => call((c) => c.request(wsPublishRef, { ...input, ...(input.auth ? { auth: input.auth } : {}) }, slow), '发布批准提交'),
        prepareDelegationWorktree: (input) =>
          settledMutation(workerId, (c) => c.request(wsPrepareDelegationWorktree, { ...input, ...(input.auth ? { auth: input.auth } : {}) }, slow), '准备委派工作区'),
        importCommit: (input) => call((c) => c.request(wsImportCommit, input, slow), '本地导入提交'),
        gh: (path, request) => call((c) => c.request(wsGh, { path, request }, { timeoutMs: 120_000 }), 'gh 开 PR'),
        remove: (path, kind, options) => settledMutation(workerId, (c) => c.request(wsRemove, { path, kind, ...(options?.force ? { force: true } : {}), ...(options?.mergedHead ? { mergedHead: options.mergedHead } : {}) }, { timeoutMs: 120_000 }), '删除工作空间'),
        // 准备命令最多跑 30 分钟（项目配置上限），RPC 再多给 30 秒，别让管道先超时
        runSetup: (input) => call((c) => c.request(wsRunSetup, { ...input, ...(input.env ? { env: { ...input.env } } : {}) }, { timeoutMs: Math.min(input.timeoutMs, 30 * 60_000) + 30_000 }), '跑准备命令')
      };
    }
  };

  const remoteBrowsers = createRemoteBrowsers({ channelOf, offline, toDomain });

  const assets: AssetDelivery = {
    /**
     * `sessions`（协议 v7，可选第 4 个参数）：hub 认为这台机器上还活着的会话 →
     * 各自想要的 assetId / digest。Worker 据此原子重建每会话视图、清掉孤儿视图。
     * 领域层还没接线时缺省 = 不动视图（会话启动时 Worker 自己按 start_session 的清单建）。
     */
    async push(workerId, manifest, retain, sessions?: readonly SessionAssetRequestWire[]) {
      const channel = channelOf(workerId);
      if (!channel) return offline(workerId);
      const entries = manifest.map((entry) => ({ ...entry, files: [...entry.files] }));
      // 首次同步要把内容一批批取回来，给足时间
      return toDomain(
        await channel.request(
          assetsSync,
          {
            entries,
            ...(retain === undefined || retain.length === 0 ? {} : { retain: [...retain] }),
            ...(sessions === undefined
              ? {}
              : {
                  sessions: sessions.map((session) => ({
                    sessionId: session.sessionId,
                    assetIds: [...session.assetIds],
                    ...(session.digests === undefined ? {} : { digests: { ...session.digests } })
                  }))
                })
          },
          { timeoutMs: 5 * 60_000 }
        ),
        '资产同步',
        workerId
      );
    }
  };

  return {
    gateway,
    supportsBranchAttempt,
    assets,
    async testProvider(workerId, input) {
      const channel = channelOf(workerId);
      if (!channel) return offline(workerId);
      return toDomain(await channel.request(providerTest, input, { timeoutMs: 30_000 }), '测试模型提供商', workerId);
    },
    updateProvider,
    openTerminal,
    resizeTerminal,
    closeTerminal,
    listTerminals,
    sendTerminalInput,
    reconcileTerminals,
    workdirTerminals,
    workdirTerminalSupported(workerId) { return registry.get(workerId)?.workdirTerminal === true; },
    workspaceMutationSafe(workerId) {
      const entry = online(workerId);
      return !!entry && mutationSafeEntry(entry);
    },
    services,
    processes,
    reconcileServices,
    workers(): WorkerStatus[] {
      return statuses();
    },
    browser(workerId: string): WorkspaceBrowser {
      return remoteBrowsers.browser(workerId);
    },
    groups(workerId: string): WorkspaceGroupOps {
      // 本地文件操作，但可能撞上慢盘 / 大量小文件；统一 120 秒，和删除工作空间一个量级
      const limit = { timeoutMs: 120_000 };
      return {
        init: (input) => settledMutation(workerId, (c) => c.request(wsGroupInit, { slug: input.slug, name: input.name, id: input.id }, limit), '建组合工作空间目录'),
        remove: (input) => settledMutation(workerId, (c) => c.request(wsGroupRemove, { root: input.root, id: input.id }, limit), '删组合工作空间目录'),
        newWorktree: (input) => settledMutation(workerId, (c) => c.request(wsNewWorktree, { ...input, base: input.base ?? null, ...(input.auth ? { auth: input.auth } : {}) }, limit), '在组合工作空间里开分支')
      };
    },
    async importProjectGitBundle(workerId, input) {
      const entry = online(workerId);
      if (!entry) return offline(workerId);
      // 先看 live hello 能力：老 / 未 opt-in 的 Worker 明确拒绝，绝不回退到带凭据的 RPC 或本地路径。
      if (!entry.projectGitBundleImport) {
        return {
          ok: false as const,
          error: { code: 'not_implemented' as const, message: `Worker「${labelOf(workerId)}」没有启用项目 Git bundle 导入（未 opt-in），已拒绝` }
        };
      }
      const channel = entry.channel;
      if (!channel) return offline(workerId);
      // 正常授权闸门：通道自己也会再判一次；这里提前判是为了「未授权时一个字节都不发」。
      if (!canInvoke(entry.capabilities, 'git')) return { ok: false as const, error: forbidden(capabilityDenied('git')) };
      const params = {
        path: input.path,
        expectedUrl: input.expectedUrl,
        bundleBase64: input.bundleBase64,
        bundleSha256: input.bundleSha256,
        tipSha: input.tipSha,
        ref: input.ref
      };
      // 出站同样按协议 schema 校验：通道只校验入站，8 MiB 上限 / strict 字段 / ref 绑定
      // 必须在这里、在发送前生效，否则超大 bundle 会先被整包塞进 WebSocket。
      const checked = wsImportProjectGitBundle.params.safeParse(params);
      if (!checked.success) {
        return { ok: false as const, error: invalid('项目 Git bundle 导入参数不合法（大小 / 字段 / ref 绑定），未发送') };
      }
      const outcome = await channel.request(wsImportProjectGitBundle, checked.data, { timeoutMs: projectGitBundleTimeoutMs });
      if (outcome.ok) {
        // 响应 schema 只保证自洽；还要和这次请求的 ref / tip 对得上，否则同样只能说「结果未知」。
        if (outcome.value.ref !== checked.data.ref || outcome.value.tipSha !== checked.data.tipSha) {
          return projectGitBundleUnknown(workerId);
        }
        return outcome;
      }
      // 超时 / 断线 / 响应不合协议都发生在「可能已经落盘并建好 ref」之后：只能报结果未知，不能重放。
      if (outcome.error.code === 'timeout' || outcome.error.code === 'closed' || outcome.error.code === 'bad_result') {
        return projectGitBundleUnknown(workerId);
      }
      // 对端明确回 unknown_method：请求一定没执行，可以诚实报未实现（仍然不回退、不重放）。
      if (outcome.error.code === 'unknown_method') {
        return {
          ok: false as const,
          error: { code: 'not_implemented' as const, message: `Worker「${labelOf(workerId)}」没有实现项目 Git bundle 导入，已拒绝` }
        };
      }
      if (outcome.error.code === 'invalid' || outcome.error.code === 'conflict' || outcome.error.code === 'forbidden' || outcome.error.code === 'not_found' || outcome.error.code === 'unsupported') {
        return toDomain(outcome, '项目 Git bundle 导入', workerId);
      }
      // 其余 code（含 bad_params / failed）也可能携带通道原始文案：不猜，一律按结果未知。
      return projectGitBundleUnknown(workerId);
    },
    metrics(workerId: string): readonly ResourceSample[] {
      return [...(usage.get(workerId)?.samples ?? [])];
    },
    setRefuseWhenFull(workerIds: Iterable<string>): void {
      refusePolicy = new Set(workerIds);
    },
    adopt(workerId: string, sessionIds: readonly string[]): void {
      if (!online(workerId)) return;
      for (const sessionId of sessionIds) {
        optionRequests.delete(sessionId);
        endedStarts.delete(sessionId);
        if (placement.get(sessionId) !== workerId) starts.delete(sessionId);
        placement.set(sessionId, workerId);
      }
    },
    hostOf(sessionId: string): string | null {
      return placement.get(sessionId) ?? null;
    },
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    },
    disconnect(workerId: string, why: 'admin' | 'revoked' = 'admin'): boolean {
      const kicked = registry.get(workerId);
      if (kicked) kicked.kicked = true;
      const socket = kicked?.socket;
      if (socket) invalidateSocket(socket);
      if (why === 'revoked') {
        registry.delete(workerId);
        usage.delete(workerId);
      } // 吊销了就不再列在机器里
      if (!socket) return false;
      const reason = why === 'revoked' ? '机器已被吊销' : '管理员断开';
      (socket as WebSocket & { markKicked?: (reason: string) => void }).markKicked?.(reason);
      socket.close(why === 'revoked' ? 4401 : 4403, reason);
      return true;
    },
    requestUpdate(workerId: string, commit: string): boolean {
      const entry = online(workerId);
      if (!entry?.socket) return false;
      if (!canInvoke(entry.capabilities, 'update')) return false;
      entry.socket.send(JSON.stringify({ kind: 'update', commit } satisfies ServerToWorker));
      entry.updateTarget = commit;
      entry.update = { state: 'updating', message: `已发出更新指令 → ${commit.slice(0, 7)}`, logTail: '', at: now() };
      return true;
    },
    rotateCredential(workerId: string, credential: string): boolean {
      const entry = online(workerId);
      if (!entry?.socket || entry.socket.readyState !== WebSocket.OPEN) return false;
      // 明文只在这一帧里出现，不进 wire 日志
      entry.socket.send(JSON.stringify({ kind: 'credential_rotate', credential } satisfies ServerToWorker));
      return true;
    },
    requestProbe,
    sendAgentConfig,
    requestRuntimeJob(workerId: string, job: RuntimeJob): boolean {
      const entry = online(workerId);
      if (!entry?.socket) return false;
      if (!canInvoke(entry.capabilities, 'runtimes')) return false;
      entry.socket.send(
        JSON.stringify({
          kind: 'runtime_job',
          jobId: job.jobId,
          agentId: job.agentId,
          action: job.action,
          version: job.version,
          ...(job.source ? { source: job.source } : {}),
          ...(job.component ? { component: { ...job.component, provides: [...job.component.provides] } } : {}),
          ...(job.components?.length ? { components: job.components.map((c) => ({ ...c, provides: [...c.provides] })) } : {})
        } satisfies ServerToWorker)
      );
      entry.runtimeJob = job;
      entry.observedInstallJobId = job.action === 'install' && entry.observationIdentity ? job.jobId : null;
      return true;
    },
    close(): void {
      endedStarts.clear();
      retiredProofs.clear();
      clearInterval(heartbeat);
      clearInterval(trials);
      if (echoes) clearInterval(echoes);
      for (const entry of registry.values()) entry.channel?.close('hub 正在关闭');
      for (const entry of registry.values()) entry.socket?.terminate();
      registry.clear();
      starts.clear();
      managedSessions.clear();
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
        // Older Workers reject fork sequence 0. Origin is metadata only on the
        // Worker; branch/resume independently control runtime startup. Keep the
        // real fork in the Hub and project only this startup frame for them.
        origin: command.origin.kind === 'fork' && command.origin.atSeq === 0 ? { kind: 'derive' } : command.origin,
        resume: command.resume,
        options: command.options,
        ...(command.branch ? { branch: { ...command.branch } } : {}),
        ...(command.branchAttemptId === undefined ? {} : { branchAttemptId: command.branchAttemptId }),
        ...(command.tools ? { tools: command.tools } : {}),
        ...(command.mcp && command.mcp.length > 0
          ? { mcp: command.mcp.map((entry) => (entry.transport === 'stdio' ? { ...entry, args: [...entry.args], env: { ...entry.env } } : { ...entry })) }
          : {}),
        ...(command.assetIds ? { assetIds: [...command.assetIds] } : {}),
        ...(command.assetDigests ? { assetDigests: { ...command.assetDigests } } : {}),
        ...(command.pinned === true ? { pinned: true } : {}),
        ...(command.provider ? { provider: { ...command.provider, models: command.provider.models.map((model) => ({ ...model })) } } : {})
      };
    case 'prompt':
      return {
        kind: 'prompt', sessionId: command.sessionId, text: command.text, parts: [...command.parts],
        ...(command.deliveryId ? { deliveryId: command.deliveryId } : {}),
        ...(command.startAttemptId === undefined ? {} : { startAttemptId: command.startAttemptId }),
        ...(command.messageOrigin === undefined ? {} : { messageOrigin: command.messageOrigin })
      };
    case 'interrupt':
      return { kind: 'interrupt', sessionId: command.sessionId };
    case 'dispose':
      return { kind: 'dispose', sessionId: command.sessionId };
    case 'approval':
      return { kind: 'approval', sessionId: command.sessionId, approvalId: command.approvalId, decision: command.decision, ...(command.author ? { author: { ...command.author } } : {}) };
    case 'compact':
      return { kind: 'compact', sessionId: command.sessionId, ...(command.instructions ? { instructions: command.instructions } : {}) };
    case 'set_option':
      return {
        kind: 'set_option',
        sessionId: command.sessionId,
        optionId: command.optionId,
        value: command.value,
        ...(command.requestId ? { requestId: command.requestId } : {})
      };
  }
}
