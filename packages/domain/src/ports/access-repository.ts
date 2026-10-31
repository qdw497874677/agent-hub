import type { AccessGrant, CustomRole } from '../access.ts';

/** 显式授权（access_grants 表，ADR 0017）。只增，撤销写 revoked_at。 */
export interface AccessGrantRepository {
  save(grant: AccessGrant): Promise<void>;
  byId(id: string): Promise<AccessGrant | null>;
  /** 给某人的、在 now 时刻有效的授权（认证时挂到 Principal 上）。 */
  activeFor(userId: string, now: number): Promise<AccessGrant[]>;
  /** 某团队里的授权（含过期 / 撤销的，界面列表用）。 */
  listByTeam(teamId: string): Promise<AccessGrant[]>;
}

/** 团队自定义角色（team_roles 表）。 */
export interface TeamRoleRepository {
  save(role: CustomRole): Promise<void>;
  byId(id: string): Promise<CustomRole | null>;
  listByTeam(teamId: string): Promise<CustomRole[]>;
  delete(id: string): Promise<void>;
}
