import type { OneTimePurpose, OneTimeToken, UserId } from '../account.ts';

export interface OneTimeTokenRepository {
  save(token: OneTimeToken): Promise<void>;
  /**
   * 原子地「用掉」一个令牌：哈希和用途对得上、没用过、没过期，才标记为已用并返回它；
   * 否则返回 null。并发点两次同一个链接只有一次成功。
   */
  consume(tokenHash: string, purpose: OneTimePurpose, now: number): Promise<OneTimeToken | null>;
  /** 作废这个人某种用途下还没用的令牌（重发验证信、重置成功后调）。 */
  revokeForUser(userId: UserId, purpose: OneTimePurpose, now: number): Promise<void>;
}
