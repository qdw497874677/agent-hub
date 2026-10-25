import type { Login, LoginActivity, LoginId, UserId } from '../account.ts';

export interface LoginRepository {
  save(login: Login): Promise<void>;
  byTokenHash(tokenHash: string): Promise<Login | null>;
  touch(id: LoginId, lastSeenAt: number, expiresAt: number): Promise<void>;
  remove(id: LoginId): Promise<void>;
  /** 删掉这个人的全部登录态；`keep` 留下一条（踢掉自己其他设备时留住当前这台）。 */
  removeForUser(userId: UserId, keep?: LoginId): Promise<void>;
  /** 最近创建的 N 条登录（新的在前）。 */
  recent(limit: number): Promise<Login[]>;
  /** 每个人的最近活动；`now` 用来判断哪些还没过期。 */
  activity(now: number): Promise<LoginActivity[]>;
}
