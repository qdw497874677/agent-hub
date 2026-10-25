import type { Login, LoginId, UserId } from '../account.ts';

export interface LoginRepository {
  save(login: Login): Promise<void>;
  byTokenHash(tokenHash: string): Promise<Login | null>;
  touch(id: LoginId, lastSeenAt: number, expiresAt: number): Promise<void>;
  remove(id: LoginId): Promise<void>;
  removeForUser(userId: UserId): Promise<void>;
}
