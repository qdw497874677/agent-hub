import type { DeliveryQueue } from '../ports/delivery-queue.ts';
import type { WorkspaceSweepStore } from '../ports/workspace-sweeps.ts';
import type { PullRequestRepository } from '../ports/pull-requests.ts';
import type { SessionId } from '../ids.ts';
import type { AccessPolicy } from './authorization.ts';
import type { Workspace } from '../workspace.ts';
import type { AgentId } from '../ids.ts';
import type { Task } from '../task.ts';
import type { Session } from '../session.ts';
import type { Artifact } from '../artifact.ts';
import type { AgentDescriptor } from '../agent.ts';
import type { CanvasLayout, LineageEdge } from '../canvas.ts';
import type { Project } from '../project.ts';
import type { JournalEntry } from '../event.ts';
import type { ProjectRepository } from '../ports/project-repository.ts';
import type { TaskRepository } from '../ports/task-repository.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import type { ArtifactRepository } from '../ports/artifact-repository.ts';
import type { LayoutStore } from '../ports/layout-store.ts';
import type { SessionEventStream } from '../ports/event-stream.ts';
import type { NodeGateway } from '../ports/node-gateway.ts';
import type { WorkspaceGit } from '../ports/workspace-git.ts';
import type { WorkspaceFS } from '../ports/workspace-fs.ts';
import type { SearchGateway } from '../ports/search-gateway.ts';
import type { SessionHosting } from '../ports/session-hosting.ts';
import type { SessionQueue } from '../ports/session-queue.ts';
import type { WorkLogRepository } from '../ports/work-log-repository.ts';
import type { WorkspaceRepository } from '../ports/workspace-repository.ts';

/**
 * 已装配的 agent。UI 只从这里拿能力矩阵，不认 agent 名字。
 *
 * 注意这里**只暴露描述，不暴露运行时**：运行时属于 worker 进程，
 * server 手上永远没有 `AgentRuntime`——它只有 `NodeGateway`。
 * 早期版本在这里放过 `runtime()`，那等于让内核去摸别人的进程，是层次错位。
 */
export interface AgentCatalog {
  list(): readonly AgentDescriptor[];
  descriptor(id: AgentId): AgentDescriptor | null;
  /** 某台机器上报的这个 agent（多机时各机版本可能不同，能力以会话所在那台为准）；没有就退回 descriptor()。 */
  descriptorOn?(workerId: string, id: AgentId): AgentDescriptor | null;
}

/**
 * 用例能碰到的全部端口。**用例签名一律写 `Pick<Deps, …>`**，只声明自己真用到的那几个，
 * 依赖一眼可见、测试替身也只需造这几个。全量 `Deps` 只出现在组合根（server/main.ts）。
 *
 * CapacityPolicy / NodeProvisioner 仍是已定义的端口（见 ports/），但当前没有用例消费它们，
 * 所以不进 Deps——等调度/下发真的落地时再接进来，不提前养空实现。
 */
export interface Deps {
  /** 交接简报的 token 上限（HUB_HANDOFF_TOKEN_CAP，默认 16k）。 */
  readonly handoffTokenCap?: number;
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  /** 任务工作日志（只追加）。 */
  readonly workLog: WorkLogRepository;
  readonly sessions: SessionRepository;
  /** 工作空间登记（workspaces.md）。 */
  readonly workspaces: WorkspaceRepository;
  readonly artifacts: ArtifactRepository;
  readonly layout: LayoutStore;
  readonly stream: SessionEventStream;
  readonly gateway: NodeGateway;
  readonly agents: AgentCatalog;
  readonly fs: WorkspaceFS;
  /** Server 本机上的工作空间 git / 目录操作；远端的走 gateway.git(workerId)。 */
  readonly git: WorkspaceGit;
  readonly search: SearchGateway;
  /** 哪些会话此刻有 worker 托管；不在就得先 resume 再说话。 */
  readonly hosting: SessionHosting;
  /** 同一会话的写入串行（ADR 0004）。 */
  readonly queue: SessionQueue;
  readonly now: () => number;
  /** 送达队列（ADR 0031 D2）。不给 = 老行为：送不出去当场失败。 */
  readonly deliveries?: DeliveryQueue;
  /** 授权（ADR 0011）。不给 = 没装账号体系，一律放行（单测、单机开发）。 */
  readonly access?: AccessPolicy;
  /**
   * 记忆的静态引导（ADR 0019）：新会话第一轮垫一行（不含任何记忆内容），注入要审计。
   * 不给 = 没开记忆工具，不垫。
   */
  readonly memoryGuidance?: MemoryGuidance;
  /**
   * 会话以某个 bot 身份跑时，它的职责说明（系统提示块）。由上下文服务按角色层解析（ADR 0020）；
   * 只在新会话第一句垫一次，续聊 / resume 不再垫。不给 = 不垫。
   */
  readonly sessionInstructions?: (sessionId: string) => Promise<string | null>;
  /** 清理增强（ADR 0027 §3）：规则 / 记录 / PR 状态 / 删检查点。不给 = 只按原规则（任务结束且干净）。 */
  readonly cleanup?: CleanupExtras;
}

export interface CleanupExtras {
  readonly sweeps: WorkspaceSweepStore;
  readonly pullRequests: Pick<PullRequestRepository, 'byWorkspace' | 'byTask'>;
  /** 删工作空间（人点的）时把它会话的检查点 ref 一起删；自动清理只删 checkout，不调它。 */
  readonly dropCheckpoints?: (sessionId: string) => Promise<void>;
}

export interface MemoryGuidance {
  readonly text: string;
  readonly version: number;
  injected(sessionId: SessionId, version: number): Promise<void>;
}

export interface CanvasProjection {
  readonly project: Project;
  readonly workspaces: readonly Workspace[];
  readonly tasks: readonly Task[];
  readonly sessions: readonly Session[];
  readonly artifacts: readonly Artifact[];
  readonly edges: readonly LineageEdge[];
  readonly layout: CanvasLayout;
  readonly agents: readonly AgentDescriptor[];
  /** 每个会话最近的一段事件：关掉浏览器再打开，卡片里得还是那句话。 */
  readonly previews: Readonly<Record<string, readonly JournalEntry[]>>;
  /** 每个会话的第一句提问。列表认人用，不跟 previews 的 24 条尾巴走。 */
  readonly openings: Readonly<Record<string, string>>;
}
