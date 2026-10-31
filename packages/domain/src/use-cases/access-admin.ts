import {
  BUILTIN_ROLES,
  can,
  customRoleId,
  customRoleKey,
  customRoleProblem,
  isBuiltinRole,
  isSystem,
  principalOfSubject,
  VISIT_MAX_MS,
  type AccessGrant,
  type CustomRole,
  type Permission,
  type ResourceKind,
  type RolePermissions,
  type Subject
} from '../access.ts';
import type { AuditAction, Principal, Role, User, UserId } from '../account.ts';
import { conflict, forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { AccessGrantRepository, TeamRoleRepository } from '../ports/access-repository.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { SettingsRepository } from '../ports/settings-repository.ts';
import type { UserRepository } from '../ports/user-repository.ts';
import type { TeamRepository } from '../ports/team-repository.ts';
import { err, ok, type Result } from '../result.ts';

/** 授权数据（ADR 0017）：自定义角色 + 显式授权。 */
export interface AccessRepos {
  readonly grants: AccessGrantRepository;
  readonly roles: TeamRoleRepository;
}

export interface AccessAdminDeps extends AccessRepos {
  readonly users: UserRepository;
  readonly teams: Pick<TeamRepository, 'byId' | 'list'>;
  readonly audit: AuditLog;
  readonly now: () => number;
}

/** 认证后：把自定义角色定义和有效授权挂到 Principal 上，can() 只看内存。 */
export async function withAccess(repos: AccessRepos | undefined, principal: Principal | null, now: number): Promise<Principal | null> {
  if (!repos || !principal) return principal;
  const id = customRoleId(principal.user.role);
  const [customRole, grants] = await Promise.all([id ? repos.roles.byId(id) : Promise.resolve(null), repos.grants.activeFor(principal.user.id, now)]);
  return { ...principal, customRole, grants };
}

async function record(deps: Pick<AccessAdminDeps, 'audit' | 'now'>, actor: Principal, action: AuditAction, target: string, detail: string, teamId: string | null): Promise<void> {
  await deps.audit.append({ id: newId(), actorId: actor.user.id, actorEmail: actor.user.email, action, target, detail, at: deps.now(), teamId });
}

const signedIn = (subject: Subject | null): Result<Principal, DomainError> => {
  const principal = principalOfSubject(subject);
  return principal ? ok(principal) : err(forbidden('要以账号身份操作'));
};

// ───────────── 自定义角色 ─────────────

export interface RoleView {
  readonly key: Role;
  readonly name: string;
  readonly builtin: boolean;
  readonly permissions: RolePermissions;
  readonly members: number;
  readonly id?: string;
}

/** 团队的角色：内置四个 + 自定义。 */
export async function listTeamRoles(deps: Pick<AccessAdminDeps, 'roles' | 'users'>, subject: Subject | null, builtin: Readonly<Record<string, RolePermissions>>): Promise<Result<RoleView[], DomainError>> {
  const me = signedIn(subject);
  if (!me.ok) return me;
  const teamId = me.value.user.teamId;
  if (!teamId) return err(notFound('你不在任何团队里'));
  const people = (await deps.users.list()).filter((u) => u.teamId === teamId && u.deletedAt === null);
  const count = (role: Role) => people.filter((u) => u.role === role).length;
  const custom = await deps.roles.listByTeam(teamId);
  return ok([
    ...BUILTIN_ROLES.map((key) => ({ key, name: key, builtin: true, permissions: builtin[key] ?? {}, members: count(key) })),
    ...custom.map((r) => ({ key: customRoleKey(r.id), id: r.id, name: r.name, builtin: false, permissions: r.permissions, members: count(customRoleKey(r.id)) }))
  ]);
}

export interface RoleInput {
  readonly name: string;
  readonly permissions: Readonly<Record<string, unknown>>;
}

async function roleNameTaken(deps: Pick<AccessAdminDeps, 'roles'>, teamId: string, name: string, except?: string): Promise<boolean> {
  return (await deps.roles.listByTeam(teamId)).some((r) => r.name === name && r.id !== except);
}

export async function createTeamRole(deps: AccessAdminDeps, subject: Subject | null, input: RoleInput): Promise<Result<CustomRole, DomainError>> {
  const me = signedIn(subject);
  if (!me.ok) return me;
  const teamId = me.value.user.teamId;
  if (!teamId || !can(subject, 'team.roles', { kind: 'team', id: teamId, teamId })) return err(forbidden('只有团队 owner 能定义角色'));
  const problem = customRoleProblem(input.name, input.permissions);
  if (problem) return err(invalid(problem));
  const name = input.name.trim();
  if (await roleNameTaken(deps, teamId, name)) return err(conflict(`角色「${name}」已经有了`));
  const at = deps.now();
  const role: CustomRole = { id: newId(), teamId, name, permissions: input.permissions as RolePermissions, createdBy: me.value.user.id, createdAt: at, updatedAt: at };
  await deps.roles.save(role);
  await record(deps, me.value, 'role.create', name, Object.keys(role.permissions).join(', '), teamId);
  return ok(role);
}

async function ownRole(deps: AccessAdminDeps, subject: Subject | null, id: string): Promise<Result<{ me: Principal; role: CustomRole }, DomainError>> {
  const me = signedIn(subject);
  if (!me.ok) return me;
  const role = await deps.roles.byId(id);
  if (!role || role.teamId !== me.value.user.teamId) return err(notFound('没有这个角色'));
  if (!can(subject, 'team.roles', { kind: 'team', id: role.teamId, teamId: role.teamId })) return err(forbidden('只有团队 owner 能定义角色'));
  return ok({ me: me.value, role });
}

export async function updateTeamRole(deps: AccessAdminDeps, subject: Subject | null, id: string, input: RoleInput): Promise<Result<CustomRole, DomainError>> {
  const found = await ownRole(deps, subject, id);
  if (!found.ok) return found;
  const problem = customRoleProblem(input.name, input.permissions);
  if (problem) return err(invalid(problem));
  const name = input.name.trim();
  if (await roleNameTaken(deps, found.value.role.teamId, name, id)) return err(conflict(`角色「${name}」已经有了`));
  const next: CustomRole = { ...found.value.role, name, permissions: input.permissions as RolePermissions, updatedAt: deps.now() };
  await deps.roles.save(next);
  await record(deps, found.value.me, 'role.update', name, Object.keys(next.permissions).join(', '), next.teamId);
  return ok(next);
}

/** 删角色：还有人用就不让删（先把人改成别的角色）。 */
export async function deleteTeamRole(deps: AccessAdminDeps, subject: Subject | null, id: string): Promise<Result<void, DomainError>> {
  const found = await ownRole(deps, subject, id);
  if (!found.ok) return found;
  const key = customRoleKey(id);
  const using = (await deps.users.list()).filter((u) => u.role === key && u.deletedAt === null);
  if (using.length > 0) return err(conflict(`还有 ${using.length} 人是这个角色，先给他们换个角色`));
  await deps.roles.delete(id);
  await record(deps, found.value.me, 'role.delete', found.value.role.name, '', found.value.role.teamId);
  return ok(undefined);
}

/** 团队里能分配的角色：内置的 + 本团队自定义的。 */
export async function roleAssignable(deps: Pick<AccessAdminDeps, 'roles'>, teamId: string, role: string): Promise<boolean> {
  if (isBuiltinRole(role)) return true;
  const id = customRoleId(role);
  if (!id) return false;
  const found = await deps.roles.byId(id);
  return found !== null && found.teamId === teamId;
}

// ───────────── 显式授权 ─────────────

export interface GrantInput {
  readonly userId: string;
  readonly permission: Permission;
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
  readonly reason?: string;
  readonly expiresAt?: number | null;
}

/** 团队里的显式授权（比如允许某人在别人的会话里说话）：要 team.grants；不能授 NEVER_GRANTABLE，也不能跨团队。 */
export async function createGrant(deps: AccessAdminDeps, subject: Subject | null, input: GrantInput): Promise<Result<AccessGrant, DomainError>> {
  const me = signedIn(subject);
  if (!me.ok) return me;
  const teamId = me.value.user.teamId;
  if (!teamId || !can(subject, 'team.grants', { kind: 'team', id: teamId, teamId })) return err(forbidden('你不能给别人授权'));
  if (customRoleProblem('grant', { [input.permission]: 'own' }) !== null) return err(invalid(`不能单独授权 ${input.permission}`));
  const target = await deps.users.byId(input.userId as UserId);
  if (!target || target.teamId !== teamId || target.deletedAt !== null) return err(notFound('团队里没有这个人'));
  const at = deps.now();
  if (input.expiresAt != null && input.expiresAt <= at) return err(invalid('过期时间要在将来'));
  const grant: AccessGrant = {
    id: newId(), teamId, userId: target.id, permission: input.permission, resourceKind: input.resourceKind, resourceId: input.resourceId,
    reason: (input.reason ?? '').slice(0, 200), createdBy: me.value.user.id, createdAt: at, expiresAt: input.expiresAt ?? null, revokedAt: null
  };
  await deps.grants.save(grant);
  await record(deps, me.value, 'grant.create', target.email, `${grant.permission} · ${grant.resourceKind}:${grant.resourceId}`, teamId);
  return ok(grant);
}

export async function listGrants(deps: AccessAdminDeps, subject: Subject | null): Promise<Result<AccessGrant[], DomainError>> {
  const me = signedIn(subject);
  if (!me.ok) return me;
  const teamId = me.value.user.teamId;
  if (!teamId || !can(subject, 'team.grants', { kind: 'team', id: teamId, teamId })) return err(forbidden('你看不了授权'));
  return ok((await deps.grants.listByTeam(teamId)).filter((g) => g.permission !== 'hub.visit'));
}

export async function revokeGrant(deps: AccessAdminDeps, subject: Subject | null, id: string): Promise<Result<AccessGrant, DomainError>> {
  const me = signedIn(subject);
  if (!me.ok) return me;
  const grant = await deps.grants.byId(id);
  if (!grant || grant.permission === 'hub.visit' || grant.teamId !== me.value.user.teamId) return err(notFound('没有这条授权'));
  if (!can(subject, 'team.grants', { kind: 'team', id: grant.teamId, teamId: grant.teamId })) return err(forbidden('你不能撤销授权'));
  if (grant.revokedAt !== null) return ok(grant);
  const next = { ...grant, revokedAt: deps.now() };
  await deps.grants.save(next);
  const target = await deps.users.byId(grant.userId as UserId);
  await record(deps, me.value, 'grant.revoke', target?.email ?? grant.userId, `${grant.permission} · ${grant.resourceKind}:${grant.resourceId}`, grant.teamId);
  return ok(next);
}

// ───────────── 集群管理员临时进入（决定 5A） ─────────────

export interface VisitInput {
  readonly teamId: string;
  readonly reason: string;
  /** 多久后自动失效（毫秒，≤ 24h）。 */
  readonly durationMs: number;
}

/** 集群管理员临时进入别的团队：只读、必须写原因、有到期时间；hub 审计和那个团队的审计各留一条。 */
export async function startVisit(deps: AccessAdminDeps, subject: Subject | null, input: VisitInput): Promise<Result<AccessGrant, DomainError>> {
  const me = signedIn(subject);
  if (!me.ok) return me;
  if (!can(subject, 'hub.visit')) return err(forbidden('只有集群管理员能临时进入别的团队'));
  if (!(await deps.teams.byId(input.teamId as never))) return err(notFound('没有这个团队'));
  if (input.teamId === me.value.user.teamId) return err(invalid('这就是你自己的团队'));
  const reason = input.reason.trim();
  if (reason.length < 4 || reason.length > 200) return err(invalid('写清楚为什么要进入（4–200 字）'));
  if (!(input.durationMs > 0) || input.durationMs > VISIT_MAX_MS) return err(invalid('临时进入最长 24 小时'));
  const at = deps.now();
  const grant: AccessGrant = {
    id: newId(), teamId: input.teamId, userId: me.value.user.id, permission: 'hub.visit', resourceKind: 'team', resourceId: input.teamId,
    reason, createdBy: me.value.user.id, createdAt: at, expiresAt: at + input.durationMs, revokedAt: null
  };
  await deps.grants.save(grant);
  const detail = `只读，至 ${new Date(grant.expiresAt ?? at).toISOString()}：${reason}`;
  await record(deps, me.value, 'team.visit', input.teamId, detail, null);
  await record(deps, me.value, 'team.visit', input.teamId, detail, input.teamId);
  return ok(grant);
}

export async function endVisit(deps: AccessAdminDeps, subject: Subject | null, id: string): Promise<Result<void, DomainError>> {
  const me = signedIn(subject);
  if (!me.ok) return me;
  const grant = await deps.grants.byId(id);
  if (!grant || grant.permission !== 'hub.visit') return err(notFound('没有这次临时进入'));
  if (grant.userId !== me.value.user.id && !can(subject, 'hub.users')) return err(forbidden('不能结束别人的临时进入'));
  if (grant.revokedAt !== null) return ok(undefined);
  await deps.grants.save({ ...grant, revokedAt: deps.now() });
  await record(deps, me.value, 'team.visit_end', grant.resourceId, grant.reason, null);
  await record(deps, me.value, 'team.visit_end', grant.resourceId, grant.reason, grant.resourceId);
  return ok(undefined);
}

/** 我当前的临时进入（界面上显示横幅、结束按钮）。 */
export async function myVisits(deps: Pick<AccessAdminDeps, 'grants' | 'now'>, subject: Subject | null): Promise<AccessGrant[]> {
  const me = principalOfSubject(subject);
  if (!me || !me.user.clusterAdmin) return [];
  return (await deps.grants.activeFor(me.user.id, deps.now())).filter((g) => g.permission === 'hub.visit');
}

// ───────────── 集群管理员（决定 2A） ─────────────

/** 设 / 撤集群管理员：要 hub.users；至少留一位（最后一位撤不掉，也不能被停用 / 删除）。 */
export async function setClusterAdmin(
  deps: Pick<AccessAdminDeps, 'users' | 'audit' | 'now'>,
  subject: Subject | null,
  userId: string,
  value: boolean
): Promise<Result<User, DomainError>> {
  if (!can(subject, 'hub.users')) return err(forbidden('只有集群管理员能这么做'));
  const target = await deps.users.byId(userId as UserId);
  if (!target || target.deletedAt !== null) return err(notFound('没有这个用户'));
  if (target.clusterAdmin === value) return ok(target);
  if (value && target.disabledAt !== null) return err(invalid('停用的账号不能当集群管理员'));
  if (!value && (await activeClusterAdmins(deps.users)).filter((u) => u.id !== target.id).length === 0) {
    return err(conflict('至少要留一位集群管理员'));
  }
  const next = { ...target, clusterAdmin: value };
  await deps.users.save(next);
  const actor = principalOfSubject(subject);
  if (actor) await record(deps, actor, 'user.cluster_admin', target.email, value ? '设为集群管理员' : '撤销集群管理员', null);
  return ok(next);
}

export async function activeClusterAdmins(users: Pick<UserRepository, 'list'>): Promise<User[]> {
  return (await users.list()).filter((u) => u.clusterAdmin && u.disabledAt === null && u.deletedAt === null);
}

// ───────────── 迁移（决定 1A） ─────────────

/**
 * 启动时跑一次：老设置里的 localWorkerGrants（被单独授权用本机 Worker 的人）全部撤销，
 * 每人一条审计，然后清掉这个字段。没有就什么都不做（幂等）。
 */
export async function revokeLegacyLocalWorkerGrants(
  deps: { readonly settings: SettingsRepository; readonly users: Pick<UserRepository, 'byId' | 'firstClusterAdmin'>; readonly audit: AuditLog; readonly now: () => number }
): Promise<number> {
  const settings = await deps.settings.get();
  const legacy = settings.localWorkerGrants ?? [];
  if (!('localWorkerGrants' in settings)) return 0;
  const admin = await deps.users.firstClusterAdmin();
  for (const userId of legacy) {
    const user = await deps.users.byId(userId as UserId);
    if (!user || user.clusterAdmin) continue;
    await deps.audit.append({
      id: newId(),
      actorId: (admin?.id ?? 'system') as UserId,
      actorEmail: admin?.email ?? 'system',
      action: 'access.local_revoked',
      target: user.email,
      detail: 'ADR 0017：本机 Worker（hub 主机）改为只给集群管理员，单独授权已撤销',
      at: deps.now(),
      teamId: user.teamId ?? null
    });
  }
  const { localWorkerGrants: _dropped, ...rest } = settings;
  await deps.settings.save(rest);
  return legacy.length;
}

export { isSystem };
