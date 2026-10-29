/**
 * 账号相关的信。domain 只说「发哪种信、给谁、带什么令牌」，
 * 措辞（中文模板）、链接的域名、走哪家发信服务都是适配器的事。
 */
export type AccountMail =
  | { readonly kind: 'verify-email'; readonly to: string; readonly displayName: string; readonly token: string; readonly expiresAt: number }
  | { readonly kind: 'reset-password'; readonly to: string; readonly displayName: string; readonly token: string; readonly expiresAt: number }
  | { readonly kind: 'password-changed'; readonly to: string; readonly displayName: string; readonly at: number };

/** 发信。没配发信服务时由「只打日志」的实现顶上。 */
export interface EmailSender {
  send(mail: AccountMail): Promise<void>;
}
