import type { OneTimePurpose, User } from '../account.ts';
import { ONE_TIME_TOKEN_TTL_MS, isEmailVerified } from '../account.ts';
import type { AccountMail } from '../ports/email-sender.ts';
import type { AccountDeps } from './accounts.ts';

/** 发验证 / 重置信的公共部分：单独一个文件，accounts.ts 与 account-email.ts 都用，避免循环 import。 */
export type MailDeps = Pick<AccountDeps, 'oneTimeTokens' | 'tokens' | 'mail' | 'now'>;

/** 发信失败不影响主流程（适配器会记日志）；只等它入队，不等投递。 */
export function post(deps: Pick<AccountDeps, 'mail'>, mail: AccountMail): void {
  void deps.mail.send(mail).catch(() => undefined);
}

export async function issueOneTime(deps: MailDeps, user: User, purpose: OneTimePurpose): Promise<{ token: string; expiresAt: number }> {
  const now = deps.now();
  await deps.oneTimeTokens.revokeForUser(user.id, purpose, now); // 新链接一发，旧链接作废
  const { token, hash } = deps.tokens.issue();
  const expiresAt = now + ONE_TIME_TOKEN_TTL_MS;
  await deps.oneTimeTokens.save({ tokenHash: hash, purpose, userId: user.id, email: user.email, createdAt: now, expiresAt, usedAt: null });
  return { token, expiresAt };
}

/** 发一封验证信（注册时、点「重发」时）。已验证的人什么也不做。 */
export async function sendVerification(deps: MailDeps, user: User): Promise<void> {
  if (isEmailVerified(user)) return;
  const { token, expiresAt } = await issueOneTime(deps, user, 'verify-email');
  post(deps, { kind: 'verify-email', to: user.email, displayName: user.displayName, token, expiresAt });
}

