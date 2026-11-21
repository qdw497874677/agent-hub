import type {
  AgentDescriptor,
  Deps,
  JournalEntry,
  NodeGateway,
  SessionHosting,
  SessionRepository,
  SessionStreamFrame,
  Task,
  TaskRepository,
  WorkerCommand,
  WorkerStatus
} from '../../index.ts';
import { ok } from '../../index.ts';
import {
  fakeArtifacts,
  fakeBots,
  fakeFs,
  fakeLayout,
  fakeProjects,
  fakeSecrets,
  fakeSessions,
  fakeTasks,
  fakeWorkLog,
  fakeWorkspaceGroups,
  fakeWorkspaces
} from './repos.ts';
import { fakeGit, fakeHosting, immediateQueue, type FakeGit } from './runtime.ts';

/** `InMemoryWorld` 组装与 `inMemoryDeps(overrides)`。 */

export interface InMemoryDeps extends Deps {
  readonly tasks: TaskRepository & { rows: Map<string, Task> };
  readonly sessions: SessionRepository & { journal: Map<string, JournalEntry[]> };
  readonly hosting: SessionHosting & { live: Map<string, string | null> };
}

export interface InMemoryWorld {
  readonly deps: InMemoryDeps;
  /** 网关收到的所有指令，按顺序。 */
  readonly dispatched: WorkerCommand[];
  /** 推给界面的所有帧。 */
  readonly frames: SessionStreamFrame[];
  /** 当前在线的 agent；改它就等于 worker 上下线。 */
  readonly agents: AgentDescriptor[];
  /** 网关报的 Worker 列表；改它就等于 Worker 上下线。默认一台装了全部 agent 的本机。 */
  readonly workers: WorkerStatus[];
  /** 假 git：记下调用，状态可改（清理测试用）。本机和远端共用一份，调用里带上是哪台。 */
  readonly git: FakeGit;
}

/** 一整套内存 Deps。`overrides` 用来替换某个端口（例如让网关失败）。 */
export function inMemoryDeps(overrides: Partial<Deps> = {}): InMemoryWorld {
  const dispatched: WorkerCommand[] = [];
  const frames: SessionStreamFrame[] = [];
  const agents: AgentDescriptor[] = [];
  const workers: WorkerStatus[] = [{ workerId: 'local', label: '本机', origin: 'local', state: 'online' }];
  const tasks = fakeTasks();
  const workspaces = fakeWorkspaces();
  const git = fakeGit();
  const gateway: NodeGateway = {
    git: (workerId) => git.on(workerId),
    status: async () => workers,
    probe: async (workerId) => workers.some((worker) => worker.workerId === workerId && worker.state === 'online'),
    listDirectories: async (_workerId, path) => ok({ path: path || '/home/remote', exists: true, entries: [] }),
    makeDirectory: async (_workerId, parent, name) => ok({ path: `${parent}/${name}` }),
    // 远程机器上的文件：经网关问那台 Worker（测试里固定一份清单）
    listFiles: async (workerId) => ok({ files: [`on-${workerId}.ts`, 'src/remote.ts'], truncated: false }),
    readFile: async (workerId, path) => ok(path.includes('/.agent-hub/attachments/') ? new TextEncoder().encode(`${workerId}:${path}`) : null),
    dispatch: async (command) => {
      dispatched.push(command);
      return ok(undefined);
    }
  };
  let clock = 1_700_000_000_000;
  const deps = {
    projects: fakeProjects(workspaces),
    tasks,
    workLog: fakeWorkLog(),
    sessions: fakeSessions(tasks.rows),
    workspaces,
    workspaceGroups: fakeWorkspaceGroups(),
    artifacts: fakeArtifacts(),
    layout: fakeLayout(),
    bots: fakeBots(),
    stream: { publish: (frame: SessionStreamFrame) => void frames.push(frame), subscribe: () => () => {} },
    gateway,
    agents: {
      list: () => agents,
      descriptor: (id: string) => agents.find((agent) => agent.id === id) ?? null
    },
    fs: fakeFs(),
    git: git.on('local'),
    secrets: fakeSecrets(),
    search: { search: async () => [] },
    hosting: fakeHosting(),
    queue: immediateQueue,
    now: () => (clock += 1),
    ...overrides
  } as InMemoryDeps;
  return { deps, dispatched, frames, agents, workers, git };
}
