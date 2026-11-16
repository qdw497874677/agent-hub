import type { ProviderGrant } from '../provider.ts';
import type { SessionId, TaskId, ServiceId } from '../ids.ts';
import type { SessionOrigin } from '../session.ts';
import type { ServiceRestart, ServiceState } from '../service.ts';
import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';
import type { WorkerStatus } from '../worker.ts';
import type { PromptPart } from '../attachment.ts';
import type { DirectoryEntry } from './workspace-fs.ts';
import type { ToolAccess } from '../tool.ts';
import type { McpLaunch } from '../mcp.ts';
import type { WorkspaceGit } from './workspace-git.ts';
import type { WorkspaceGroupGit } from './workspace-group-git.ts';
import type { BranchSpec } from './agent-runtime.ts';

/**
 * Server → Worker 指令。从第一天就是双向的：只够回传执行事件的通道，
 * 将来做「自动下发安装」时要重构成双向（定位 §5 特别说明）。
 */
export type WorkerCommand =
  | {
      readonly kind: 'start_session';
      readonly sessionId: SessionId;
      /** 落点：交给哪台 Worker。后续 prompt / interrupt 都按会话跟着它走。 */
      readonly workerId: string;
      /** 归属任务；null = 容器会话（群角色 / bot P2P），worker 不按任务做事。 */
      readonly taskId: TaskId | null;
      readonly agentId: string;
      readonly workspaceRoot: string;
      readonly origin: SessionOrigin;
      readonly resume: { readonly agentSessionRef: string | null; readonly cursor: number } | null;
      /**
       * 开跑前就定下的可调项（键是 option id）；空对象 = 全用 agent 默认。
       * 模型也在这里（`options.model`）——它就是一个 category 为 model 的可调项，不再单开字段。
       */
      readonly options: Readonly<Record<string, string | boolean>>;
      /** ADR 0028 原生分叉（resume 为 null 时才有意义）。 */
      readonly branch?: BranchSpec;
      /** 能力层：agent 用它连 hub 的工具（MCP）。没有 = 这次不给工具，行为同旧版。令牌不进日志。 */
      readonly tools?: ToolAccess;
      /** MCP 资产（hub 在发出前才填，见 sessionMcpLaunch）。stdio 的 env 含密钥明文：不落库、不进日志。 */
      readonly mcp?: readonly McpLaunch[];
      /** 常驻：Worker 不按空闲回收这条会话，也不占保活上限（任务里长期用的那条）。 */
      readonly pinned?: boolean;
      /**
       * 这次会话生效的资产 id（项目作用域，见 resolveSessionAssets）。
       * v4 起 hub 总是显式给出（可能是空数组）；缺省 = 一个都不给（fail-closed）。
       * 旧语义「没有 = 机器上装着的全给」已废弃（#223）。
       */
      readonly assetIds?: readonly string[];
      /**
       * #226 E4c：每个 assetId 对应的**精确版本**（内容寻址 digest）。
       * 有它时 Worker 只读这一版；不传 = 用机器上当前装的（旧行为）。
       */
      readonly assetDigests?: Readonly<Record<string, string>>;
      /** hub 模型提供商（选了 hub-<slug>/… 模型时 hub 在发出前才填）。apiKey 不落库、不进日志。 */
      readonly provider?: ProviderGrant;
    }
  | {
      readonly kind: 'set_option';
      readonly sessionId: SessionId;
      readonly optionId: string;
      readonly value: string | boolean;
    }
  | {
      readonly kind: 'prompt';
      readonly sessionId: SessionId;
      readonly text: string;
      readonly parts: readonly PromptPart[];
      /** 送达队列里的 id（ADR 0031）：Worker 按它去重，重试不会让 agent 收到两遍。 */
      readonly deliveryId?: string;
    }
  | { readonly kind: 'interrupt'; readonly sessionId: SessionId }
  /** 手动压缩上下文（ADR 0020）。老 worker 不认，只记一条日志。 */
  | { readonly kind: 'compact'; readonly sessionId: SessionId; readonly instructions?: string }
  /** 回答运行时的批准请求（ADR 0023）。老 worker 不认，只记一条日志——运行时那边超时当拒绝。 */
  | {
      readonly kind: 'approval';
      readonly sessionId: SessionId;
      readonly approvalId: string;
      readonly decision: 'allow' | 'deny';
      readonly author?: { readonly id: string; readonly name: string };
    }
  | { readonly kind: 'dispose'; readonly sessionId: SessionId };

