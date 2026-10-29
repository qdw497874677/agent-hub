import type { Login, LoginId, Principal, User } from '../account.ts';
import { emailProblem, isEmailVerified, normalizeEmail, passwordProblem } from '../account.ts';
import { conflict, invalid, notFound } from '../errors.ts';
import type { DomainError } from '../errors.ts';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import { issueOneTime, post, sendVerification } from './account-mail.ts';
import type { MailDeps } from './account-mail.ts';
export { sendVerification };
import { issueLogin } from './accounts.ts';
import type { AccountDeps, ClientInfo, IssuedLogin } from './accounts.ts';

/**
 * 账号 P3（docs/design/accounts.md §6.2 / §6.4 / §16）：验证邮箱、找回密码、登录设备。
 * 限流（每 IP / 每邮箱每小时 5 次）在 HTTP 层；这里只管规则。
 */
/** 一个令牌链接坏了就是坏了：不细分「过期」「用过」「不存在」，免得被拿来试探。 */
const BAD_LINK = invalid('链接无效或已过期，请重新申请');

export async function resendVerification(
  deps: MailDeps & Pick<AccountDeps, 'users'>,
  principal: Principal
): Promise<Result<{ alreadyVerified: boolean }, DomainError>> {
  const user = await deps.users.byId(principal.user.id);
  if (!user) return err(notFound('账号不存在'));
  if (isEmailVerified(user)) return ok({ alreadyVerified: true });
  await sendVerification(deps, user);
  return ok({ alreadyVerified: false });
}

/** 点了验证链接。不要求登录：在手机上点开电脑注册的链接也该能用。 */
export async function verifyEmail(
  deps: Pick<AccountDeps, 'users' | 'oneTimeTokens' | 'tokens' | 'now'>,
  token: string
): Promise<Result<User, DomainError>> {
  if (token === '') return err(BAD_LINK);
  const now = deps.now();
  const used = await deps.oneTimeTokens.consume(deps.tokens.hashOf(token), 'verify-email', now);
  if (!used) return err(BAD_LINK);
  const user = await deps.users.byId(used.userId);
  // 令牌签发后改过邮箱（以后会有）就不算数
  if (!user || user.email !== used.email) return err(BAD_LINK);
  if (isEmailVerified(user)) return ok(user);
  const next: User = { ...user, emailVerifiedAt: now };
  await deps.users.save(next);
  return ok(next);
}

/**
 * 忘记密码。无论邮箱存不存在、账号停没停用，调用方都回同一句话（防枚举），
 * 所以这里不返回任何东西；信是异步发的，响应时间也不随之变化。
 */
export async function requestPasswordReset(
  deps: MailDeps & Pick<AccountDeps, 'users'>,
  rawEmail: string
): Promise<void> {
  const email = normalizeEmail(rawEmail);
  if (emailProblem(email)) return;
  const user = await deps.users.byEmail(email);
  if (!user || user.disabledAt !== null) return;
  const { token, expiresAt } = await issueOneTime(deps, user, 'reset-password');
  post(deps, { kind: 'reset-password', to: user.email, displayName: user.displayName, token, expiresAt });
}

export interface ResetPasswordCommand extends ClientInfo {
  readonly token: string;
  readonly password: string;
}

/**
 * 设新密码：密码先过规则（不合格不消耗令牌，改了再提交还能用），再用掉令牌。
 * 成功后踢掉这个人的全部登录、直接给这台设备签一个新的，并发「密码已修改」通知。
 * 能收到重置信就证明邮箱是他的，所以顺手标记已验证。
 */
export async function resetPassword(
  deps: AccountDeps,
  command: ResetPasswordCommand
): Promise<Result<IssuedLogin, DomainError>> {
  const problem = passwordProblem(command.password);
  if (problem) return err(invalid(problem));
  if (command.token === '') return err(BAD_LINK);
  const now = deps.now();
  const used = await deps.oneTimeTokens.consume(deps.tokens.hashOf(command.token), 'reset-password', now);
  if (!used) return err(BAD_LINK);
  const user = await deps.users.byId(used.userId);
  if (!user || user.email !== used.email) return err(BAD_LINK);
  if (user.disabledAt !== null) return err(conflict('这个账号已被停用'));
  const next: User = {
    ...user,
    passwordHash: await deps.hasher.hash(command.password),
    emailVerifiedAt: user.emailVerifiedAt ?? now
  };
  await deps.users.save(next);
  await deps.logins.removeForUser(user.id);
  await deps.oneTimeTokens.revokeForUser(user.id, 'reset-password', now);
  post(deps, { kind: 'password-changed', to: user.email, displayName: user.displayName, at: now });
  return ok(await issueLogin(deps, next, 'password', command));
}

export interface LoginDevice {
  readonly login: Login;
  readonly current: boolean;
}

/** 我的登录设备：只列没过期的，当前这台排第一。 */
export async function listMyLogins(deps: Pick<AccountDeps, 'logins' | 'now'>, principal: Principal): Promise<LoginDevice[]> {
  const now = deps.now();
  return (await deps.logins.forUser(principal.user.id))
    .filter((login) => login.expiresAt > now)
    .map((login) => ({ login, current: login.id === principal.loginId }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.login.lastSeenAt - a.login.lastSeenAt);
}

/** 登出某一台设备。只能动自己的；登出当前这台等于退出登录。 */
export async function revokeMyLogin(
  deps: Pick<AccountDeps, 'logins'>,
  principal: Principal,
  loginId: LoginId
): Promise<Result<{ current: boolean }, DomainError>> {
  const mine = (await deps.logins.forUser(principal.user.id)).some((login) => login.id === loginId);
  if (!mine) return err(notFound('没有这个登录'));
  await deps.logins.remove(loginId);
  return ok({ current: loginId === principal.loginId });
}

/** 「登出其他所有设备」：留下当前这台。 */
export async function revokeMyOtherLogins(deps: Pick<AccountDeps, 'logins'>, principal: Principal): Promise<void> {
  await deps.logins.removeForUser(principal.user.id, principal.loginId);
}
