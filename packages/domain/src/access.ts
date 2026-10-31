import { NEVER_GRANTABLE } from './api-token.ts';
import type { HubSettings, Principal, Role } from './account.ts';

/**
 * 授权（ADR 0011）：权限是数据，角色只是一组权限；所有判断都走 can()。
 *
 * - 每个资源属于一个团队（teamId）。跨团队一律不行（hub 管理员也不读别人团队的数据）。
 * - 角色给的每条权限带一个范围：'team' = 团队里全部；'own' = 自己建的 + 共享给自己的。
 * - hub 级权限（hub.*）只看 hubAdmin，不看团队角色。
 * - 加角色（admin / viewer）= 往 ROLE_PERMISSIONS 里加一行，不改任何调用方。
 */
export type Permission =
  | 'project.read'
  | 'project.create'
  | 'project.update'
  | 'project.delete'
  | 'project.restore'
  | 'project.purge'
  | 'project.share'
  | 'session.read'
  | 'session.create'
  | 'session.control'
  | 'task.read'
  | 'task.write'
  | 'worker.read'
  | 'worker.use'
  | 'worker.use_local'
  | 'worker.enroll'
  | 'worker.manage'
  | 'runtime.install'
  | 'member.invite'
  | 'member.manage'
  | 'audit.read'
  | 'hub.settings'
  | 'hub.users'
  | 'hub.assets'
  // 资产上架与审核（ADR 0016）
  | 'asset.read'
  | 'asset.submit'
  | 'asset.review'
  | 'asset.assign'
  | 'asset.retire'
  | 'asset.secret.use'
  | 'asset.publish_global';

export type Scope = 'team' | 'own';

export type RolePermissions = Readonly<Partial<Record<Permission, Scope>>>;

const TEAM_ALL: RolePermissions = {
  'project.read': 'team',
  'project.create': 'team',
  'project.update': 'team',
  'project.delete': 'team',
  'project.restore': 'team',
  'project.purge': 'team',
  'project.share': 'team',
  'session.read': 'team',
  'session.create': 'team',
  'session.control': 'team',
  'task.read': 'team',
  'task.write': 'team',
  'worker.read': 'team',
  'worker.use': 'team',
  'worker.use_local': 'team',
  'worker.enroll': 'team',
  'worker.manage': 'team',
  'runtime.install': 'team',
  'member.invite': 'team',
  'member.manage': 'team',
  'audit.read': 'team',
  'asset.read': 'team',
  'asset.submit': 'team',
  'asset.review': 'team',
  'asset.assign': 'team',
  'asset.retire': 'team',
  'asset.secret.use': 'team'
};

/** 角色 → 权限集。改这里就是改授权模型；权限矩阵测试（access.test.ts）把它钉住。 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, RolePermissions>> = {
  owner: TEAM_ALL,
  member: {
    'project.read': 'own',
    'project.create': 'team',
    'project.update': 'own',
    'project.delete': 'own',
    'project.restore': 'own',
    'project.purge': 'own',
    'project.share': 'own',
    'session.read': 'own',
    'session.create': 'own',
    'session.control': 'own',
    'task.read': 'own',
    'task.write': 'own',
    'worker.read': 'team',
    'worker.use': 'team',
    // 本机 Worker 还要 hub 管理员单独授权（localWorkerGrants）
    'worker.use_local': 'team',
    'worker.enroll': 'team',
    'worker.manage': 'own',
    'runtime.install': 'own',
    'asset.read': 'team',
    'asset.submit': 'own',
    // 指定审核人另看团队审核设置（不是角色权限）
    'asset.assign': 'own',
    'asset.retire': 'own',
    'asset.secret.use': 'own'
  }
};

/** 只认 hubAdmin 的权限。 */
const HUB_PERMISSIONS: ReadonlySet<Permission> = new Set(['hub.settings', 'hub.users', 'hub.assets', 'asset.publish_global']);

/** 被判断的资源。项目下的任务、会话、工作空间都拿所在项目当资源。 */
export interface Resource {
  readonly teamId: string | null;
  /** 建的人；null = 无主（老数据、agent 建的），只有 'team' 范围的人能碰。 */
  readonly createdBy?: string | null;
  /** 共享给的人（项目成员列表）。 */
  readonly sharedWith?: readonly string[];
  /** 本机 Worker（hub 所在机器）。 */
  readonly local?: boolean;
}

/** 判断时需要的 hub 上下文：hub 管理员的团队、hub 设置。 */
export interface AccessContext {
  readonly hubTeamId: string | null;
  readonly hubAdminId?: string | null;
  readonly settings: Pick<HubSettings, 'localWorkerGrants' | 'membersCanAddMachines'>;
}

/**
 * 唯一的授权判断。principal 为 null = 没装账号体系（单机开发 / 单测），一律放行。
 * resource 不给 = 只问「有没有这项权限」（比如能不能新建项目）。
 */
export function can(
  principal: Principal | null,
  permission: Permission,
  resource?: Resource,
  context?: AccessContext
): boolean {
  if (principal === null) return true;
  const { user } = principal;
  if (user.disabledAt !== null || user.deletedAt !== null) return false;
  // 令牌：只在 scopes 打包的权限里取交集；本机 Worker 和 hub 级权限永远拿不到（ADR 0015）。
  if (principal.via) {
    if (NEVER_GRANTABLE.has(permission) || !principal.via.permissions.includes(permission)) return false;
    if (resource?.local) return false;
  }
  if (HUB_PERMISSIONS.has(permission)) return user.hubAdmin;
  const scope = ROLE_PERMISSIONS[user.role]?.[permission];
  if (!scope) return false;
  if (permission === 'worker.enroll' && user.role !== 'owner' && context && !context.settings.membersCanAddMachines) return false;
  if (resource === undefined) return true;
  if (resource.teamId === null || resource.teamId !== user.teamId) return false;
  if (resource.local) {
    // 本机 Worker 只属于 hub 管理员的团队；成员还要 hub 设置放行。
    // 默认只有 hub 管理员能用；hub 团队里的其他人要单独授权（hub 设置 localWorkerGrants）；别的团队永远不能。
    if (user.hubAdmin) return true;
    // 在本机上装运行时、管本机：只有 hub 管理员（单独授权也只授「用」）。
    if (permission === 'runtime.install' || permission === 'worker.manage') return false;
    if (!context || context.hubTeamId === null || context.hubTeamId !== user.teamId) return false;
    if (!context.settings.localWorkerGrants.includes(user.id)) return false;
  }
  if (scope === 'team') return true;
  if (resource.createdBy !== undefined && resource.createdBy !== null && resource.createdBy === user.id) return true;
  return resource.sharedWith?.includes(user.id) ?? false;
}

/** 列表过滤用：留下能 read 的。 */
export function visible<T>(
  principal: Principal | null,
  permission: Permission,
  items: readonly T[],
  resourceOf: (item: T) => Resource,
  context?: AccessContext
): T[] {
  return items.filter((item) => can(principal, permission, resourceOf(item), context));
}
