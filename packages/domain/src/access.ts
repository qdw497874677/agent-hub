import type { Principal } from './account.ts';

/**
 * 授权（ADR 0011 → ADR 0017）：权限是数据，角色只是一组权限；所有判断都走 can()。
 *
 * 三层：
 * - hub 级角色：集群管理员（User.clusterAdmin）。只有它持有 hub.* 和**本机 Worker（hub 主机）的全部权限**。
 * - 团队级角色：内置 owner / admin / member / viewer，加上团队自定义角色（数据定义，见 customRoleProblem）。
 * - 资源关系：创建者、共享（项目成员）、Worker 接入人，以及显式授权（AccessGrant）。
 *
 * 判断顺序固定（docs/design/permissions.md §3）：
 * 主体有效 → 令牌交集 → hub 级 → 本机 Worker 闸门 → 团队边界（含临时进入）→ 角色范围 → 资源关系 / 显式授权。
 */

/** 权限目录：每一项属于一种资源类型。自定义角色只能从这里挑（且不能挑 NEVER_GRANTABLE 和 hub 级的）。 */
export const PERMISSION_CATALOG = {
  worker: ['worker.read', 'worker.use', 'worker.enroll', 'worker.manage', 'worker.policy', 'worker.delete', 'runtime.install'],
  project: ['project.read', 'project.create', 'project.update', 'project.share', 'project.delete', 'project.restore', 'project.purge', 'agent.message.send', 'agent.ask', 'agent.spawn'],
  task: ['task.read', 'task.create', 'task.update', 'task.delete'],
  session: ['session.read', 'session.create', 'session.prompt', 'session.interrupt', 'session.fork', 'session.continue'],
  provider: ['provider.read', 'provider.use', 'provider.manage'],
  token: ['token.service'],
  audit: ['audit.read'],
  team: ['team.invite', 'team.manage', 'team.roles', 'team.grants'],
  // 资产上架与审核（ADR 0016）；发布到全局在 hub 级
  // 记忆（ADR 0019）：条目继承所在作用域的权限
  memory: ['memory.read', 'memory.write', 'memory.review', 'memory.forget', 'memory.purge', 'memory.export', 'memory.source.manage'],
  asset: ['asset.read', 'asset.submit', 'asset.review', 'asset.assign', 'asset.retire', 'asset.secret.use'],
  hub: ['hub.settings', 'hub.users', 'hub.assets', 'hub.providers', 'hub.visit', 'asset.publish_global']
} as const;

export type ResourceKind = keyof typeof PERMISSION_CATALOG;
export type Permission = (typeof PERMISSION_CATALOG)[ResourceKind][number];
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSION_CATALOG).flat();

/** 'team' = 团队里全部；'own' = 自己建的 / 共享给自己的 / 显式授权给自己的。 */
export type Scope = 'team' | 'own';
export type RolePermissions = Readonly<Partial<Record<Permission, Scope>>>;

/** 只认集群管理员的权限。 */
export const HUB_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(PERMISSION_CATALOG.hub);

/**
 * 任何令牌、显式授权、自定义角色都拿不到的权限。本机 Worker 的权限不在列表里，
 * 因为它们不是单独的权限点：can() 对 local 资源只认集群管理员（第 4 步）。
 */
export const NEVER_GRANTABLE: ReadonlySet<Permission> = new Set<Permission>([...PERMISSION_CATALOG.hub, 'team.roles']);

/**
 * 令牌额外拿不到的（ADR 0016）：审核 / 分配 / 下架 / 用密钥只能本人在界面里做。
 * 这些可以进自定义角色（比如「资产评审员」），但不能进令牌。
 */
export const TOKEN_NEVER_GRANTABLE: ReadonlySet<Permission> = new Set<Permission>([
  ...NEVER_GRANTABLE,
  'asset.review',
  'asset.assign',
  'asset.retire',
  'asset.secret.use',
  // 派生新会话要花钱、要人点头（ADR 0018）：只能本人在界面里批，令牌拿不到
  'agent.spawn',
  // 审核记忆、彻底删除记忆只能本人在界面里做（ADR 0019）
  'memory.review',
  'memory.purge'
]);

