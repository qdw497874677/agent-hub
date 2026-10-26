import { newId } from '../ids.ts';
import type { AuditAction, AuditEntry, HubSettings, Login, Principal, Role, User, UserId } from '../account.ts';
import { forbidden, conflict, notFound } from '../errors.ts';
import type { DomainError } from '../errors.ts';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { WorkerControl } from '../ports/worker-control.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import { isOutdated } from '../worker.ts';
import type { WorkerStatus } from '../worker.ts';
import type { AccountDeps } from './accounts.ts';

/**
 * 运营后台（docs/design/accounts.md §16 P2）。只有 Owner 能进；
 * 每个写操作都过 `guard` 做权限与「别把自己锁在门外」的检查，并写一条审计。
 */
export interface AdminDeps extends Pick<AccountDeps, 'users' | 'logins' | 'settings' | 'now'> {
  readonly audit: AuditLog;
  readonly workers: WorkerControl;
  readonly sessions: Pick<SessionRepository, 'listAll'>;
}

export interface AdminUser {
  readonly user: User;
  readonly lastSeenAt: number | null;
  readonly activeLogins: number;
}

export interface AdminOverview {
  readonly users: number;
  readonly disabledUsers: number;
  readonly onlineWorkers: number;
  readonly workers: number;
  readonly runningSessions: number;
  readonly recentUsers: readonly User[];
  readonly recentLogins: readonly { readonly login: Login; readonly email: string }[];
}

const ONLY_OWNER = forbidden('只有主人能进运营后台');

export function requireOwner(principal: Principal | null): Result<Principal, DomainError> {
  return principal && principal.user.role === 'owner' && principal.user.disabledAt === null ? ok(principal) : err(ONLY_OWNER);
}

async function record(
  deps: Pick<AdminDeps, 'audit' | 'now'>,
  actor: Principal,
  action: AuditAction,
  target: string,
  detail: string
): Promise<void> {
  const entry: AuditEntry = {
    id: newId(),
    actorId: actor.user.id,
    actorEmail: actor.user.email,
    action,
    target,
    detail,
    at: deps.now()
  };
  await deps.audit.append(entry);
}

/** 还能登录的主人有几个：降级 / 停用前要保证至少剩一个。 */
async function activeOwners(deps: Pick<AdminDeps, 'users'>): Promise<User[]> {
  return (await deps.users.list()).filter((user) => user.role === 'owner' && user.disabledAt === null);
}

export async function adminOverview(deps: AdminDeps): Promise<AdminOverview> {
  const [users, workers, sessions, logins] = await Promise.all([
    deps.users.list(),
    deps.workers.list(),
    deps.sessions.listAll(),
    deps.logins.recent(8)
  ]);
  const emailOf = new Map(users.map((user) => [user.id, user.email]));
  return {
    users: users.length,
    disabledUsers: users.filter((user) => user.disabledAt !== null).length,
    onlineWorkers: workers.filter((worker) => worker.state === 'online').length,
    workers: workers.length,
    runningSessions: sessions.filter((session) => session.status === 'running').length,
    recentUsers: [...users].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5),
    recentLogins: logins.map((login) => ({ login, email: emailOf.get(login.userId) ?? '（已删除）' }))
  };
}

/** 用户列表；`query` 按邮箱或名字子串过滤（不分大小写）。 */
export async function adminUsers(deps: AdminDeps, query = ''): Promise<AdminUser[]> {
  const needle = query.trim().toLowerCase();
  const [users, activity] = await Promise.all([deps.users.list(), deps.logins.activity(deps.now())]);
  const byUser = new Map(activity.map((row) => [row.userId, row]));
  return users
    .filter((user) => needle === '' || user.email.includes(needle) || user.displayName.toLowerCase().includes(needle))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((user) => ({
      user,
      lastSeenAt: byUser.get(user.id)?.lastSeenAt ?? null,
      activeLogins: byUser.get(user.id)?.active ?? 0
    }));
}

async function target(deps: Pick<AdminDeps, 'users'>, id: UserId): Promise<Result<User, DomainError>> {
  const user = await deps.users.byId(id);
  return user ? ok(user) : err(notFound('没有这个用户'));
}

export async function setUserDisabled(
  deps: AdminDeps,
  actor: Principal,
  userId: UserId,
  disabled: boolean
): Promise<Result<User, DomainError>> {
  const found = await target(deps, userId);
  if (!found.ok) return found;
  const user = found.value;
  if (disabled && user.id === actor.user.id) return err(conflict('不能停用你自己'));
  if (disabled && user.role === 'owner' && user.disabledAt === null && (await activeOwners(deps)).length <= 1) {
    return err(conflict('这是最后一个可用的主人，不能停用'));
  }
  if ((user.disabledAt !== null) === disabled) return ok(user);
  const next: User = { ...user, disabledAt: disabled ? deps.now() : null };
  await deps.users.save(next);
  if (disabled) await deps.logins.removeForUser(user.id); // 停用立刻生效：已登录的设备一并踢下线
  await record(deps, actor, disabled ? 'user.disable' : 'user.enable', user.email, '');
  return ok(next);
}