/**
 * 派发回执。只有 start_session 会带环境版本：server 在挂好工具令牌、算完资产/MCP 之后才派发，
 * 这个版本由 domain 的启动入口统一落库。`void` 只为兼容「只关心成败」的旧调用方与测试替身。
 */
export type DispatchOutcome = void | { readonly environmentRevision?: string | null };

/** 交给 Worker 启动一条服务的参数（docs/design/session-service.md §5）。 */
export interface ServiceStartInput {
  readonly serviceId: ServiceId;
  readonly root: string;
  readonly command: string;
  readonly port: number | null;
  readonly env: Readonly<Record<string, string>>;
  readonly restart: ServiceRestart;
}

/** Worker 上报的运行态（`service.list` 用）。 */
export interface ServiceRuntime {
  readonly serviceId: ServiceId;
  readonly pid: number | null;
  readonly state: ServiceState;
  readonly port: number | null;
}

/** 那台 Worker 上的服务原语。只做转发，权限/落库都在 hub 用例里。 */
export interface ServiceGateway {
  start(input: ServiceStartInput): Promise<Result<{ readonly pid: number; readonly port: number | null }, DomainError>>;
  stop(serviceId: ServiceId, signal?: 'TERM' | 'KILL'): Promise<Result<{ readonly exited: boolean }, DomainError>>;
  list(): Promise<Result<readonly ServiceRuntime[], DomainError>>;
  logs(serviceId: ServiceId, maxBytes?: number): Promise<Result<{ readonly tail: string }, DomainError>>;
}

/**
 * 一台 Worker 上的一个进程（只读清单，不登记、不托管）。
 * `cmd` 已过凭据脱敏并截断；`cwd` / `cmd` 都是不可信内容，展示前不要当 HTML。
 */
export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly cmd: string;
  readonly cwd: string;
  readonly ports: readonly number[];
}

export interface NodeGateway {
  status(): Promise<WorkerStatus[]>;
  dispatch(command: WorkerCommand): Promise<Result<DispatchOutcome, DomainError>>;
  /**
   * 浏览某台 Worker 上的目录（只列子目录）。项目目录在哪台机器上，就得问那台机器——
   * Server 自己的文件系统只对和它同机的 Worker 有意义。
   * 返回的 `path` 是 Worker 解析后的绝对路径（请求空串时就是它的起点）。
   * 目录不存在返回 `exists: false`，而不是错误：那是用户输错了，不是通道坏了。
   */
  listDirectories(
    workerId: string,
    path: string
  ): Promise<
    Result<{ readonly path: string; readonly exists: boolean; readonly entries: readonly DirectoryEntry[] }, DomainError>
  >;
  /** 在那台 Worker 上 parent 下建一层文件夹（受它的 WORKER_ROOTS 约束）。返回新目录绝对路径。 */
  makeDirectory(workerId: string, parent: string, name: string): Promise<Result<{ readonly path: string }, DomainError>>;
  /**
   * 项目里的文件（相对 root），给 `@` 引用选择器。由项目所在的那台 Worker 扫——
   * Server 不读 Worker 机器上的路径。
   */
  listFiles(
    workerId: string,
    root: string,
    limit: number
  ): Promise<Result<{ readonly files: readonly string[]; readonly truncated: boolean }, DomainError>>;
  /** 读那台 Worker 上的一个文件（只用于会话自己的附件）。不存在 = null；超过 maxBytes 报错。 */
  readFile(workerId: string, path: string, maxBytes: number): Promise<Result<Uint8Array | null, DomainError>>;
  /** 那台 Worker 上的工作空间 git / 目录操作（ws.*）。 */
  git(workerId: string): WorkspaceGit;
  /** 那台 Worker 上的组合工作空间容器操作（ws.group_* / ws.new_worktree）。可选：老网关没有。 */
  groups?(workerId: string): WorkspaceGroupGit;
  /** 那台 Worker 上的长驻服务（ws.service_*）。可选：老网关没有。 */
  services?(workerId: string): ServiceGateway;
  /**
   * 那台 Worker 上 cwd 落在 WORKER_ROOTS 里的进程（proc.list，只读）。
   * 可选：老网关没有；离线 / 没有 `service` 能力时返回 unavailable。
   */
  processes?(workerId: string): Promise<Result<readonly ProcessInfo[], DomainError>>;
  /**
   * 「重新检测」：让那台 Worker 立刻重新探测各 harness 是否可用，结果异步经它的 agent 清单回来。
   * 不在线返回 false。可选：不支持的网关 = 无从检测。
   */
  probe(workerId: string): Promise<boolean>;
}
