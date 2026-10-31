import type { Permission } from './access.ts';
import type { User } from './account.ts';

/**
 * 开放 API 令牌（ADR 0015）：个人令牌（代表本人）和团队服务账号（团队里的一个虚拟成员）。
 * 有效权限 = 账号角色的权限 ∩ 令牌 scopes 打包出来的权限；判断仍只走 can()。
 */
export type ApiScope = 'projects:read' | 'projects:write' | 'sessions:read' | 'sessions:write' | 'workers:read' | 'assets:submit';
export const API_SCOPES: readonly ApiScope[] = ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read', 'assets:submit'];

/** scope → 权限点。这里永远不出现 worker.use_local 和 hub.*：令牌拿不到本机 Worker。 */
export const SCOPE_PERMISSIONS: Readonly<Record<ApiScope, readonly Permission[]>> = {
  'projects:read': ['project.read', 'task.read'],
  'projects:write': ['project.read', 'task.read', 'project.create', 'project.update', 'project.delete', 'task.write'],
  'sessions:read': ['session.read', 'task.read'],
  'sessions:write': ['session.read', 'task.read', 'session.create', 'session.control', 'worker.use', 'worker.read'],
  'workers:read': ['worker.read'],
  // ADR 0016：令牌只能提交资产版本（进审核队列），审核 / 发布 / 分配 / 下架 / 用密钥都不行
  'assets:submit': ['asset.submit']
};

/** 任何令牌都不能拿到的权限（David：本机 Worker 只他本人在界面里用）。 */
export const NEVER_GRANTABLE: ReadonlySet<Permission> = new Set<Permission>([
  'worker.use_local',
  'hub.settings',
  'hub.users',
  'hub.assets',
  'asset.review',
  'asset.assign',
  'asset.retire',
  'asset.secret.use',
  'asset.publish_global'
]);

export function permissionsOf(scopes: readonly ApiScope[]): Permission[] {
  const out = new Set<Permission>();
  for (const scope of scopes) for (const permission of SCOPE_PERMISSIONS[scope] ?? []) if (!NEVER_GRANTABLE.has(permission)) out.add(permission);
  return [...out];
}

export type ApiTokenKind = 'personal' | 'service';

export interface ApiToken {
  readonly id: string;
  readonly teamId: string;
  readonly kind: ApiTokenKind;
  /** 用这个令牌的身份：个人令牌 = 本人；服务账号 = 那个服务账号用户。 */
  readonly userId: string;
  readonly name: string;
  readonly scopes: readonly ApiScope[];
  /** 明文开头几位，列表里认令牌用（不是秘密）。 */
  readonly prefix: string;
  readonly tokenHash: string;
  readonly createdBy: string;
  readonly createdAt: number;
  /** null = 永不过期（D6 默认）。 */
  readonly expiresAt: number | null;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

/** 令牌明文前缀：便于泄露扫描、也让鉴权一眼分得清。 */
export const API_TOKEN_PREFIX = 'ahp_';
/** 服务账号的占位邮箱域：保留域 .invalid，永远收不到信、也登录不了（没有密码）。 */
export const SERVICE_EMAIL_DOMAIN = '@service.agent-hub.invalid';

export const isServiceAccount = (user: Pick<User, 'email'>): boolean => user.email.endsWith(SERVICE_EMAIL_DOMAIN);

export function apiTokenUsable(token: ApiToken, now: number): boolean {
  return token.revokedAt === null && (token.expiresAt === null || token.expiresAt > now);
}

/** 请求是经令牌来的：挂在 Principal 上，can() 据此取交集，审计据此写「via 令牌」。 */
export interface TokenVia {
  readonly tokenId: string;
  readonly name: string;
  readonly kind: ApiTokenKind;
  readonly permissions: readonly Permission[];
}
