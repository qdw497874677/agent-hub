import type { WorkLogRepository } from '../ports/work-log-repository.ts';
import type { WorkLogEntry } from '../work-log.ts';
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
  Workspace,
  WorkspaceRepository,
  AccountDeps,
  Login,
  OutgoingEmail,
  User,
  AdminDeps,
  AuditEntry,
  HubSettings,
  LoginActivity
} from '../index.ts';
import { DEFAULT_SETTINGS, err, ok, unavailable } from '../index.ts';
import type { GitStatus, WorkspaceGit } from '../index.ts';

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
    },
    async remove(id) {
      rows.delete(id);
    }
  };
}

export function fakeWorkspaces(): WorkspaceRepository & { rows: Map<string, Workspace> } {
  const rows = new Map<string, Workspace>();
  const all = () => [...rows.values()].sort((a, b) => a.createdAt - b.createdAt);
  return {
    rows,
    async save(workspace) {
      rows.set(workspace.id, workspace);
    },
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async byProject(projectId) {
      return all().filter((w) => w.projectId === projectId);
    },
    async byTask(taskId) {
      return all().filter((w) => w.ownerTaskId === taskId);
    },
    async temporaries() {
      return all().filter((w) => w.kind === 'temporary' && w.state !== 'removed');
    },
    async onMachine(workerId) {
      return all().filter((w) => w.workerId === workerId && w.state !== 'removed');
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

export function fakeWorkLog(): WorkLogRepository & { rows: WorkLogEntry[] } {
  const rows: WorkLogEntry[] = [];
  return {
    rows,
    async append(draft) {
      const seq = rows.filter((row) => row.taskId === draft.taskId).reduce((max, row) => Math.max(max, row.seq), 0) + 1;
      const entry: WorkLogEntry = { ...draft, seq, supersededBy: null };
      rows.push(entry);
      if (draft.supersedes) {
        const index = rows.findIndex((row) => row.id === draft.supersedes);
        if (index >= 0) rows[index] = { ...rows[index]!, supersededBy: entry.id };
      }
      return entry;
    },
    async byId(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async list(taskId, query) {
      return rows
        .filter((row) => row.taskId === taskId)
        .filter((row) => query.includeSuperseded || !row.supersededBy)
        .filter((row) => query.beforeSeq === undefined || row.seq < query.beforeSeq)
        .filter((row) => !query.excludeSystem || row.author.kind !== 'system')
        .sort((a, b) => b.seq - a.seq)
        .slice(0, query.limit);
    },
    async latestNote(taskId) {
      return (await this.list(taskId, { limit: 1, excludeSystem: true }))[0] ?? null;
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
  /** 假 git：记下调用，状态可改（清理测试用）。本机和远端共用一份，调用里带上是哪台。 */
  readonly git: FakeGit;
}

export interface FakeGit {
  /** 「机器:动作:路径」，机器 local = Server 本机。 */
  readonly calls: string[];
  /** 路径 → 状态；没登记的当成干净的 git 目录。 */
  readonly statuses: Map<string, GitStatus>;
  /** 这些路径 inspect 出来是 git 仓库（带 origin）。 */
  readonly repos: Set<string>;
  /** 下一次 clone / addWorktree 失败的原因。 */
  failNext: string | null;
  on(machine: string): WorkspaceGit;
}

export function fakeGit(): FakeGit {
  const calls: string[] = [];
  const statuses = new Map<string, GitStatus>();
  const repos = new Set<string>();
  const state: FakeGit = {
    calls,
    statuses,
    repos,
    failNext: null,
    on(machine) {
      const fail = () => {
        const reason = state.failNext;
        state.failNext = null;
        return reason;
      };
      const statusOf = (path: string): GitStatus =>
        statuses.get(path) ?? { dirty: false, untracked: 0, unpushed: 0, branch: 'main', upstream: null };
      return {
        inspect: async (path) => {
          calls.push(`${machine}:inspect:${path}`);
          const isGit = repos.has(path);
          return ok({ exists: true, isGit, remoteUrl: isGit ? 'https://example.com/demo.git' : null, branch: isGit ? 'main' : null });
        },
        clone: async (input) => {
          calls.push(`${machine}:clone:${input.repoUrl}->${input.parent}/${input.name}`);
          const reason = fail();
          if (reason) return err(unavailable(reason));
          repos.add(`${input.parent}/${input.name}`);
          return ok({ path: `${input.parent}/${input.name}`, branch: input.branch ?? 'main' });
        },
        addWorktree: async (input) => {
          calls.push(`${machine}:worktree:${input.repoPath}->${input.path}@${input.branch}`);
          const reason = fail();
          if (reason) return err(unavailable(reason));
          return ok({ path: input.path, branch: input.branch });
        },
        status: async (path) => {
          calls.push(`${machine}:status:${path}`);
          return ok(statusOf(path));
        },
        remove: async (path, kind) => {
          calls.push(`${machine}:remove:${kind}:${path}`);
          const status = statusOf(path);
          if (status.dirty || status.untracked > 0 || status.unpushed > 0) return ok({ removed: false, reason: '有未保存的改动' });
          return ok({ removed: true });
        }
      };
    }
  };
  return state;
}

/** 一整套内存 Deps。`overrides` 用来替换某个端口（例如让网关失败）。 */
export function inMemoryDeps(overrides: Partial<Deps> = {}): InMemoryWorld {
  const dispatched: WorkerCommand[] = [];
  const frames: SessionStreamFrame[] = [];
  const agents: AgentDescriptor[] = [];
  const workers: WorkerStatus[] = [{ workerId: 'local', label: '本机', origin: 'local', state: 'online' }];
  const tasks = fakeTasks();
  const git = fakeGit();
  const gateway: NodeGateway = {
    git: (workerId) => git.on(workerId),
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
    workLog: fakeWorkLog(),
    sessions: fakeSessions(tasks.rows),
    workspaces: fakeWorkspaces(),
    artifacts: fakeArtifacts(),
    layout: fakeLayout(),
    stream: { publish: (frame: SessionStreamFrame) => void frames.push(frame), subscribe: () => () => {} },
    gateway,
    agents: {
      list: () => agents,
      descriptor: (id: string) => agents.find((agent) => agent.id === id) ?? null
    },
    fs: fakeFs(),
    git: git.on('local'),
    search: { search: async () => [] },
    hosting: fakeHosting(),
    queue: immediateQueue,
    now: () => (clock += 1),
    ...overrides
  } as InMemoryDeps;
  return { deps, dispatched, frames, agents, workers, git };
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
      claimFirstOwner: async (user) => {
        if ([...users.values()].some((u) => u.role === 'owner' && u.disabledAt === null)) return false;
        users.set(user.id, { ...user, role: 'owner' });
        return true;
      },
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

export function fakeToolGrants(): import('../ports/tool-grant-repository.ts').ToolGrantRepository & {
  grants: import('../tool.ts').ToolGrant[];
  calls: import('../tool.ts').ToolCallRecord[];
} {
  type Grant = import('../tool.ts').ToolGrant;
  const grants: Grant[] = [];
  const calls: import('../tool.ts').ToolCallRecord[] = [];
  return {
    grants,
    calls,
    async save(grant) {
      const at = grants.findIndex((row) => row.id === grant.id);
      if (at >= 0) grants[at] = grant;
      else grants.push(grant);
    },
    async byTokenHash(hash) {
      return grants.find((row) => row.tokenHash === hash) ?? null;
    },
    async revokeAllExcept(keep, now) {
      let count = 0;
      grants.forEach((row, index) => {
        if (!keep.includes(row.sessionId) && row.revokedAt === null) {
          grants[index] = { ...row, revokedAt: now };
          count += 1;
        }
      });
      return count;
    },
    async revokeSession(sessionId, now) {
      let count = 0;
      grants.forEach((row, index) => {
        if (row.sessionId === sessionId && row.revokedAt === null) {
          grants[index] = { ...row, revokedAt: now };
          count += 1;
        }
      });
      return count;
    },
    async recordCall(record) {
      calls.push(record);
    },
    async recentCalls(limit, sessionId) {
      return calls.filter((row) => !sessionId || row.sessionId === sessionId).slice(-limit).reverse();
    }
  };
}

/** 单台机器接入的内存实现：和 inMemoryAdmin 共用用户、设置、审计和机器列表。 */
export function inMemoryEnrollment(admin: ReturnType<typeof inMemoryAdmin>, now: () => number = () => 1_000) {
  type PairingCode = import('../enrollment.ts').PairingCode;
  type WorkerCredential = import('../enrollment.ts').WorkerCredential;
  const pairings = new Map<string, PairingCode>();
  const credentials = new Map<string, WorkerCredential>();
  let seq = 0;
  const enrollment: import('../ports/enrollment-repository.ts').EnrollmentRepository = {
    savePairing: async (code) => void pairings.set(code.hash, code),
    pairingByHash: async (hash) => pairings.get(hash) ?? null,
    consumePairing: async (hash, workerId, at) => {
      const code = pairings.get(hash);
      if (!code || code.usedAt !== null) return false;
      pairings.set(hash, { ...code, usedAt: at, workerId });
      return true;
    },
    saveCredential: async (credential) => void credentials.set(credential.workerId, credential),
    credentialByHash: async (hash) => [...credentials.values()].find((c) => c.tokenHash === hash) ?? null,
    credentialFor: async (workerId) => credentials.get(workerId) ?? null,
    listCredentials: async () => [...credentials.values()],
    revoke: async (workerId, at) => {
      const found = credentials.get(workerId);
      if (found && found.revokedAt === null) credentials.set(workerId, { ...found, revokedAt: at });
    }
  };
  const deps: import('../use-cases/enrollment.ts').EnrollmentDeps = {
    enrollment,
    tokens: admin.accounts.tokens,
    settings: admin.deps.settings,
    users: admin.deps.users,
    audit: admin.deps.audit,
    workers: admin.deps.workers,
    now,
    newWorkerId: () => `remote-${++seq}`
  };
  return { deps, pairings, credentials };
}
