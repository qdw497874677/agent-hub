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
}

/**
 * 用例能碰到的全部端口。**用例签名一律写 `Pick<Deps, …>`**，只声明自己真用到的那几个，
 * 依赖一眼可见、测试替身也只需造这几个。全量 `Deps` 只出现在组合根（server/main.ts）。
 *
 * CapacityPolicy / NodeProvisioner 仍是已定义的端口（见 ports/），但当前没有用例消费它们，
 * 所以不进 Deps——等调度/下发真的落地时再接进来，不提前养空实现。
 */
export interface Deps {
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
  readonly search: SearchGateway;
  /** 哪些会话此刻有 worker 托管；不在就得先 resume 再说话。 */
  readonly hosting: SessionHosting;
  /** 同一会话的写入串行（ADR 0004）。 */
  readonly queue: SessionQueue;
  readonly now: () => number;
}

export interface CanvasProjection {
  readonly project: Project;
  readonly tasks: readonly Task[];
  readonly sessions: readonly Session[];
  readonly artifacts: readonly Artifact[];
  readonly edges: readonly LineageEdge[];
  readonly layout: CanvasLayout;
  readonly agents: readonly AgentDescriptor[];
  /** 每个会话最近的一段事件：关掉浏览器再打开，卡片里得还是那句话。 */
  readonly previews: Readonly<Record<string, readonly JournalEntry[]>>;
}
