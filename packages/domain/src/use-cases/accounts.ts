import { isServiceAccount } from '../api-token.ts';
import type { Login, Principal, Role, Team, User } from '../account.ts';
import {
  LOGIN_TOUCH_INTERVAL_MS,
  LOGIN_TTL_MS,
  defaultDisplayName,
  emailProblem,
  loginUsable,
  newLoginId,
  newTeamId,
  newUserId,
  normalizeEmail,
  passwordProblem
} from '../account.ts';
import { conflict, invalid } from '../errors.ts';
import type { DomainError } from '../errors.ts';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import type { UserRepository } from '../ports/user-repository.ts';
import type { LoginRepository } from '../ports/login-repository.ts';
import type { PasswordHasher } from '../ports/password-hasher.ts';
import type { TokenIssuer } from '../ports/token-issuer.ts';
import type { EmailSender } from '../ports/email-sender.ts';
import { post, sendVerification } from './account-mail.ts';
import type { TeamRepository } from '../ports/team-repository.ts';
import type { SettingsRepository } from '../ports/settings-repository.ts';
import type { OneTimeTokenRepository } from '../ports/one-time-token-repository.ts';
import type { InviteRepository } from '../ports/invite-repository.ts';
import type { AuditLog } from '../ports/audit-log.ts';

/**
 * 账号是独立的一块，不进对话那套 Deps：会话用例不需要知道谁在登录。
 * 签名同样写 `Pick<AccountDeps, …>`。
 */
export interface AccountDeps {
  readonly users: UserRepository;
  readonly logins: LoginRepository;
  readonly hasher: PasswordHasher;
  readonly tokens: TokenIssuer;
  readonly mail: EmailSender;
  readonly settings: SettingsRepository;
  /** 验证邮箱、重置密码用的一次性令牌。 */
  readonly oneTimeTokens: OneTimeTokenRepository;
  /** 团队（租户）。 */
  readonly teams: TeamRepository;
  /**
   * 自助注册的人数上限（HUB_MAX_USERS）；没有或 0 = 不限。按库里全部账号算（停用的也占名额，
   * 删号以后才腾出来），首个主人认领不受限。
   */
  readonly maxUsers?: number;
  /** 团队邀请；没装（单测）就没有邀请功能。 */
  readonly invites?: InviteRepository;
  /** 安全事件（登录、改密码、邀请、删人）写这里；没装就不记。 */
  readonly audit?: AuditLog;
  readonly now: () => number;
}

/** 签发出去的登录：令牌只在这里出现一次，交给 HTTP 层写进 cookie。 */
export interface IssuedLogin {
  readonly token: string;
  readonly user: User;
  readonly expiresAt: number;
}

/** 登录失败只有一种说法：不告诉对方「邮箱不存在」还是「密码不对」。 */
const BAD_CREDENTIALS = invalid('邮箱或密码不对');
const DISABLED = conflict('这个账号已被停用');

/**
 * 邮箱不存在时也跑一次哈希校验，让两种失败耗时一样（防枚举）。
 * 这个串的格式与参数随适配器而定，所以第一次用时现算。
 */
let decoy: Promise<string> | null = null;

/** 来访设备的描述：UA 与来源 IP，都可能没有。 */
export interface ClientInfo {
  readonly userAgent?: string | null;
  readonly ip?: string | null;
}

export async function issueLogin(
  deps: Pick<AccountDeps, 'logins' | 'tokens' | 'now'>,
  user: User,
  method: Login['method'],
  client: ClientInfo
): Promise<IssuedLogin> {
  const { token, hash } = deps.tokens.issue();
  const now = deps.now();
  const expiresAt = now + LOGIN_TTL_MS;
  await deps.logins.save({ id: newLoginId(), userId: user.id, tokenHash: hash, method, userAgent: client.userAgent ?? null, ip: client.ip ?? null, createdAt: now, lastSeenAt: now, expiresAt });
  return { token, user, expiresAt };
}

export interface RegisterCommand {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
  readonly userAgent?: string | null;
  readonly ip?: string | null;
}

/**
 * 开放注册。还没有 Owner 时第一个注册的人就是 Owner（首启认领）；之后注册的都是成员。
 * 第一个人（主人）直接算已验证——没人能替他验证；成员要点邮件里的链接（设计 §6.2），
 * 没验证前能登录，但只能看到「去验证邮箱」。
 */
export type RegisterOutcome =
  | { readonly kind: 'login'; readonly issued: IssuedLogin }
  /** 防枚举：新邮箱和已注册的邮箱都只回这一句，区别只在邮件里。 */
  | { readonly kind: 'check-email' };

