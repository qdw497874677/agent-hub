import type {
  AgentDescriptor,
  Artifact,
  ArtifactRepository,
  CanvasLayout,
  Deps,
  JournalEntry,
  LayoutStore,
  NodeGateway,
  Project,
  ProjectRepository,
  Session,
  SessionHosting,
  SessionQueue,
  SessionRepository,
  SessionStreamFrame,
  Task,
  TaskRepository,
  WorkerCommand,
  WorkspaceFS
} from '../index.ts';
import { ok } from '../index.ts';

/**
 * 用例测试与 HTTP 合同测试共用的内存假件。
 *
 * 放在 domain 里是因为它们只实现 domain 的端口、不碰任何 I/O；
 * 通过 `@agent-hub/domain/testing` 暴露，生产代码不会 import 它。
 */

export function fakeProjects(): ProjectRepository {
  const rows = new Map<string, Project>();
  return {
    async save(project) {
      rows.set(project.id, project);
    },
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async list() {
      return [...rows.values()];
    }
  };
}

export function fakeTasks(shared: Map<string, Task> = new Map()): TaskRepository & { rows: Map<string, Task> } {
  const rows = shared;
  return { rows, ...taskOps(rows) };
}

export function taskOps(rows: Map<string, Task>): TaskRepository {
  return {
    async save(task) {
      rows.set(task.id, task);
    },
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async listByProject(projectId) {
      return [...rows.values()].filter((task) => task.projectId === projectId);
    }
  };
}

export function fakeSessions(tasks: Map<string, Task>): SessionRepository & { journal: Map<string, JournalEntry[]> } {
  const rows = new Map<string, Session>();
  const journal = new Map<string, JournalEntry[]>();
  return {
    journal,
    async save(session) {
      rows.set(session.id, session);
    },
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async listByTask(taskId) {
      return [...rows.values()].filter((session) => session.taskId === taskId);
    },
    async listByProject(projectId) {
      return [...rows.values()].filter((session) => tasks.get(session.taskId)?.projectId === projectId);
    },
    async listAll() {
      return [...rows.values()];
    },
    async append(session, event, at) {
      rows.set(session.id, session);
      const entries = journal.get(session.id) ?? [];
      entries.push({ seq: session.lastSeq, event, at });
      journal.set(session.id, entries);
    },
    async eventsAfter(sessionId, afterSeq) {
      return (journal.get(sessionId) ?? []).filter((entry) => entry.seq > afterSeq);
    },
    async tail(sessionId, limit) {
      return (journal.get(sessionId) ?? []).slice(-limit);
    },
    async linkEntry() {},
    async entryIdAt() {
      return null;
    }
  };
}

export function fakeArtifacts(): ArtifactRepository {
  const rows: Artifact[] = [];
  return {
    async save(artifact) {
      rows.push(artifact);
    },
    async bySession(sessionId) {
      return rows.filter((artifact) => artifact.sessionId === sessionId);
    },
    async byTask(taskId) {
      return rows.filter((artifact) => artifact.taskId === taskId);
    }
  };
}

export function fakeLayout(): LayoutStore {
  const rows = new Map<string, CanvasLayout>();
  return {
    async load(projectId) {
      return rows.get(projectId) ?? null;
    },
    async save(layout) {
      rows.set(layout.projectId, layout);
    }
  };
}

export function fakeFs(): WorkspaceFS {
  return {
    async directoryExists() {
      return true;
    },
    async listDirectories() {
      return [{ name: 'demo', path: '/tmp/demo' }];
    },
    artifactDir(workspaceRoot, sessionId) {
      return `${workspaceRoot}/.agent-hub/artifacts/${sessionId}`;
    },
    async writeFile(_path, content) {
      return ok(content.byteLength);
    },
    async stat() {
      return 128;
    }
  };
}


export function fakeHosting(): SessionHosting & { live: Set<string> } {
  const live = new Set<string>();
  return {
    live,
    has: (id) => live.has(id),
    add: (id) => void live.add(id),
    drop: (id) => void live.delete(id),
    clear: () => live.clear()
  };
}

/** 测试里的队列：直接跑。串行性由 server 的真实实现单独测。 */
export const immediateQueue: SessionQueue = { run: (_id, work) => work() };

export interface InMemoryDeps extends Deps {
  readonly tasks: TaskRepository & { rows: Map<string, Task> };
  readonly sessions: SessionRepository & { journal: Map<string, JournalEntry[]> };
  readonly hosting: SessionHosting & { live: Set<string> };
}

export interface InMemoryWorld {
  readonly deps: InMemoryDeps;
  /** 网关收到的所有指令，按顺序。 */
  readonly dispatched: WorkerCommand[];
  /** 推给界面的所有帧。 */
  readonly frames: SessionStreamFrame[];
  /** 当前在线的 agent；改它就等于 worker 上下线。 */
  readonly agents: AgentDescriptor[];
}

/** 一整套内存 Deps。`overrides` 用来替换某个端口（例如让网关失败）。 */
export function inMemoryDeps(overrides: Partial<Deps> = {}): InMemoryWorld {
  const dispatched: WorkerCommand[] = [];
  const frames: SessionStreamFrame[] = [];
  const agents: AgentDescriptor[] = [];
  const tasks = fakeTasks();
  const gateway: NodeGateway = {
    status: async () => [],
    dispatch: async (command) => {
      dispatched.push(command);
      return ok(undefined);
    }
  };
  let clock = 1_700_000_000_000;
  const deps = {
    projects: fakeProjects(),
    tasks,
    sessions: fakeSessions(tasks.rows),
    artifacts: fakeArtifacts(),
    layout: fakeLayout(),
    stream: { publish: (frame: SessionStreamFrame) => void frames.push(frame), subscribe: () => () => {} },
    gateway,
    agents: {
      list: () => agents,
      descriptor: (id: string) => agents.find((agent) => agent.id === id) ?? null
    },
    fs: fakeFs(),
    capacity: { admit: async () => ok(undefined), release: async () => ok(undefined) },
    provisioner: {
      install: async () => ok(undefined),
      upgrade: async () => ok(undefined),
      revoke: async () => ok(undefined)
    },
    search: { search: async () => [] },
    hosting: fakeHosting(),
    queue: immediateQueue,
    now: () => (clock += 1),
    newId: () => crypto.randomUUID(),
    ...overrides
  } as InMemoryDeps;
  return { deps, dispatched, frames, agents };
}
