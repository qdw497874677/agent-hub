import type { AgentId } from '../ids.ts';
import type { Task } from '../task.ts';
import type { Session } from '../session.ts';
import type { Artifact } from '../artifact.ts';
import type { AgentDescriptor } from '../agent.ts';
import type { CanvasLayout, LineageEdge } from '../canvas.ts';
import type { Project } from '../project.ts';
import type { ProjectRepository } from '../ports/project-repository.ts';
import type { TaskRepository } from '../ports/task-repository.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import type { ArtifactRepository } from '../ports/artifact-repository.ts';
import type { LayoutStore } from '../ports/layout-store.ts';
import type { SessionEventStream } from '../ports/event-stream.ts';
import type { NodeGateway } from '../ports/node-gateway.ts';
import type { AgentRuntime } from '../ports/agent-runtime.ts';
import type { WorkspaceFS } from '../ports/workspace-fs.ts';
import type { CapacityPolicy } from '../ports/capacity-policy.ts';
import type { NodeProvisioner } from '../ports/node-provisioner.ts';

/** 已装配的 agent。UI 只从这里拿能力矩阵，不认 agent 名字。 */
export interface AgentCatalog {
  list(): readonly AgentDescriptor[];
  runtime(id: AgentId): AgentRuntime | null;
}

export interface Deps {
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly sessions: SessionRepository;
  readonly artifacts: ArtifactRepository;
  readonly layout: LayoutStore;
  readonly stream: SessionEventStream;
  readonly gateway: NodeGateway;
  readonly agents: AgentCatalog;
  readonly fs: WorkspaceFS;
  readonly capacity: CapacityPolicy;
  readonly provisioner: NodeProvisioner;
  readonly now: () => number;
  readonly newId: () => string;
}

export interface CanvasProjection {
  readonly project: Project;
  readonly tasks: readonly Task[];
  readonly sessions: readonly Session[];
  readonly artifacts: readonly Artifact[];
  readonly edges: readonly LineageEdge[];
  readonly layout: CanvasLayout;
  readonly agents: readonly AgentDescriptor[];
}
