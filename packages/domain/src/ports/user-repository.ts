import type { Role, User, UserId } from '../account.ts';

export interface UserRepository {
  save(user: User): Promise<void>;
  byId(id: UserId): Promise<User | null>;
  /** 参数必须是规范化后的邮箱。 */
  byEmail(email: string): Promise<User | null>;
  /** 最早创建的、未停用的某个角色的人；HUB_TOKEN 登录落在最早的 Owner 身上。 */
  firstWithRole(role: Role): Promise<User | null>;
  list(): Promise<User[]>;
}
