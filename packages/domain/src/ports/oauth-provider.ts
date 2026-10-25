/**
 * 第三方登录（Google OIDC）。设计见 docs/design/accounts.md §6.5，**本期只定端口不接实现**。
 * 实现方必须：授权码 + PKCE(S256) + state + nonce；回调地址只来自配置，不从请求推导；
 * exchange 返回前已校验 id_token 的 iss / aud / exp / nonce。
 */
export interface OAuthStart {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

export interface OAuthProfile {
  /** 提供方的稳定用户 id（Google 的 sub），不是邮箱。 */
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string | null;
}

export interface OAuthProvider {
  readonly id: 'google';
  authorizeUrl(start: OAuthStart): string;
  exchange(code: string, codeVerifier: string, redirectUri: string): Promise<OAuthProfile>;
}