export async function setUserRole(
  deps: AdminDeps,
  actor: Principal,
  userId: UserId,
  role: Role
): Promise<Result<User, DomainError>> {
  const found = await target(deps, userId);
  if (!found.ok) return found;
  const user = found.value;
  if (user.role === role) return ok(user);
  if (role === 'member' && user.disabledAt === null && (await activeOwners(deps)).length <= 1) {
    return err(conflict('这是最后一个可用的主人，不能降为成员'));
  }
  const next: User = { ...user, role };
  await deps.users.save(next);
  await record(deps, actor, 'user.role', user.email, `${user.role} → ${role}`);
  return ok(next);
}

/** 踢下线：删掉这个人的全部登录态。对自己操作时保留当前这台。 */
export async function revokeUserLogins(
  deps: AdminDeps,
  actor: Principal,
  userId: UserId
): Promise<Result<User, DomainError>> {
  const found = await target(deps, userId);
  if (!found.ok) return found;
  const self = found.value.id === actor.user.id;
  await deps.logins.removeForUser(found.value.id, self ? actor.loginId : undefined);
  await record(deps, actor, 'user.revoke_logins', found.value.email, self ? '保留当前设备' : '');
  return ok(found.value);
}

export async function updateSettings(
  deps: AdminDeps,
  actor: Principal,
  patch: Partial<HubSettings>
): Promise<HubSettings> {
  const current = await deps.settings.get();
  const next: HubSettings = { ...current, ...patch };
  const changed = (Object.keys(next) as (keyof HubSettings)[]).filter((key) => next[key] !== current[key]);
  if (changed.length === 0) return current;
  await deps.settings.save(next);
  await record(deps, actor, 'settings.update', 'settings', changed.map((key) => `${key}=${next[key]}`).join(', '));
  return next;
}

export async function disconnectWorker(
  deps: AdminDeps,
  actor: Principal,
  workerId: string
): Promise<Result<WorkerStatus, DomainError>> {
  const worker = (await deps.workers.list()).find((candidate) => candidate.workerId === workerId);
  if (!worker) return err(notFound('没有这台机器'));
  if (worker.origin === 'local') return err(conflict('本机 Worker 跟 hub 同生共死，不能断开'));
  if (!(await deps.workers.disconnect(workerId))) return err(conflict('这台机器已经不在线'));
  await record(deps, actor, 'worker.disconnect', `${worker.label}（${workerId}）`, '');
  return ok(worker);
}

const short = (commit: string): string => commit.slice(0, 7);

/**
 * 让一台 Worker 更新到 hub 的提交。目标只能是 hub 自己的提交——不收任何外部输入，
 * 所以这条路径不可能变成「在远程机器上跑任意命令」。已是最新的也照发：Worker 会回「无需更新」，
 * 等于一次演练（验证通道和权限都通）。
 */
export async function updateWorker(
  deps: AdminDeps,
  actor: Principal,
  workerId: string
): Promise<Result<WorkerStatus, DomainError>> {
  const commit = deps.workers.hubBuild().commit;
  if (!commit) return err(conflict('hub 不是从 git 仓库启动的，不知道该更新到哪个版本'));
  const worker = (await deps.workers.list()).find((candidate) => candidate.workerId === workerId);
  if (!worker) return err(notFound('没有这台机器'));
  if (worker.state !== 'online') return err(conflict('这台机器不在线'));
  if (worker.update?.state === 'updating') return err(conflict('这台机器正在更新'));
  if (!(await deps.workers.update(workerId, commit))) return err(conflict('这台机器已经不在线'));
  const from = worker.build?.commit ? short(worker.build.commit) : '未知版本';
  await record(deps, actor, 'worker.update', `${worker.label}（${workerId}）`, `${from} → ${short(commit)}`);
  return ok(worker);
}

/** 「更新全部过期」：只动在线且过期、没在更新中的；返回发出了更新的那些。 */
export async function updateOutdatedWorkers(
  deps: AdminDeps,
  actor: Principal
): Promise<Result<WorkerStatus[], DomainError>> {
  const hub = deps.workers.hubBuild();
  if (!hub.commit) return err(conflict('hub 不是从 git 仓库启动的，不知道该更新到哪个版本'));
  const targets = (await deps.workers.list()).filter(
    (worker) => worker.state === 'online' && worker.update?.state !== 'updating' && isOutdated(worker, hub)
  );
  const started: WorkerStatus[] = [];
  for (const worker of targets) {
    const result = await updateWorker(deps, actor, worker.workerId);
    if (result.ok) started.push(result.value);
  }
  return ok(started);
}
