import { can } from '../access.ts';
import type { AuditAction, Invite, InviteId, Principal, Role, Team, User, UserId } from '../account.ts';
import {
  ANONYMIZED_NAME,
  INVITE_TTL_MS,
  anonymizedEmail,
  defaultDisplayName,
  emailProblem,
  invitePending,
  newInviteId,
  newUserId,
  normalizeEmail,
  passwordProblem
} from '../account.ts';
import { newId } from '../ids.ts';
import { isServiceAccount } from '../api-token.ts';
import { conflict, forbidden, invalid, notFound } from '../errors.ts';
import type { DomainError } from '../errors.ts';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import type { ProjectRepository } from '../ports/project-repository.ts';
import type { InviteRepository } from '../ports/invite-repository.ts';
import type { AuditFilter } from '../ports/audit-log.ts';
import type { AuditEntry } from '../account.ts';
import type { AccountDeps, ClientInfo, IssuedLogin } from './accounts.ts';
import { issueLogin, seatsLeft } from './accounts.ts';
import { post } from './account-mail.ts';

/**
 * 团队成员管理（ADR 0011）：团队 owner 邀请人、改角色、删人。
 * 权限全走 can()：member.invite / member.manage，资源是「目标所在的团队」。
 */
export type TeamDeps = AccountDeps & {
  readonly invites: InviteRepository;
  /** 删人时把他建的项目转给团队 owner。 */
  readonly projects: Pick<ProjectRepository, 'list' | 'listDeleted' | 'save'>;
};

/** 记一条安全审计。没装审计（单测）就跳过。 */
export async function securityEvent(
  deps: Pick<AccountDeps, 'audit' | 'now'>,
  actor: Pick<User, 'id' | 'email' | 'teamId'>,
  action: AuditAction,
  target: string,
  detail = '',
  ip: string | null = null
): Promise<void> {
  if (!deps.audit) return;
  await deps.audit.append({
    id: newId(),
    actorId: actor.id,
    actorEmail: actor.email,
    action,
    target,
    detail,
    at: deps.now(),
    ip,
    teamId: actor.teamId ?? null
  });
}

const NO_TEAM = conflict('你还没有团队');

async function myTeam(deps: Pick<AccountDeps, 'teams'>, principal: Principal): Promise<Result<Team, DomainError>> {
  const team = principal.user.teamId ? await deps.teams.byId(principal.user.teamId) : null;
  return team ? ok(team) : err(NO_TEAM);
}

export interface TeamMember {
  readonly user: User;
  readonly isTeamOwner: boolean;
  readonly lastSeenAt: number | null;
}

export interface TeamView {
  readonly team: Team;
  readonly members: readonly TeamMember[];
  readonly invites: readonly Invite[];
  /** 还剩几个名额；不限是 null。 */
  readonly seatsLeft: number | null;
  /** 当前这个人能不能管（邀请 / 改角色 / 删人）。 */
  readonly canManage: boolean;
}

/** 我的团队：成员（没删的）+ 待接受的邀请。谁都能看自己团队有谁；邀请只有能管的人看得到。 */
export async function viewTeam(deps: TeamDeps, principal: Principal): Promise<Result<TeamView, DomainError>> {
  const found = await myTeam(deps, principal);
  if (!found.ok) return found;
  const team = found.value;
  const now = deps.now();
  const resource = { teamId: team.id };
  const canManage = can(principal, 'member.manage', resource);
  const [users, activity] = await Promise.all([deps.users.list(), deps.logins.activity(now)]);
  const seen = new Map(activity.map((row) => [row.userId, row.lastSeenAt]));
  const members = users
    .filter((user) => user.teamId === team.id && user.deletedAt === null && !isServiceAccount(user))
    .sort((a, b) => Number(b.id === team.ownerId) - Number(a.id === team.ownerId) || a.createdAt - b.createdAt)
    .map((user) => ({ user, isTeamOwner: user.id === team.ownerId, lastSeenAt: seen.get(user.id) ?? null }));
  const invites = canManage && can(principal, 'member.invite', resource) ? (await deps.invites.forTeam(team.id)).filter((invite) => invitePending(invite, now)) : [];
  const left = await seatsLeft(deps);
  return ok({ team, members, invites, seatsLeft: Number.isFinite(left) ? left : null, canManage });
}

export interface InviteCommand {
  readonly email: string;
  readonly role: Role;
  /** 超出 HUB_MAX_USERS 也邀请；只有团队 owner 能用。 */
  readonly allowOverLimit?: boolean;
  readonly ip?: string | null;
}

