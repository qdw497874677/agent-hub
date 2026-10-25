import type {
  WorkerStatus,
  BuildInfo,
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
  WorkspaceFS,
  AccountDeps,
  Login,
  OutgoingEmail,
  User,
  AdminDeps,
  AuditEntry,
  HubSettings,
  LoginActivity
} from '../index.ts';
import { DEFAULT_SETTINGS, ok } from '../index.ts';

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

export function fakeFs(): WorkspaceFS & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async directoryExists() {
      return true;
    },
    async listDirectories() {
      return [{ name: 'demo', path: '/tmp/demo' }];
    },
    async makeDirectory(parent, name) {
      return ok(`${parent.replace(/\/+$/, '')}/${name}`);
    },
    artifactDir(workspaceRoot, sessionId) {
      return `${workspaceRoot}/.agent-hub/artifacts/${sessionId}`;
    },
    async writeFile(path, content) {
      files.set(path, content);
      return ok(content.byteLength);
    },
    async stat() {
      return 128;
    },
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async listFiles(root, limit) {
      const all = [...files.keys()].filter((path) => path.startsWith(`${root}/`)).map((path) => path.slice(root.length + 1));
      return { files: all.slice(0, limit), truncated: all.length > limit };
    }
  };
}


export function fakeHosting(): SessionHosting & { live: Map<string, string | null> } {
  return (() => {
  const live = new Map<string, string | null>();
  return {
    live,
    has: (id: string) => live.has(id),
    add: (id: string, workerId: string | null) => void live.set(id, workerId),
    drop: (id: string) => void live.delete(id),
    dropWorker: (workerId: string) => {
      let dropped = 0;
      for (const [id, owner] of live) {
        if (owner !== null && owner !== workerId) continue;
        live.delete(id);
        dropped += 1;
      }
      return dropped;
    },
    clear: () => live.clear()
  };
})();
}

/** 测试里的队列：直接跑。串行性由 server 的真实实现单独测。 */
export const immediateQueue: SessionQueue = { run: (_id, work) => work() };

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
}

/** 一整套内存 Deps。`overrides` 用来替换某个端口（例如让网关失败）。 */
export function inMemoryDeps(overrides: Partial<Deps> = {}): InMemoryWorld {
  const dispatched: WorkerCommand[] = [];
  const frames: SessionStreamFrame[] = [];
  const agents: AgentDescriptor[] = [];
  const workers: WorkerStatus[] = [{ workerId: 'local', label: '本机', origin: 'local', state: 'online' }];
  const tasks = fakeTasks();
  const gateway: NodeGateway = {
    status: async () => workers,
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
    search: { search: async () => [] },
    hosting: fakeHosting(),
    queue: immediateQueue,
    now: () => (clock += 1),
    ...overrides
  } as InMemoryDeps;
  return { deps, dispatched, frames, agents, workers };
}

// ---- 账号 ----

/** 账号用例的内存假件。哈希用可读的假格式，测试一眼能看出存的不是明文。 */
export function inMemoryAccounts(now: () => number = () => 1_000): AccountDeps & {
  readonly sent: OutgoingEmail[];
  readonly loginRows: Map<string, Login>;
} {
  const users = new Map<string, User>();
  const loginRows = new Map<string, Login>();
  const sent: OutgoingEmail[] = [];
  let settings: HubSettings = DEFAULT_SETTINGS;
  let counter = 0;
  return {
    sent,
    loginRows,
    now,
    users: {
      save: async (user) => void users.set(user.id, user),
      byId: async (id) => users.get(id) ?? null,
      byEmail: async (email) => [...users.values()].find((u) => u.email === email) ?? null,
      firstWithRole: async (role) =>
        [...users.values()]
          .filter((u) => u.role === role && u.disabledAt === null)
          .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null,
      list: async () => [...users.values()]
    },
    logins: {
      save: async (login) => void loginRows.set(login.id, login),
      byTokenHash: async (hash) => [...loginRows.values()].find((l) => l.tokenHash === hash) ?? null,
      touch: async (id, lastSeenAt, expiresAt) => {
        const row = loginRows.get(id);
        if (row) loginRows.set(id, { ...row, lastSeenAt, expiresAt });
      },
      remove: async (id) => void loginRows.delete(id),
      removeForUser: async (userId, keep) => {
        for (const [id, row] of loginRows) if (row.userId === userId && id !== keep) loginRows.delete(id);
      },
      recent: async (limit) => [...loginRows.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit),
      activity: async (at) => {
        const rows = new Map<string, LoginActivity>();
        for (const login of loginRows.values()) {
          const row = rows.get(login.userId);
          rows.set(login.userId, {
            userId: login.userId,
            lastSeenAt: Math.max(row?.lastSeenAt ?? 0, login.lastSeenAt),
            active: (row?.active ?? 0) + (login.expiresAt > at ? 1 : 0)
          });
        }
        return [...rows.values()];
      }
    },
    hasher: {
      hash: async (password) => `fake$${[...password].reverse().join('')}`,
      verify: async (password, hash) => hash === `fake$${[...password].reverse().join('')}`
    },
    tokens: {
      issue: () => {
        const token = `tok-${++counter}`;
        return { token, hash: `h(${token})` };
      },
      hashOf: (token) => `h(${token})`
    },
    mail: { send: async (email) => void sent.push(email) },
    settings: {
      get: async () => settings,
      save: async (next) => void (settings = next)
    }
  };
}

/** 运营后台用：账号 + 审计 + 可控的机器列表。 */
export function inMemoryAdmin(now: () => number = () => 1_000) {
  const accounts = inMemoryAccounts(now);
  const entries: AuditEntry[] = [];
  const workerList: WorkerStatus[] = [];
  const disconnected: string[] = [];
  const updates: { id: string; commit: string }[] = [];
  const hubBuild: BuildInfo = { version: '0.0.0', commit: 'a'.repeat(40), protocol: 1 };
  const sessionList: Session[] = [];
  const deps: AdminDeps = {
    users: accounts.users,
    logins: accounts.logins,
    settings: accounts.settings,
    now,
    audit: {
      append: async (entry) => void entries.unshift(entry),
      recent: async (limit) => entries.slice(0, limit)
    },
    workers: {
      list: async () => workerList,
      disconnect: async (id) => {
        const worker = workerList.find((w) => w.workerId === id && w.state === 'online');
        if (worker) disconnected.push(id);
        return worker !== undefined;
      },
      hubBuild: () => hubBuild,
      update: async (id, commit) => {
        const worker = workerList.find((w) => w.workerId === id && w.state === 'online');
        if (worker) updates.push({ id, commit });
        return worker !== undefined;
      }
    },
    sessions: { listAll: async () => sessionList }
  };
  return { accounts, deps, entries, workerList, disconnected, updates, sessionList };
}