/** 给一个人建他自己的团队（他是 owner）。 */
export function newTeamFor(user: Pick<User, 'id' | 'displayName'>, now: number): Team {
  return { id: newTeamId(), name: `${user.displayName} 的团队`, ownerId: user.id, createdAt: now };
}

/**
 * 自助注册（ADR 0011）：
 * - 还没有 hub 管理员：第一个注册的人认领 hub 管理员（也是他自己团队的 owner），直接登录；
 * - 否则要 hub 开着自助注册（默认关）且没满名额；这两条对谁都一样，不泄露邮箱在不在；
 * - 然后无论邮箱在不在，都只回「去查收邮件」：新邮箱发验证信并建一个自己的空团队，
 *   已注册的邮箱只给它发一封「有人拿你的邮箱注册」的提醒。
 */
export async function registerUser(
  deps: AccountDeps,
  command: RegisterCommand
): Promise<Result<RegisterOutcome, DomainError>> {
  const email = normalizeEmail(command.email);
  const problem = emailProblem(email) ?? passwordProblem(command.password);
  if (problem) return err(invalid(problem));
  const now = deps.now();
  const displayName = command.displayName?.trim() || defaultDisplayName(email);
  const base = {
    id: newUserId(),
    email,
    displayName,
    passwordHash: '',
    emailVerifiedAt: null,
    disabledAt: null,
    createdAt: now,
    deletedAt: null
  };

  if ((await deps.users.hubAdmin()) === null && !(await deps.users.byEmail(email))) {
    const team = newTeamFor(base, now);
    // 首启认领交给存储原子完成：并发注册时只有一个人成为 hub 管理员。
    const admin: User = {
      ...base,
      passwordHash: await deps.hasher.hash(command.password),
      role: 'owner',
      emailVerifiedAt: now,
      teamId: team.id,
      hubAdmin: true
    };
    if (await deps.users.claimFirstOwner(admin)) {
      await deps.teams.save(team);
      return ok({ kind: 'login', issued: await issueLogin(deps, admin, 'password', command) });
    }
  }
  if (!(await deps.settings.get()).openRegistration) return err(conflict(CLOSED_MESSAGE));
  if (await registrationFull(deps)) return err(conflict(FULL_MESSAGE));

  const existing = await deps.users.byEmail(email);
  if (existing) {
    // 跑一次哈希，让两条路耗时差不多
    await deps.hasher.hash(command.password);
    if (existing.deletedAt === null) post(deps, { kind: 'already-registered', to: existing.email, displayName: existing.displayName });
    return ok({ kind: 'check-email' });
  }
  const team = newTeamFor(base, now);
  const user: User = { ...base, passwordHash: await deps.hasher.hash(command.password), role: 'owner', teamId: team.id, hubAdmin: false };
  await deps.teams.save(team);
  await deps.users.save(user);
  // 验证信发不出去不该让注册失败：主人也能在后台手动标记。
  await sendVerification(deps, user);
  return ok({ kind: 'check-email' });
}

export const CLOSED_MESSAGE = '这个 hub 暂不开放注册，请向团队要一个邀请链接';
export const FULL_MESSAGE = '这个 hub 的注册名额已满，请联系管理员';

/** 名额满了没有（首个主人认领除外）。 */
export async function registrationFull(deps: Pick<AccountDeps, 'users' | 'maxUsers' | 'invites' | 'now'>): Promise<boolean> {
  return (await seatsLeft(deps)) <= 0;
}

/**
 * 还剩几个名额（HUB_MAX_USERS）；不限 = Infinity。占名额的：没删的账号（停用的也算）+ 还没用的邀请。
 * 软删的人腾出名额。
 */
export async function seatsLeft(deps: Pick<AccountDeps, 'users' | 'maxUsers' | 'invites' | 'now'>): Promise<number> {
  const max = deps.maxUsers ?? 0;
  if (max <= 0) return Infinity;
  const users = (await deps.users.list()).filter((user) => user.deletedAt === null && !isServiceAccount(user)).length;
  // 勾了「超出名额」的邀请不再占名额（它本来就是额外的）
  const invites = deps.invites ? (await deps.invites.pending(deps.now())).filter((invite) => !invite.allowOverLimit).length : 0;
  return max - users - invites;
}

export interface PasswordLoginCommand {
  readonly email: string;
  readonly password: string;
  readonly userAgent?: string | null;
  readonly ip?: string | null;
}