/** 邀请一个人进我的团队：发一封带链接的信。已有账号的邮箱、已有待接受邀请的邮箱都不行。 */
export async function inviteMember(deps: TeamDeps, principal: Principal, command: InviteCommand): Promise<Result<Invite, DomainError>> {
  const found = await myTeam(deps, principal);
  if (!found.ok) return found;
  const team = found.value;
  if (!can(principal, 'member.invite', { teamId: team.id })) return err(forbidden('只有团队 owner 能邀请人'));
  const email = normalizeEmail(command.email);
  const problem = emailProblem(email);
  if (problem) return err(invalid(problem));
  const now = deps.now();
  const existing = await deps.users.byEmail(email);
  if (existing && existing.deletedAt === null) return err(conflict('这个邮箱已经有账号了'));
  const pending = (await deps.invites.forTeam(team.id)).find((invite) => invite.email === email && invitePending(invite, now));
  if (pending) return err(conflict('已经邀请过这个邮箱了；要重发就先撤销'));
  const overLimit = (await seatsLeft(deps)) <= 0;
  const allowOverLimit = command.allowOverLimit === true && principal.user.id === team.ownerId;
  if (overLimit && !allowOverLimit) return err(conflict('名额已满（HUB_MAX_USERS）；团队 owner 可以勾选「超出名额也邀请」'));
  const { token, hash } = deps.tokens.issue();
  const invite: Invite = {
    id: newInviteId(),
    tokenHash: hash,
    teamId: team.id,
    email,
    role: command.role,
    invitedBy: principal.user.id,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    acceptedAt: null,
    revokedAt: null,
    allowOverLimit: overLimit && allowOverLimit
  };
  await deps.invites.save(invite);
  post(deps, {
    kind: 'invite',
    to: email,
    displayName: defaultDisplayName(email),
    teamName: team.name,
    inviterName: principal.user.displayName,
    token,
    expiresAt: invite.expiresAt
  });
  await securityEvent(deps, principal.user, 'invite.create', email, `角色 ${command.role}${invite.allowOverLimit ? '，超出名额' : ''}`, command.ip);
  return ok(invite);
}

export async function revokeInvite(deps: TeamDeps, principal: Principal, id: InviteId, ip: string | null = null): Promise<Result<Invite, DomainError>> {
  const invite = await deps.invites.byId(id);
  if (!invite || !can(principal, 'member.invite', { teamId: invite.teamId })) return err(notFound('没有这个邀请'));
  if (!invitePending(invite, deps.now())) return ok(invite);
  const next = { ...invite, revokedAt: deps.now() };
  await deps.invites.save(next);
  await securityEvent(deps, principal.user, 'invite.revoke', invite.email, '', ip);
  return ok(next);
}

const BAD_INVITE = invalid('邀请链接无效或已过期，请让对方重新邀请');

export interface InvitePreview {
  readonly email: string;
  readonly teamName: string;
  readonly inviterName: string;
  readonly role: Role;
}

/** 打开邀请链接时先看一眼：邀请的是哪个邮箱、进哪个团队。不消耗令牌。 */
export async function previewInvite(deps: TeamDeps, token: string): Promise<Result<InvitePreview, DomainError>> {
  if (token === '') return err(BAD_INVITE);
  const invite = await deps.invites.byTokenHash(deps.tokens.hashOf(token));
  if (!invite || !invitePending(invite, deps.now())) return err(BAD_INVITE);
  const [team, inviter] = await Promise.all([deps.teams.byId(invite.teamId), deps.users.byId(invite.invitedBy)]);
  if (!team) return err(BAD_INVITE);
  return ok({ email: invite.email, teamName: team.name, inviterName: inviter?.displayName ?? '团队', role: invite.role });
}

export interface AcceptInviteCommand extends ClientInfo {
  readonly token: string;
  readonly password: string;
  readonly displayName?: string;
}

/**
 * 接受邀请：设密码、建账号（进邀请人的团队、带邀请的角色）、直接登录。
 * 点得开信里的链接就证明邮箱是他的，所以算已验证。名额在接受时再看一次（邀请时勾了「超出名额」的除外）。
 */
export async function acceptInvite(deps: TeamDeps, command: AcceptInviteCommand): Promise<Result<IssuedLogin, DomainError>> {
  const problem = passwordProblem(command.password);
  if (problem) return err(invalid(problem));
  if (command.token === '') return err(BAD_INVITE);
  const now = deps.now();
  const hash = deps.tokens.hashOf(command.token);
  const peek = await deps.invites.byTokenHash(hash);
  if (!peek || !invitePending(peek, now)) return err(BAD_INVITE);
  const existing = await deps.users.byEmail(peek.email);
  if (existing && existing.deletedAt === null) return err(conflict('这个邮箱已经有账号了，直接登录就行'));
  // 这个邀请本身已经占着一个名额，所以「剩余 < 0」才算超
  if (!peek.allowOverLimit && (await seatsLeft(deps)) < 0) return err(conflict('这个 hub 的名额已满，请联系邀请你的人'));
  const team = await deps.teams.byId(peek.teamId);
  if (!team) return err(BAD_INVITE);
  const invite = await deps.invites.accept(hash, now);
  if (!invite) return err(BAD_INVITE);
  const user: User = {
    id: newUserId(),
    email: invite.email,
    displayName: command.displayName?.trim() || defaultDisplayName(invite.email),
    role: invite.role,
    passwordHash: await deps.hasher.hash(command.password),
    emailVerifiedAt: now,
    disabledAt: null,
    createdAt: now,
    teamId: team.id,
    hubAdmin: false,
    deletedAt: null
  };
  await deps.users.save(user);
  await securityEvent(deps, user, 'auth.register', user.email, `接受邀请，角色 ${user.role}`, command.ip ?? null);
  return ok(await issueLogin(deps, user, 'password', command));
}

