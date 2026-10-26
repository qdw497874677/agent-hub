import type { Role, User, UserId } from '../account.ts';

export interface UserRepository {
  save(user: User): Promise<void>;
  byId(id: UserId): Promise<User | null>;
  /** 参数必须是规范化后的邮箱。 */
  byEmail(email: string): Promise<User | null>;
  /** 最早创建的、未停用的某个角色的人；HUB_TOKEN 登录落在最早的 Owner 身上。 */
  firstWithRole(role: Role): Promise<User | null>;
  /**
   * 仅当还没有未停用的 Owner 时，把 user 以 Owner 身份插入；判断和插入是一个原子操作，
   * 并发注册时只有一个人能抢到。返回是否插入成功。
   */
  claimFirstOwner(user: User): Promise<boolean>;
  list(): Promise<User[]>;
}
