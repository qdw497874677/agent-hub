import * as assetModule from '../asset.ts';
import type { ApiToken } from '../api-token.ts';
import type { ApiTokenRepository } from '../ports/api-token-repository.ts';
import type { AccessGrantRepository, TeamRoleRepository } from '../ports/access-repository.ts';
import { accessGrantActive, type AccessGrant, type CustomRole } from '../access.ts';
import { matchesAudit } from '../ports/audit-log.ts';
import { seedAccount } from '../use-cases/accounts.ts';
import { createAccessPolicy as createAccessPolicyForTests } from '../use-cases/authorization.ts';
import { invitePending } from '../account.ts';
import type { Invite } from '../account.ts';
import type { InviteRepository } from '../ports/invite-repository.ts';
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
  AccountMail,
  OneTimeToken,
  User,
  AdminDeps,
  AuditEntry,
  HubSettings,
  Team,
  LoginActivity
} from '../index.ts';
import { DEFAULT_SETTINGS, err, ok, unavailable } from '../index.ts';
import type { GitStatus, WorkspaceGit } from '../index.ts';
import type { RuntimeJob } from '../runtime-install.ts';

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
      return [...rows.values()].filter((p) => p.deletedAt === null);
    },
    async listDeleted() {
      return [...rows.values()].filter((p) => p.deletedAt !== null);
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
          calls.push(`${machine}:worktree:${input.repoPath}->${input.path}@${input.branch}${input.existing ? ':existing' : ''}${input.base ? `<${input.base}` : ''}`);
          const reason = fail();
          if (reason) return err(unavailable(reason));
          return ok({ path: input.path, branch: input.branch });
        },
        status: async (path) => {
          calls.push(`${machine}:status:${path}`);
          const reason = fail();
          if (reason) return err(unavailable(reason));
          return ok(statusOf(path));
        },
        saveWip: async (path, message) => {
          calls.push(`${machine}:save_wip:${path}:${message}`);
          const reason = fail();
          if (reason) return err(unavailable(reason));
          const status = statusOf(path);
          const committed = Boolean(status.dirty) || status.untracked > 0;
          statuses.set(path, { ...status, dirty: false, untracked: 0, unpushed: 0, upstream: `origin/${status.branch}` });
          return ok({ committed, pushed: true, branch: status.branch, reason: null });
        },
        remove: async (path, kind, options) => {
          calls.push(`${machine}:remove:${kind}:${path}${options?.force ? ':force' : ''}`);
          if (options?.force) return ok({ removed: true });
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
  readonly sent: AccountMail[];
  readonly loginRows: Map<string, Login>;
  readonly oneTimeRows: Map<string, OneTimeToken>;
  readonly teamRows: Map<string, Team>;
  readonly inviteRows: Map<string, Invite>;
  readonly auditRows: AuditEntry[];
  readonly invites: InviteRepository;
} {
  const users = new Map<string, User>();
  const loginRows = new Map<string, Login>();
  const sent: AccountMail[] = [];
  const oneTimeRows = new Map<string, OneTimeToken>();
  const teamRows = new Map<string, Team>();
  let settings: HubSettings = DEFAULT_SETTINGS;
  let counter = 0;
  const inviteRows = new Map<string, Invite>();
  const auditRows: AuditEntry[] = [];
  return {
    sent,
    inviteRows,
    auditRows,
    audit: {
      append: async (entry) => void auditRows.unshift(entry),
      recent: async (limit) => auditRows.slice(0, limit),
      query: async (filter) => auditRows.filter((row) => matchesAudit(row, filter)).slice(0, filter.limit)
    },
    invites: {
      save: async (invite) => void inviteRows.set(invite.id, invite),
      byId: async (id) => inviteRows.get(id) ?? null,
      byTokenHash: async (hash) => [...inviteRows.values()].find((row) => row.tokenHash === hash) ?? null,
      forTeam: async (teamId) => [...inviteRows.values()].filter((row) => row.teamId === teamId).sort((a, b) => b.createdAt - a.createdAt),
      pending: async (at) => [...inviteRows.values()].filter((row) => invitePending(row, at)),
      accept: async (hash, at) => {
        const row = [...inviteRows.values()].find((candidate) => candidate.tokenHash === hash);
        if (!row || !invitePending(row, at)) return null;
        const used = { ...row, acceptedAt: at };
        inviteRows.set(row.id, used);
        return used;
      }
    },
    loginRows,
    oneTimeRows,
    now,
    teamRows,
    teams: {
      save: async (team) => void teamRows.set(team.id, team),
      byId: async (id) => teamRows.get(id) ?? null,
      list: async () => [...teamRows.values()]
    },
    oneTimeTokens: {
      save: async (token) => void oneTimeRows.set(token.tokenHash, token),
      consume: async (hash, purpose, at) => {
        const row = oneTimeRows.get(hash);
        if (!row || row.purpose !== purpose || row.usedAt !== null || row.expiresAt <= at) return null;
        const used = { ...row, usedAt: at };
        oneTimeRows.set(hash, used);
        return used;
      },
      revokeForUser: async (userId, purpose, at) => {
        for (const [hash, row] of oneTimeRows) {
          if (row.userId === userId && row.purpose === purpose && row.usedAt === null) oneTimeRows.set(hash, { ...row, usedAt: at });
        }
      }
    },
    users: {
      save: async (user) => void users.set(user.id, user),
      byId: async (id) => users.get(id) ?? null,
      byEmail: async (email) => [...users.values()].find((u) => u.email === email) ?? null,
      firstWithRole: async (role) =>
        [...users.values()]
          .filter((u) => u.role === role && u.disabledAt === null)
          .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null,
      claimFirstOwner: async (user) => {
        if ([...users.values()].some((u) => u.clusterAdmin && u.disabledAt === null && u.deletedAt === null)) return false;
        users.set(user.id, { ...user, role: 'owner', clusterAdmin: true });
        return true;
      },
      firstClusterAdmin: async () =>
        [...users.values()].filter((u) => u.clusterAdmin && u.deletedAt === null).sort((a, b) => a.createdAt - b.createdAt)[0] ?? null,
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
      forUser: async (userId) =>
        [...loginRows.values()].filter((l) => l.userId === userId).sort((a, b) => b.lastSeenAt - a.lastSeenAt),
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
  const runtimeJobs: { id: string; job: RuntimeJob }[] = [];
  const hubBuild: BuildInfo = { version: '0.0.0', commit: 'a'.repeat(40), protocol: 1 };
  const sessionList: Session[] = [];
  const deps: AdminDeps = {
    users: accounts.users,
    logins: accounts.logins,
    settings: accounts.settings,
    now,
    audit: {
      append: async (entry) => void entries.unshift(entry),
      recent: async (limit) => entries.slice(0, limit),
      query: async (filter) => entries.filter((row) => matchesAudit(row, filter)).slice(0, filter.limit)
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
      },
      runtimeJob: async (id, job) => {
        const worker = workerList.find((w) => w.workerId === id && w.state === 'online');
        if (worker) runtimeJobs.push({ id, job });
        return worker !== undefined;
      }
    },
    sessions: { listAll: async () => sessionList }
  };
  return { accounts, deps, entries, workerList, disconnected, updates, runtimeJobs, sessionList };
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

/** 资产审核仓库 + 通知的内存实现。 */
export function inMemoryAssetReview(): {
  review: import('../ports/asset-review-repository.ts').AssetReviewRepository;
  notifications: import('../ports/asset-review-repository.ts').NotificationRepository & { rows: import('../asset-review.ts').Notification[] };
} {
  type S = import('../asset-review.ts').AssetSubmission;
  type I = import('../asset-review.ts').InstallRequest;
  const subs: S[] = [];
  const comments: import('../asset-review.ts').ReviewComment[] = [];
  const requests: I[] = [];
  const settings = new Map<string, import('../asset-review.ts').AssetReviewSettings>();
  const rows: import('../asset-review.ts').Notification[] = [];
  return {
    review: {
      addSubmission: async (sub) => void subs.unshift(sub),
      updateSubmission: async (sub) => {
        const at = subs.findIndex((row) => row.id === sub.id);
        if (at >= 0) subs[at] = sub;
      },
      submission: async (id) => subs.find((row) => row.id === id) ?? null,
      submissions: async ({ assetId, status }) =>
        subs.filter((row) => (!assetId || row.assetId === assetId) && (!status || status.includes(row.status))).sort((a, b) => b.createdAt - a.createdAt),
      addComment: async (comment) => void comments.push(comment),
      comments: async (id) => comments.filter((row) => row.submissionId === id),
      addInstallRequest: async (request) => void requests.unshift(request),
      updateInstallRequest: async (request) => {
        const at = requests.findIndex((row) => row.id === request.id);
        if (at >= 0) requests[at] = request;
      },
      installRequest: async (id) => requests.find((row) => row.id === id) ?? null,
      installRequests: async ({ status, workerId, assetId }) =>
        requests.filter((row) => (!status || row.status === status) && (!workerId || row.workerId === workerId) && (!assetId || row.assetId === assetId)),
      settings: async (key) => settings.get(key) ?? null,
      setSettings: async (key, value) => void settings.set(key, value)
    },
    notifications: {
      rows,
      add: async (note) => void rows.unshift(note),
      list: async (userId, limit) => rows.filter((row) => row.userId === userId).slice(0, limit),
      unread: async (userId) => rows.filter((row) => row.userId === userId && row.readAt === null).length,
      markRead: async (userId, ids, at) => {
        rows.forEach((row, index) => {
          if (row.userId === userId && row.readAt === null && (ids === null || ids.includes(row.id))) rows[index] = { ...row, readAt: at };
        });
      }
    }
  };
}

/** 资产中心的内存实现：仓库、同步看板、可编程的投递和读取器。 */
export function inMemoryAssets(now: () => number = () => 1_000) {
  const { assetScopeRef } = assetModule;
  type A = import('../asset.ts').Asset;
  type R = import('../asset.ts').AssetRevision;
  const assets = new Map<string, A>();
  const revisions = new Map<string, R[]>();
  const blobs = new Map<string, Uint8Array>();
  const installs: { workerId: string; assetId: string }[] = [];
  const projectSettings = new Map<string, Record<string, boolean>>();
  const sessionManifests = new Map<string, import('../asset.ts').SessionAssetManifest>();
  const projectList = new Map<string, { id: string; name: string }>([['p1', { id: 'p1', name: 'demo' }]]);
  const repo: import('../ports/asset-repository.ts').AssetRepository = {
    list: async () => [...assets.values()],
    get: async (id) => assets.get(id) ?? null,
    byName: async (kind, name, projectId) =>
      [...assets.values()].find((a) => a.kind === kind && a.name === name && a.projectId === projectId && (a.scope === 'global' || a.scope === 'project')) ?? null,
    findInScope: async (kind, name, scope, ref) =>
      [...assets.values()].find((a) => a.kind === kind && a.name === name && a.scope === scope && assetScopeRef(a) === ref) ?? null,
    create: async (asset, revision, data) => {
      assets.set(asset.id, asset);
      revisions.set(asset.id, [revision]);
      for (const [k, v] of data) blobs.set(k, v);
    },
    addRevision: async (revision, data) => {
      const list = revisions.get(revision.assetId) ?? [];
      if (!list.some((r) => r.digest === revision.digest)) revisions.set(revision.assetId, [revision, ...list]);
      for (const [k, v] of data) blobs.set(k, v);
    },
    revisions: async (id) => revisions.get(id) ?? [],
    revision: async (id, digest) => (revisions.get(id) ?? []).find((r) => r.digest === digest) ?? null,
    update: async (asset) => void assets.set(asset.id, asset),
    remove: async (id) => {
      assets.delete(id);
      revisions.delete(id);
      for (let i = installs.length - 1; i >= 0; i--) if (installs[i]?.assetId === id) installs.splice(i, 1);
    },
    blob: async (sha) => blobs.get(sha) ?? null,
    installations: async () => [...installs],
    install: async (workerId, assetId) => {
      if (!installs.some((row) => row.workerId === workerId && row.assetId === assetId)) installs.push({ workerId, assetId });
    },
    uninstall: async (workerId, assetId) => {
      const at = installs.findIndex((row) => row.workerId === workerId && row.assetId === assetId);
      if (at >= 0) installs.splice(at, 1);
    },
    projectSettings: async (projectId) => ({ ...(projectSettings.get(projectId) ?? {}) }),
    setProjectSetting: async (projectId, assetId, enabled) => {
      const next = { ...(projectSettings.get(projectId) ?? {}) };
      if (enabled === null) delete next[assetId];
      else next[assetId] = enabled;
      projectSettings.set(projectId, next);
    },
    recordSessionAssets: async (manifest) => {
      sessionManifests.set(manifest.sessionId, manifest);
    },
    sessionAssets: async (sessionId) => sessionManifests.get(sessionId) ?? null
  };
  const board = new Map<string, import('../asset.ts').WorkerAssetSync>();
  const pushes: { workerId: string; manifest: readonly import('../asset.ts').AssetManifestEntry[] }[] = [];
  const workers: WorkerStatus[] = [{ workerId: 'w1', label: 'local', origin: 'local', state: 'online' }];
  const git = { commit: 'c1', files: [] as import('../asset.ts').IncomingFile[] };
  const decode = (data: Uint8Array): string => new TextDecoder().decode(data);
  const secretStore = new Map<string, { value: string; at: number }>();
  const deps: import('../use-cases/assets.ts').AssetDeps = {
    assets: repo,
    now,
    secrets: {
      list: async () => [...secretStore.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, { at }]) => ({ name, updatedAt: at })),
      put: async (name, value, at) => void secretStore.set(name, { value, at }),
      remove: async (name) => secretStore.delete(name),
      reveal: async (names) => Object.fromEntries(names.flatMap((name) => (secretStore.has(name) ? [[name, secretStore.get(name)!.value]] : [])))
    },
    board: { get: (id) => board.get(id) ?? null, set: (s) => void board.set(s.workerId, s), all: () => [...board.values()] },
    workers: { list: async () => workers },
    projects: { byId: async (id) => projectList.get(id) ?? null },
    delivery: {
      push: async (workerId, manifest) => {
        pushes.push({ workerId, manifest });
        return { ok: true, value: { root: '/home/x/.agent-hub/assets', installed: Object.fromEntries(manifest.map((m) => [m.assetId, m.digest])) } };
      }
    },
    reader: {
      // 极简 frontmatter：只认 `name:` / `description:` 两行。
      describe: (kind, files) => {
        const main = kind === 'skill' ? files.find((f) => f.path === 'SKILL.md') : files[0];
        const text = main ? decode(main.data) : '';
        const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim() ?? null;
        return { ok: true, value: { name: kind === 'skill' ? field('name') : null, description: field('description') ?? '' } };
      },
      scanGit: async () => ({ ok: true, value: { commit: git.commit, candidates: [] } }),
      readGit: async () => ({ ok: true, value: { commit: git.commit, files: git.files } }),
      diffText: (path, before, after) => `--- ${path}\n-${before}\n+${after}`
    }
  };
  return { deps, board, pushes, workers, git, installs, blobs, projectList };
}