async function teamMember(
  deps: TeamDeps,
  principal: Principal,
  userId: UserId
): Promise<Result<{ user: User; team: Team }, DomainError>> {
  const user = await deps.users.byId(userId);
  const team = user?.teamId ? await deps.teams.byId(user.teamId) : null;
  // hub 管理员能管全站用户（hub.users）；团队 owner 只能管自己团队（member.manage）。
  if (!user || user.deletedAt !== null || !team) return err(notFound('没有这个成员'));
  if (!can(principal, 'hub.users') && !can(principal, 'member.manage', { teamId: team.id })) return err(notFound('没有这个成员'));
  return ok({ user, team });
}

/** 改团队里某人的角色。团队 owner 本人的角色不能改（不然团队就没人管了）。 */
export async function setMemberRole(
  deps: TeamDeps,
  principal: Principal,
  userId: UserId,
  role: Role,
  ip: string | null = null
): Promise<Result<User, DomainError>> {
  const found = await teamMember(deps, principal, userId);
  if (!found.ok) return found;
  const { user, team } = found.value;
  if (user.id === team.ownerId) return err(conflict('团队 owner 的角色不能改'));
  if (user.role === role) return ok(user);
  const next = { ...user, role };
  await deps.users.save(next);
  await securityEvent(deps, principal.user, 'user.role', user.email, `${user.role} → ${role}`, ip);
  return ok(next);
}

/**
 * 删人（ADR 0011）：软删 + 匿名化（邮箱、名字、密码清掉），踢下线、作废他的一次性链接；
 * 他建的项目（含回收站里的）转给团队 owner，项目共享名单里去掉他。不能删自己、不能删团队 owner、不能删 hub 管理员。
 */
export async function deleteMember(
  deps: TeamDeps,
  principal: Principal,
  userId: UserId,
  ip: string | null = null
): Promise<Result<{ transferredProjects: number }, DomainError>> {
  const found = await teamMember(deps, principal, userId);
  if (!found.ok) return found;
  const { user, team } = found.value;
  if (user.id === principal.user.id) return err(conflict('不能删除你自己'));
  if (user.hubAdmin) return err(conflict('不能删除 hub 管理员'));
  if (user.id === team.ownerId) return err(conflict('不能删除团队 owner'));
  const now = deps.now();
  const originalEmail = user.email;
  await deps.users.save({
    ...user,
    email: anonymizedEmail(user.id),
    displayName: ANONYMIZED_NAME,
    passwordHash: null,
    disabledAt: user.disabledAt ?? now,
    deletedAt: now
  });
  await deps.logins.removeForUser(user.id);
  await deps.oneTimeTokens.revokeForUser(user.id, 'verify-email', now);
  await deps.oneTimeTokens.revokeForUser(user.id, 'reset-password', now);
  let transferred = 0;
  for (const project of [...(await deps.projects.list()), ...(await deps.projects.listDeleted())]) {
    const mine = project.createdBy === user.id;
    const shared = project.members.includes(user.id);
    if (!mine && !shared) continue;
    if (mine) transferred++;
    await deps.projects.save({
      ...project,
      createdBy: mine ? team.ownerId : project.createdBy,
      members: project.members.filter((id) => id !== user.id)
    });
  }
  // 审计里留原邮箱：谁删了谁要查得到（审计只有 hub 管理员 / 团队 owner 能看）。
  await securityEvent(deps, principal.user, 'user.delete', originalEmail, `项目转给团队 owner：${transferred} 个`, ip);
  return ok({ transferredProjects: transferred });
}

/**
 * 团队主人看自己团队的安全审计（ADR 0011）：teamId 由服务端强制成自己的团队，
 * 传进来的 teamId 一律忽略。hub 管理员看全 hub 走 /api/admin/audit。
 */
export async function teamAudit(
  deps: TeamDeps,
  principal: Principal,
  filter: Omit<AuditFilter, 'teamId'>
): Promise<Result<AuditEntry[], DomainError>> {
  const found = await myTeam(deps, principal);
  if (!found.ok) return found;
  if (!can(principal, 'audit.read', { teamId: found.value.id })) return err(forbidden('只有团队主人能看团队审计'));
  if (!deps.audit) return ok([]);
  return ok(await deps.audit.query({ ...filter, teamId: found.value.id }));
}
