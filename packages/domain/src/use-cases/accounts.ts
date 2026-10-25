import type { Login, Principal, Role, User } from '../account.ts';
import {
  LOGIN_TOUCH_INTERVAL_MS,
  LOGIN_TTL_MS,
  defaultDisplayName,
  emailProblem,
  loginUsable,
  newLoginId,
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
import type { SettingsRepository } from '../ports/settings-repository.ts';

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

async function issueLogin(
  deps: Pick<AccountDeps, 'logins' | 'tokens' | 'now'>,
  user: User,
  method: Login['method'],
  userAgent: string | null
): Promise<IssuedLogin> {
  const { token, hash } = deps.tokens.issue();
  const now = deps.now();
  const expiresAt = now + LOGIN_TTL_MS;
  await deps.logins.save({ id: newLoginId(), userId: user.id, tokenHash: hash, method, userAgent, createdAt: now, lastSeenAt: now, expiresAt });
  return { token, user, expiresAt };
}

export interface RegisterCommand {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
  readonly userAgent?: string | null;
}

/**
 * 开放注册。还没有 Owner 时第一个注册的人就是 Owner（首启认领）；之后注册的都是成员。
 * 邮箱验证在下一期（见设计 §16），这期先不卡登录。
 */
export async function registerUser(
  deps: AccountDeps,
  command: RegisterCommand
): Promise<Result<IssuedLogin, DomainError>> {
  const email = normalizeEmail(command.email);
  const problem = emailProblem(email) ?? passwordProblem(command.password);
  if (problem) return err(invalid(problem));
  if (await deps.users.byEmail(email)) return err(conflict('这个邮箱已经注册过了，直接登录吧'));

  const role: Role = (await deps.users.firstWithRole('owner')) === null ? 'owner' : 'member';
  // 关闭开放注册后，仍允许「还没有主人」时认领第一个账号，否则 hub 进不去了。
  if (role === 'member' && !(await deps.settings.get()).openRegistration) {
    return err(conflict('这个 hub 暂不开放注册，请联系管理员'));
  }
  const user: User = {
    id: newUserId(),
    email,
    displayName: command.displayName?.trim() || defaultDisplayName(email),
    role,
    passwordHash: await deps.hasher.hash(command.password),
    emailVerifiedAt: null,
    disabledAt: null,
    createdAt: deps.now()
  };
  await deps.users.save(user);
  // 欢迎信是锦上添花：发不出去不该让注册失败。
  void deps.mail
    .send({ to: email, subject: '欢迎使用 agent-hub', text: `${user.displayName}，你的 agent-hub 账号已经建好了。` })
    .catch(() => undefined);
  return ok(await issueLogin(deps, user, 'password', command.userAgent ?? null));
}

export interface PasswordLoginCommand {
  readonly email: string;
  readonly password: string;
  readonly userAgent?: string | null;
}

export async function loginWithPassword(
  deps: Pick<AccountDeps, 'users' | 'logins' | 'hasher' | 'tokens' | 'now'>,
  command: PasswordLoginCommand
): Promise<Result<IssuedLogin, DomainError>> {
  const user = await deps.users.byEmail(normalizeEmail(command.email));
  if (!user || user.passwordHash === null) {
    decoy ??= deps.hasher.hash('decoy-password-for-timing');
    await deps.hasher.verify(command.password, await decoy);
    return err(BAD_CREDENTIALS);
  }
  if (!(await deps.hasher.verify(command.password, user.passwordHash))) return err(BAD_CREDENTIALS);
  if (user.disabledAt !== null) return err(DISABLED);
  return ok(await issueLogin(deps, user, 'password', command.userAgent ?? null));
}

/**
 * 过渡期：拿旧的共享 HUB_TOKEN 换一个登录，落在最早的 Owner 身上。
 * 令牌本身对不对、过渡期过没过，是部署层面的事，由调用方判断后才进来。
 */
export async function loginAsFirstOwner(
  deps: Pick<AccountDeps, 'users' | 'logins' | 'tokens' | 'now'>,
  userAgent: string | null
): Promise<Result<IssuedLogin, DomainError>> {
  const owner = await deps.users.firstWithRole('owner');
  if (!owner) return err(conflict('还没有任何账号：先注册一个，第一个注册的人就是主人'));
  return ok(await issueLogin(deps, owner, 'hub-token', userAgent));
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
  deps: Pick<AccountDeps, 'users' | 'hasher' | 'now'>,
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
  const user: User = existing
    ? { ...existing, passwordHash }
    : {
        id: newUserId(),
        email,
        displayName: seed.displayName,
        role: seed.role,
        passwordHash,
        emailVerifiedAt: now,
        disabledAt: null,
        createdAt: now
      };
  await deps.users.save(user);
  return ok(user);
}
