import type { Principal, User } from '../account.ts';
import { passwordProblem } from '../account.ts';
import { invalid } from '../errors.ts';
import type { DomainError } from '../errors.ts';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import type { AccountDeps } from './accounts.ts';
import { post } from './account-mail.ts';
import { securityEvent } from './team.ts';

/** 个人设置：改密码、改显示名（ADR 0011）。 */
export interface ChangePasswordCommand {
  readonly oldPassword: string;
  readonly newPassword: string;
  readonly ip?: string | null;
}

const WRONG_OLD = invalid('原密码不对');

/** 改密码：要原密码；成功后踢掉这个人别的登录（留下当前这台），发「密码已修改」通知。 */
export async function changePassword(
  deps: AccountDeps,
  principal: Principal,
  command: ChangePasswordCommand
): Promise<Result<User, DomainError>> {
  const user = await deps.users.byId(principal.user.id);
  if (!user || user.passwordHash === null) return err(WRONG_OLD);
  if (!(await deps.hasher.verify(command.oldPassword, user.passwordHash))) {
    await securityEvent(deps, user, 'auth.password_change', user.email, '原密码不对', command.ip ?? null);
    return err(WRONG_OLD);
  }
  const problem = passwordProblem(command.newPassword);
  if (problem) return err(invalid(problem));
  if (command.newPassword === command.oldPassword) return err(invalid('新密码和原密码一样'));
  const now = deps.now();
  const next: User = { ...user, passwordHash: await deps.hasher.hash(command.newPassword) };
  await deps.users.save(next);
  await deps.logins.removeForUser(user.id, principal.loginId);
  await deps.oneTimeTokens.revokeForUser(user.id, 'reset-password', now);
  post(deps, { kind: 'password-changed', to: user.email, displayName: user.displayName, at: now });
  await securityEvent(deps, user, 'auth.password_change', user.email, '成功', command.ip ?? null);
  return ok(next);
}

export async function updateProfile(
  deps: AccountDeps,
  principal: Principal,
  command: { readonly displayName: string; readonly ip?: string | null }
): Promise<Result<User, DomainError>> {
  const displayName = command.displayName.trim();
  if (displayName === '') return err(invalid('名字不能为空'));
  if (displayName.length > 60) return err(invalid('名字太长了'));
  const user = await deps.users.byId(principal.user.id);
  if (!user) return err(invalid('账号不存在'));
  if (user.displayName === displayName) return ok(user);
  const next = { ...user, displayName };
  await deps.users.save(next);
  await securityEvent(deps, user, 'auth.profile', user.email, `显示名 ${user.displayName} → ${displayName}`, command.ip ?? null);
  return ok(next);
}