/** 测试用：从「已发出的信」里取某人最新的验证 / 重置令牌（相当于去邮箱点链接）。 */
export function mailedToken(accounts: { readonly sent: readonly AccountMail[] }, email: string, kind: 'verify-email' | 'reset-password' | 'invite' = 'verify-email'): string {
  const mail = [...accounts.sent].reverse().find((m) => m.to === email && m.kind === kind);
  if (!mail || !('token' in mail)) throw new Error(`没给 ${email} 发过 ${kind}`);
  return mail.token;
}

/**
 * 测试用：把一个人直接加进 hub 管理员的团队（已验证邮箱）。
 * 开放注册默认关闭、自助注册的人拿的是自己的团队（ADR 0011），所以「同团队的成员」要这样造；邀请流程上线后也能走邀请。
 */
export async function addTeamMember(
  accounts: Parameters<typeof seedAccount>[0],
  email: string,
  password: string,
  role: 'owner' | 'member' = 'member'
): Promise<void> {
  const made = await seedAccount(accounts, { email, password, role, displayName: email.split('@')[0] ?? email });
  if (!made.ok) throw new Error(made.error.message);
}

/** 开放 API 令牌的内存仓库（ADR 0015）。 */
export function inMemoryApiTokens(): ApiTokenRepository & { readonly rows: Map<string, ApiToken> } {
  const rows = new Map<string, ApiToken>();
  return {
    rows,
    save: async (token) => void rows.set(token.id, token),
    byId: async (id) => rows.get(id) ?? null,
    byHash: async (hash) => [...rows.values()].find((row) => row.tokenHash === hash) ?? null,
    listByTeam: async (teamId) => [...rows.values()].filter((row) => row.teamId === teamId),
    touch: async (id, at) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, lastUsedAt: at });
    }
  };
}

