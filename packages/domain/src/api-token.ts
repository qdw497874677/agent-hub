import { BOT_PERMISSIONS, TOKEN_NEVER_GRANTABLE, type Permission } from './access.ts';
import type { User } from './account.ts';

export { BOT_PERMISSIONS };

/**
 * 开放 API 令牌（ADR 0015）：个人令牌（代表本人）和团队服务账号（团队里的一个虚拟成员）。
 * 有效权限 = 账号角色的权限 ∩ 令牌 scopes 打包出来的权限；判断仍只走 can()。
 */
export type ApiScope =
  | 'projects:read'
  | 'projects:write'
  | 'sessions:read'
  | 'sessions:write'
  | 'workers:read'
  | 'assets:submit'
  | 'assets:read'
  | 'assets:write'
  | 'assets:publish'
  | 'providers:read'
  | 'providers:use'
  | 'providers:manage'
  | 'groups:write'
  | 'files:read'
  | 'memory:read'
  | 'memory:write';
export const API_SCOPES: readonly ApiScope[] = [
  'projects:read',
  'projects:write',
  'sessions:read',
  'sessions:write',
  'workers:read',
  'assets:submit',
  'assets:read',
  'assets:write',
  'assets:publish',
  'providers:read',
  'providers:use',
  'providers:manage',
  'groups:write',
  'files:read',
  'memory:read',
  'memory:write'
];

/** scope → 权限点。这里永远不出现 hub.*；本机 Worker 在 can() 里对令牌一律拒绝。 */
export const SCOPE_PERMISSIONS: Readonly<Record<ApiScope, readonly Permission[]>> = {
  'projects:read': ['project.read', 'task.read'],
  'projects:write': ['project.read', 'task.read', 'project.create', 'project.update', 'project.delete', 'task.create', 'task.update'],
  'sessions:read': ['session.read', 'task.read'],
  'sessions:write': ['session.read', 'task.read', 'session.create', 'session.prompt', 'session.interrupt', 'session.fork', 'session.continue', 'session.settle', 'git.push', 'worker.use', 'worker.read'],
  // 不并进 sessions:write。用之前先要看得见，所以带上 provider.read，不含管理。
  'providers:read': ['provider.read'],
  'providers:use': ['provider.read', 'provider.use'],
  // 管理：同时能看、能用。全站提供商和机器路由仍要账号本身是集群管理员（令牌拿不到 hub.providers）。
  'providers:manage': ['provider.read', 'provider.use', 'provider.manage'],
  'workers:read': ['worker.read'],
  // 群里说话：先得看得见项目（bot 只在自己项目里发言）
  'groups:write': ['project.read', 'group.post'],
  // 读会话工作空间里的文件
  'files:read': ['project.read', 'workspace.files.read'],
  // 记忆：读 / 写分成两个 scope，读不给写
  'memory:read': ['project.read', 'memory.read'],
  'memory:write': ['project.read', 'memory.read', 'memory.write'],
  // ADR 0016：令牌默认只能提交资产版本（进审核队列），审核 / 发布 / 分配 / 下架 / 用密钥都不行。
  // 要自动化发布与分配，得显式给 assets:publish（见下）——仍然是令牌，审计里留痕。
  // 能交版本就得能看见自己在交哪一份（否则拿不到 assetId）
  'assets:submit': ['asset.read', 'asset.submit'],
  // 读资产：可见范围仍按归属判断（全局 / 团队 / 项目 / 个人）
  'assets:read': ['asset.read'],
  // 建资产与交新版本：默认只进审核队列（publish=false），审核通过才可用
  'assets:write': ['asset.read', 'asset.submit'],
  // 自动化发布与分配（ADR 0016 的显式例外）：仅个人令牌 / 团队服务账号可用，审计留痕。
  // 这是唯一映射审核 / 分配这几个点的 scope —— 其余 scope 都不映射它们。
  // 分配要落到具体机器（#230）：带上团队内的 worker.read / worker.use，跨团队的机器仍然会被拒。
  // 发布项目级资产要先看得见那个项目（#230）；能不能发仍然按账号的项目成员身份复核。
  'assets:publish': ['asset.read', 'asset.submit', 'asset.review', 'asset.assign', 'worker.read', 'worker.use', 'project.read']
};


export function permissionsOf(scopes: readonly ApiScope[]): Permission[] {
  const out = new Set<Permission>();
  for (const scope of scopes) for (const permission of SCOPE_PERMISSIONS[scope] ?? []) if (!TOKEN_NEVER_GRANTABLE.has(permission)) out.add(permission);
  return [...out];
}

export type ApiTokenKind = 'personal' | 'service' | 'bot';