export type BuiltinRole = 'owner' | 'admin' | 'member' | 'viewer';
export const BUILTIN_ROLES: readonly BuiltinRole[] = ['owner', 'admin', 'member', 'viewer'];
export const isBuiltinRole = (role: string): role is BuiltinRole => (BUILTIN_ROLES as readonly string[]).includes(role);

const teamAll = (except: readonly Permission[] = []): RolePermissions =>
  Object.fromEntries(ALL_PERMISSIONS.filter((p) => !HUB_PERMISSIONS.has(p) && !except.includes(p)).map((p) => [p, 'team' as const]));

/** 内置角色 → 权限集。改这里就是改授权模型；access.test.ts 的矩阵把它钉住。 */
export const ROLE_PERMISSIONS: Readonly<Record<BuiltinRole, RolePermissions>> = {
  owner: teamAll(),
  // admin = owner 去掉「定义角色」和「彻底删除」；另外不能动 owner / 其他 admin（team.ts 里限制）。
  admin: teamAll(['team.roles', 'project.purge', 'memory.purge']),
  member: {
    'project.read': 'own',
    'project.create': 'team',
    'project.update': 'own',
    'project.share': 'own',
    'project.delete': 'own',
    'project.restore': 'own',
    'project.purge': 'own',
    // agent 间通信（ADR 0018）：在自己的 / 被共享的项目里互发消息、提问；派生新会话（agent.spawn）要单独授权
    'agent.message.send': 'own',
    'agent.ask': 'own',
    'task.read': 'own',
    'task.create': 'own',
    'task.update': 'own',
    'task.delete': 'own',
    'session.read': 'own',
    'session.create': 'own',
    // 会话自己的创建者（或显式授权）才能说话 / 中断 / 换机继续；分叉看项目。
    'session.prompt': 'own',
    'session.interrupt': 'own',
    'session.fork': 'own',
    'session.continue': 'own',
    'worker.read': 'team',
    'worker.use': 'team',
    'worker.enroll': 'team',
    'worker.manage': 'own',
    'worker.policy': 'own',
    'worker.delete': 'own',
    'runtime.install': 'own',
    'provider.read': 'team',
    'provider.use': 'team',
    'provider.manage': 'own',
    'asset.read': 'team',
    'asset.submit': 'own',
    // 指定审核人另看团队审核设置（access_grants 里的 asset.review 行）
    'asset.assign': 'own',
    'asset.retire': 'own',
    'asset.secret.use': 'own',
    // 记忆：自己的 / 共享给自己的作用域里读写、忘掉自己写的、导出；审核和来源管理要另外授权
    'memory.read': 'own',
    'memory.write': 'own',
    'memory.forget': 'own',
    'memory.export': 'own'
  },
  viewer: {
    'project.read': 'team',
    'task.read': 'team',
    'session.read': 'team',
    'worker.read': 'team',
    'provider.read': 'team',
    'asset.read': 'team',
    'memory.read': 'team'
  }
};

/** 团队自定义角色（ADR 0017 决定 6B）：存在 team_roles 表里，User.role = `custom:<id>`。 */
export interface CustomRole {
  readonly id: string;
  readonly teamId: string;
  readonly name: string;
  readonly permissions: RolePermissions;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export const CUSTOM_ROLE_PREFIX = 'custom:';
export const customRoleKey = (id: string): `custom:${string}` => `${CUSTOM_ROLE_PREFIX}${id}`;
export const customRoleId = (role: string): string | null => (role.startsWith(CUSTOM_ROLE_PREFIX) ? role.slice(CUSTOM_ROLE_PREFIX.length) : null);

/** 自定义角色能挑的：权限目录去掉 hub 级和 NEVER_GRANTABLE；范围不超过 admin。 */
export const CUSTOM_ROLE_GRANTABLE: readonly Permission[] = ALL_PERMISSIONS.filter(
  (p) => !HUB_PERMISSIONS.has(p) && !NEVER_GRANTABLE.has(p) && ROLE_PERMISSIONS.admin[p] !== undefined
);

/** 校验自定义角色的权限集；null = 没问题。 */
export function customRoleProblem(name: string, permissions: Readonly<Record<string, unknown>>): string | null {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > 40) return '角色名 1–40 个字';
  if (isBuiltinRole(trimmed)) return '不能和内置角色同名';
  for (const [permission, scope] of Object.entries(permissions)) {
    if (!(CUSTOM_ROLE_GRANTABLE as readonly string[]).includes(permission)) return `自定义角色不能包含 ${permission}`;
    if (scope !== 'team' && scope !== 'own') return `${permission} 的范围只能是 team 或 own`;
  }
  return null;
}