export async function loginWithPassword(
  deps: Pick<AccountDeps, 'users' | 'logins' | 'hasher' | 'tokens' | 'now'>,
  command: PasswordLoginCommand
): Promise<Result<IssuedLogin, DomainError>> {
  const user = await deps.users.byEmail(normalizeEmail(command.email));
  if (!user || user.passwordHash === null || user.deletedAt !== null) {
    decoy ??= deps.hasher.hash('decoy-password-for-timing');
    await deps.hasher.verify(command.password, await decoy);
    return err(BAD_CREDENTIALS);
  }
  if (!(await deps.hasher.verify(command.password, user.passwordHash))) return err(BAD_CREDENTIALS);
  if (user.disabledAt !== null) return err(DISABLED);
  return ok(await issueLogin(deps, user, 'password', command));
}

/**
 * 过渡期：拿旧的共享 HUB_TOKEN 换一个登录，落在最早的 Owner 身上。
 * 令牌本身对不对、过渡期过没过，是部署层面的事，由调用方判断后才进来。
 */
export async function loginAsFirstOwner(
  deps: Pick<AccountDeps, 'users' | 'logins' | 'tokens' | 'now'>,
  client: ClientInfo | string | null
): Promise<Result<IssuedLogin, DomainError>> {
  const owner = (await deps.users.hubAdmin()) ?? (await deps.users.firstWithRole('owner'));
  if (!owner) return err(conflict('还没有任何账号：先注册一个，第一个注册的人就是主人'));
  return ok(await issueLogin(deps, owner, 'hub-token', typeof client === 'object' && client !== null ? client : { userAgent: client }));
}

/** 凭令牌认人。有效就顺手续期（每小时最多写一次库）。 */
export async function authenticate(
  deps: Pick<AccountDeps, 'users' | 'logins' | 'tokens' | 'now'>,
  token: string
): Promise<Principal | null> {
  if (token === '') return null;
  const login = await deps.logins.byTokenHash(deps.tokens.hashOf(token));
  if (!login) return null;
  const user = await deps.users.byId(login.userId);
  const now = deps.now();
  if (!loginUsable(login, user, now)) return null;
  if (now - login.lastSeenAt >= LOGIN_TOUCH_INTERVAL_MS) await deps.logins.touch(login.id, now, now + LOGIN_TTL_MS);
  return { user, loginId: login.id };
}

export async function logout(deps: Pick<AccountDeps, 'logins'>, principal: Principal): Promise<void> {
  await deps.logins.remove(principal.loginId);
}

export interface SeedAccount {
  readonly email: string;
  readonly password: string;
  readonly role: Role;
  readonly displayName: string;
  /** 运维显式指定的密码（如 HUB_TEST_ACCOUNT_PASSWORD）：不过强度规则，只要非空。 */
  readonly operatorChosen?: boolean;
}

/**
 * 内置测试账号：没有就建，有就把密码对齐到给定值（密码文件是唯一来源）。
 * 幂等，每次启动都可以调。
 */
export async function seedAccount(
  deps: Pick<AccountDeps, 'users' | 'hasher' | 'now' | 'teams'>,
  seed: SeedAccount
): Promise<Result<User, DomainError>> {
  const email = normalizeEmail(seed.email);
  const problem =
    emailProblem(email) ??
    (seed.operatorChosen ? (seed.password.length === 0 ? '密码不能为空' : null) : passwordProblem(seed.password));
  if (problem) return err(invalid(`内置账号配置不对：${problem}`));
  const existing = await deps.users.byEmail(email);
  if (existing && existing.passwordHash !== null && (await deps.hasher.verify(seed.password, existing.passwordHash))) {
    return ok(existing);
  }
  const passwordHash = await deps.hasher.hash(seed.password);
  const now = deps.now();
  let user: User;
  if (existing) user = { ...existing, passwordHash };
  else {
    const id = newUserId();
    // 还没有 hub 管理员：内置账号就是 hub 管理员，带一个自己的团队；否则并进 hub 管理员的团队。
    const admin = await deps.users.hubAdmin();
    const team = admin?.teamId ? null : newTeamFor({ id, displayName: seed.displayName }, now);
    if (team) await deps.teams.save(team);
    user = {
      id,
      email,
      displayName: seed.displayName,
      role: seed.role,
      passwordHash,
      emailVerifiedAt: now,
      disabledAt: null,
      createdAt: now,
      teamId: team ? team.id : (admin?.teamId ?? null),
      hubAdmin: team !== null,
      deletedAt: null
    };
  }
  await deps.users.save(user);
  return ok(user);
}
