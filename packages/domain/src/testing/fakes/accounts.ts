import { DEFAULT_SETTINGS } from '../../index.ts';
import type {
  AccountDeps,
  AccountMail,
  AdminDeps,
  AuditEntry,
  BuildInfo,
  HubSettings,
  Login,
  LoginActivity,
  OneTimeToken,
  Session,
  Team,
  User,
  WorkerStatus
} from '../../index.ts';
import type { RuntimeJob } from '../../runtime-install.ts';
import { matchesAudit } from '../../ports/audit-log.ts';
import { seedAccount } from '../../use-cases/accounts.ts';
import { invitePending } from '../../account.ts';
import type { Invite } from '../../account.ts';
import type { InviteRepository } from '../../ports/invite-repository.ts';

/** 账号 / 运营后台 / 机器接入的内存假件。 */

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

/** 单台机器接入的内存实现：和 inMemoryAdmin 共用用户、设置、审计和机器列表。 */
export function inMemoryEnrollment(admin: ReturnType<typeof inMemoryAdmin>, now: () => number = () => 1_000) {
  type PairingCode = import('../../enrollment.ts').PairingCode;
  type WorkerCredential = import('../../enrollment.ts').WorkerCredential;
  const pairings = new Map<string, PairingCode>();
  const credentials = new Map<string, WorkerCredential>();
  let seq = 0;
  const enrollment: import('../../ports/enrollment-repository.ts').EnrollmentRepository = {
    savePairing: async (code) => void pairings.set(code.hash, code),
    pairingByHash: async (hash) => pairings.get(hash) ?? null,
    consumePairing: async (hash, workerId, at) => {
      const code = pairings.get(hash);
      if (!code || code.usedAt !== null) return false;
      pairings.set(hash, { ...code, usedAt: at, workerId });
      return true;
    },
    saveCredential: async (credential) => void credentials.set(credential.workerId, credential),
    credentialByHash: async (hash) => [...credentials.values()].find((c) => c.tokenHash === hash || c.pendingHash === hash) ?? null,
    credentialFor: async (workerId) => credentials.get(workerId) ?? null,
    listCredentials: async () => [...credentials.values()],
    revoke: async (workerId, at) => {
      const found = credentials.get(workerId);
      if (found && found.revokedAt === null) credentials.set(workerId, { ...found, revokedAt: at });
    },
    recordConnection: async (workerId, c) => {
      const found = credentials.get(workerId);
      if (found) credentials.set(workerId, { ...found, lastConnectedAt: c.at, lastAddress: c.address, lastUserAgent: c.userAgent });
    },
    setCapabilities: async (workerId, capabilities) => {
      const found = credentials.get(workerId);
      if (found) credentials.set(workerId, { ...found, capabilities });
    },
    beginRotation: async (workerId, pendingHash, until) => {
      const found = credentials.get(workerId);
      if (found) credentials.set(workerId, { ...found, pendingHash, pendingUntil: until });
    },
    completeRotation: async (workerId, pendingHash, at) => {
      const found = credentials.get(workerId);
      if (!found || found.pendingHash !== pendingHash) return false;
      credentials.set(workerId, { ...found, tokenHash: pendingHash, pendingHash: null, pendingUntil: null, rotatedAt: at });
      return true;
    },
    failRotation: async (workerId, at) => {
      const found = credentials.get(workerId);
      if (found) credentials.set(workerId, { ...found, pendingHash: null, pendingUntil: null, rotationFailedAt: at });
    }
  };
  const deps: import('../../use-cases/enrollment.ts').EnrollmentDeps = {
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