/** 显式授权（grants 表）：只补「own」范围，或集群管理员的临时进入（hub.visit）。 */
export interface AccessGrant {
  readonly id: string;
  /** 授权发生在哪个团队（资源所在团队）。 */
  readonly teamId: string;
  readonly userId: string;
  readonly permission: Permission;
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAt: number;
  /** null = 不过期（临时进入必须有）。 */
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}
export const accessGrantActive = (grant: AccessGrant, now: number): boolean =>
  grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > now);

/** 临时进入别的团队最长多久（ADR 0017 决定 5A）。 */
export const VISIT_MAX_MS = 24 * 60 * 60 * 1000;

/** 系统主体：hub 自己的后台任务、agent 经 MCP 调平台工具（工具网关另有自己的授权）。必须显式传，不再用 null 代表「放行」。 */
export interface SystemSubject {
  readonly system: true;
  readonly reason: string;
}
export const systemSubject = (reason: string): SystemSubject => ({ system: true, reason });
export type Subject = Principal | SystemSubject;
export const isSystem = (subject: Subject | null | undefined): subject is SystemSubject =>
  subject !== null && subject !== undefined && 'system' in subject && subject.system === true;

/** 被判断的资源。 */
export interface Resource {
  readonly kind?: ResourceKind;
  readonly id?: string;
  /** 所属团队；null = 不属于任何团队（hub 资源）。 */
  readonly teamId: string | null;
  /** 建的人 / 接入人；null = 无主（老数据），只有 'team' 范围的人能碰。 */
  readonly createdBy?: string | null;
  /** 共享给的人（项目成员列表）。 */
  readonly sharedWith?: readonly string[];
  /** 本机 Worker（hub 所在机器），或落在本机 Worker 上的东西。 */
  readonly local?: boolean;
  /** 个人资源（个人模型提供商）：只看 createdBy，不看团队。 */
  readonly personal?: boolean;
  /** hub 资源（全站模型提供商）：读 / 用对所有人开放，管理要 hub 级权限。 */
  readonly hub?: boolean;
}

/** 判断时需要的 hub 设置。 */
export interface AccessContext {
  /** 第一位集群管理员所在团队：没有接入凭据的老远端机器算它的。 */
  readonly hubTeamId: string | null;
  readonly settings: { readonly membersCanAddMachines: boolean };
}

/** 主体在团队里的权限集：内置角色查表；自定义角色用登录时解析好的 customRole。 */
export function rolePermissions(principal: Principal): RolePermissions {
  const role = principal.user.role;
  if (isBuiltinRole(role)) return ROLE_PERMISSIONS[role];
  const custom = principal.customRole;
  if (!custom || customRoleKey(custom.id) !== role || custom.teamId !== principal.user.teamId) return {};
  // 防御：库里的数据被改过也不放大权限
  return Object.fromEntries(Object.entries(custom.permissions).filter(([p]) => (CUSTOM_ROLE_GRANTABLE as readonly string[]).includes(p)));
}

/** 'own' 范围下只认创建者（或显式授权），被共享不算。 */
const CREATOR_ONLY: ReadonlySet<Permission> = new Set<Permission>(['project.share', 'project.delete', 'project.restore', 'project.purge']);

const isRead = (permission: Permission): boolean => permission.endsWith('.read');

const grantMatches = (principal: Principal, permission: Permission, resource: Resource): boolean =>
  resource.kind !== undefined &&
  resource.id !== undefined &&
  (principal.grants ?? []).some(
    (g) => g.userId === principal.user.id && g.permission === permission && g.resourceKind === resource.kind && g.resourceId === resource.id && g.revokedAt === null
  );

/** 集群管理员是否正临时进入这个团队（只读）。 */
export const visiting = (principal: Principal, teamId: string): boolean =>
  principal.user.clusterAdmin &&
  (principal.grants ?? []).some((g) => g.permission === 'hub.visit' && g.resourceKind === 'team' && g.resourceId === teamId && g.revokedAt === null);