export interface ApiToken {
  readonly id: string;
  readonly teamId: string;
  readonly kind: ApiTokenKind;
  /** 用这个令牌的身份：个人令牌 = 本人；服务账号 = 那个服务账号用户；bot = 签发人（审计用）。 */
  readonly userId: string;
  /** 只有 kind === 'bot' 才有：这个凭据属于哪个项目的哪个 bot（name 即 @id）。 */
  readonly bot?: { readonly projectId: string; readonly name: string };
  /**
   * 个人 / 服务账号令牌限定的项目（外部接入页的「只给这几个项目」）。
   * 不给 / null = 不限项目（老令牌都是这样）；给了 = can() 只放行这些项目里的资源，也不能新建项目。
   */
  readonly projectIds?: readonly string[] | null;
  readonly name: string;
  readonly scopes: readonly ApiScope[];
  /** 明文开头几位，列表里认令牌用（不是秘密）。 */
  readonly prefix: string;
  readonly tokenHash: string;
  readonly createdBy: string;
  readonly createdAt: number;
  /** null = 永不过期（要显式选）；创建时不给 = DEFAULT_TOKEN_TTL_MS。bot 凭据恒为 null，不能设。 */
  readonly expiresAt: number | null;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

/** 令牌明文前缀：便于泄露扫描、也让鉴权一眼分得清。 */
/** 用户自建令牌（个人 / 服务账号）的默认有效期：30 天。永不过期要显式选（GitHub / Cursor 也是默认带期限）。bot 凭据不适用。 */
export const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const API_TOKEN_PREFIX = 'ahp_';
/** bot 凭据的独立前缀：鉴权看一眼就知道这是项目内收窄的身份（C1）。 */
export const BOT_TOKEN_PREFIX = 'ahb_';

/**
 * bot 令牌能做什么见 access.ts 的 BOT_PERMISSIONS（decide() 与这里共用一份，见上面的 re-export）。
 * 有效权限是它的**子集**：permissionsOf(scopes) ∩ BOT_PERMISSIONS，所以请求更宽的 scope 也不会越权。
 */
/** 令牌的有效权限：bot 令牌再与 BOT_PERMISSIONS 取交集，其余令牌就是 scopes 打包出来的权限。 */
export function effectivePermissions(token: Pick<ApiToken, 'kind' | 'scopes'>): Permission[] {
  const granted = permissionsOf(token.scopes);
  return token.kind === 'bot' ? granted.filter((permission) => BOT_PERMISSIONS.has(permission)) : granted;
}

/** 服务账号的占位邮箱域：保留域 .invalid，永远收不到信、也登录不了（没有密码）。 */
export const SERVICE_EMAIL_DOMAIN = '@service.agent-hub.invalid';

export const isServiceAccount = (user: Pick<User, 'email'>): boolean => user.email.endsWith(SERVICE_EMAIL_DOMAIN);

/** bot 凭据（项目里 IM / 群聊 bot 内置的那份）永不过期：只看吊销。老库里就算存了到期时间也不算数。 */
export function apiTokenUsable(token: ApiToken, now: number): boolean {
  if (token.revokedAt !== null) return false;
  return token.kind === 'bot' || token.expiresAt === null || token.expiresAt > now;
}

/** 请求是经令牌来的：挂在 Principal 上，can() 据此取交集，审计据此写「via 令牌」。 */
export interface TokenVia {
  readonly tokenId: string;
  readonly name: string;
  readonly kind: ApiTokenKind;
  readonly permissions: readonly Permission[];
  /** bot 令牌的项目归属：can() 用它把权限收窄到这一个项目（C1）。 */
  readonly bot?: { readonly projectId: string; readonly name: string };
  /** 限定项目的令牌：can() 只放行这些项目里的资源（见 ApiToken.projectIds）。 */
  readonly projectIds?: readonly string[];
  /**
   * 限定项目所在的团队（每次认证时按项目现查）：和项目成员一样能用这些团队的团队级资产。
   * 项目不在团队里（hub 项目）就没有这一项；别的团队的资产一律看不见。
   */
  readonly teamIds?: readonly string[];
}

/**
 * 限定项目的令牌能看到哪些资产（null = 令牌没限定项目，按账号本身的规则）：
 * - 全局资产：能读（和成员一样，只看已发布的，由调用方再判）；
 * - 团队资产：只有限定项目所在团队的；
 * - 项目资产：只有限定的项目里的；
 * - 个人资产：看不到（个人资产不属于任何项目，限定项目就是为了不外泄这类东西）。
 */
export function scopedTokenSeesAsset(
  via: TokenVia | undefined,
  asset: { readonly scope: 'global' | 'team' | 'project' | 'personal'; readonly teamId: string | null; readonly projectId: string | null }
): boolean | null {
  const scoped = via?.projectIds;
  if (!scoped) return null;
  if (asset.scope === 'global') return true;
  if (asset.scope === 'personal') return false;
  if (asset.scope === 'team') return asset.teamId !== null && (via?.teamIds ?? []).includes(asset.teamId);
  return asset.projectId !== null && scoped.includes(asset.projectId);
}
