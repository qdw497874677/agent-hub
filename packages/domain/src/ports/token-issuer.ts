/**
 * 高熵随机令牌。只把 hash 落库；令牌本身只交给持有者一次。
 * 高熵令牌用快哈希（SHA-256）即可，不需要加盐慢哈希。
 */
export interface TokenIssuer {
  issue(): { readonly token: string; readonly hash: string };
  hashOf(token: string): string;
}