/** 拒绝原因：错误文案和测试用。 */
export type DenyReason = 'anonymous' | 'disabled' | 'token' | 'hub_only' | 'local_worker' | 'team' | 'role' | 'relation' | 'setting';
export type Decision = { readonly allow: true } | { readonly allow: false; readonly reason: DenyReason };
const ALLOW: Decision = { allow: true };
const deny = (reason: DenyReason): Decision => ({ allow: false, reason });

/**
 * 唯一的授权判断。null（没认证）一律拒绝；系统主体一律放行。
 * resource 不给 = 只问「有没有这项权限」（比如能不能新建项目）。
 */
export function decide(subject: Subject | null | undefined, permission: Permission, resource?: Resource, context?: AccessContext): Decision {
  // 1. 主体
  if (subject === null || subject === undefined) return deny('anonymous');
  if (isSystem(subject)) return ALLOW;
  const { user } = subject;
  if (user.disabledAt !== null || user.deletedAt !== null) return deny('disabled');
  // 2. 令牌：只在 scopes 打包的权限里取交集；本机 Worker 和 hub 级永远拿不到（ADR 0015）
  if (subject.via) {
    if (TOKEN_NEVER_GRANTABLE.has(permission) || !subject.via.permissions.includes(permission)) return deny('token');
    if (resource?.local) return deny('local_worker');
  }
  // 3. hub 级
  if (HUB_PERMISSIONS.has(permission)) return user.clusterAdmin ? ALLOW : deny('hub_only');
  // 4. 本机 Worker：只有集群管理员，团队角色、授权、自定义角色都不参与
  if (resource?.local) return user.clusterAdmin ? ALLOW : deny('local_worker');
  // 5. hub 资源（全站提供商）：读 / 用看角色有没有这项，管理走 hub.providers（调用方传）
  const perms = rolePermissions(subject);
  const scope = perms[permission];
  if (resource?.hub) return scope ? ALLOW : deny('role');
  // 6. 个人资源
  if (resource?.personal) return scope && resource.createdBy === user.id ? ALLOW : deny('relation');
  // 7. 团队边界（集群管理员临时进入：只读）
  if (resource !== undefined && (resource.teamId === null || resource.teamId !== user.teamId)) {
    return resource.teamId !== null && isRead(permission) && visiting(subject, resource.teamId) ? ALLOW : deny('team');
  }
  // 8. 角色范围
  if (!scope) return deny('role');
  if (permission === 'worker.enroll' && context && !context.settings.membersCanAddMachines && user.role !== 'owner' && user.role !== 'admin') {
    return deny('setting');
  }
  if (resource === undefined || scope === 'team') return ALLOW;
  // 9. 资源关系 / 显式授权
  if (resource.createdBy !== undefined && resource.createdBy !== null && resource.createdBy === user.id) return ALLOW;
  // 被共享的人能协作（读、建任务、改），但不能再共享、删除、彻底删除别人的项目
  if (resource.sharedWith?.includes(user.id) && !CREATOR_ONLY.has(permission)) return ALLOW;
  return grantMatches(subject, permission, resource) ? ALLOW : deny('relation');
}

export function can(subject: Subject | null | undefined, permission: Permission, resource?: Resource, context?: AccessContext): boolean {
  return decide(subject, permission, resource, context).allow;
}

/** 列表过滤用：留下能 read 的。 */
export function visible<T>(
  subject: Subject | null,
  permission: Permission,
  items: readonly T[],
  resourceOf: (item: T) => Resource,
  context?: AccessContext
): T[] {
  return items.filter((item) => can(subject, permission, resourceOf(item), context));
}

/** 拒绝原因 → 给人看的话。 */
export const DENY_MESSAGES: Readonly<Record<DenyReason, string>> = {
  anonymous: '请先登录',
  disabled: '账号已停用',
  token: '这个令牌没有这项权限',
  hub_only: '只有集群管理员能这么做',
  local_worker: '本机 Worker（hub 主机）只对集群管理员开放',
  team: '不在你的团队里',
  role: '你的角色没有这项权限',
  relation: '只有创建者、被共享或被授权的人能这么做',
  setting: 'hub 设置不允许成员这么做'
};

/** 主体背后的账号；系统主体 / 没认证是 null（审计、createdBy 用）。 */
export const principalOfSubject = (subject: Subject | null | undefined): Principal | null =>
  subject === null || subject === undefined || isSystem(subject) ? null : subject;
