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
  | 'providers:use'
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
  'providers:use',
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
  'sessions:write': ['session.read', 'task.read', 'session.create', 'session.prompt', 'session.interrupt', 'session.fork', 'session.continue', 'worker.use', 'worker.read'],
  // 不并进 sessions:write。用之前先要看得见，所以带上 provider.read，不含管理。
  'providers:use': ['provider.read', 'provider.use'],
  'workers:read': ['worker.read'],
  // 群里说话：先得看得见项目（bot 只在自己项目里发言）
  'groups:write': ['project.read', 'group.post'],
  // 读会话工作空间里的文件
  'files:read': ['project.read', 'workspace.files.read'],
  // 记忆：读 / 写分成两个 scope，读不给写
  'memory:read': ['project.read', 'memory.read'],
  'memory:write': ['project.read', 'memory.read', 'memory.write'],
  // ADR 0016：令牌只能提交资产版本（进审核队列），审核 / 发布 / 分配 / 下架 / 用密钥都不行
  'assets:submit': ['asset.submit']
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

export function apiTokenUsable(token: ApiToken, now: number): boolean {
  return token.revokedAt === null && (token.expiresAt === null || token.expiresAt > now);
}

/** 请求是经令牌来的：挂在 Principal 上，can() 据此取交集，审计据此写「via 令牌」。 */
export interface TokenVia {
  readonly tokenId: string;
  readonly name: string;
  readonly kind: ApiTokenKind;
  readonly permissions: readonly Permission[];
  /** bot 令牌的项目归属：can() 用它把权限收窄到这一个项目（C1）。 */
  readonly bot?: { readonly projectId: string; readonly name: string };
}