/**
 * 测试用：资产审核（ADR 0016）的整套依赖 = 资产假件 + 账号 / 审计（inMemoryAdmin）+ 审核仓库 + 授权策略。
 * enrolledBy：远端机器 → 接入它的人（决定机器属于谁的团队、算不算「自己的机器」）。
 */
export function inMemoryAssetReviewDeps(
  admin: ReturnType<typeof inMemoryAdmin>,
  assets: ReturnType<typeof inMemoryAssets>,
  enrolledBy: Map<string, string> = new Map()
): { deps: import('../use-cases/asset-review.ts').AssetReviewDeps; notifications: ReturnType<typeof inMemoryAssetReview>['notifications'] } {
  const { review, notifications } = inMemoryAssetReview();
  const users = admin.accounts.users;
  const policy = createAccessPolicyForTests({
    users,
    settings: admin.accounts.settings,
    enrollment: { credentialFor: async (workerId) => (enrolledBy.has(workerId) ? ({ enrolledBy: enrolledBy.get(workerId) } as never) : null) },
    gateway: { status: async () => assets.workers }
  });
  return {
    deps: {
      ...assets.deps,
      hubAdminId: async () => (await users.firstClusterAdmin())?.id ?? null,
      review,
      notifications,
      audit: admin.deps.audit,
      users,
      teams: admin.accounts.teams,
      policy
    },
    notifications
  };
}

/** 显式授权 + 自定义角色的内存仓库（ADR 0017）。 */
export function inMemoryAccess(): { grants: AccessGrantRepository; roles: TeamRoleRepository } {
  const grants = new Map<string, AccessGrant>();
  const roles = new Map<string, CustomRole>();
  return {
    grants: {
      save: async (g) => void grants.set(g.id, g),
      byId: async (id) => grants.get(id) ?? null,
      activeFor: async (userId, now) => [...grants.values()].filter((g) => g.userId === userId && accessGrantActive(g, now)),
      listByTeam: async (teamId) => [...grants.values()].filter((g) => g.teamId === teamId).sort((a, b) => b.createdAt - a.createdAt)
    },
    roles: {
      save: async (r) => void roles.set(r.id, r),
      byId: async (id) => roles.get(id) ?? null,
      listByTeam: async (teamId) => [...roles.values()].filter((r) => r.teamId === teamId).sort((a, b) => a.createdAt - b.createdAt),
      delete: async (id) => void roles.delete(id)
    }
  };
}
