import { can } from '../access.ts';
import type { Principal, Role, User, UserId } from '../account.ts';
import { asLoginId, isEmailVerified, newUserId } from '../account.ts';
import type { ApiScope, ApiToken, ApiTokenKind } from '../api-token.ts';
import { API_SCOPES, API_TOKEN_PREFIX, SERVICE_EMAIL_DOMAIN, apiTokenUsable, permissionsOf } from '../api-token.ts';
import { forbidden, invalid, notFound } from '../errors.ts';
import type { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import type { ApiTokenRepository } from '../ports/api-token-repository.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { TokenIssuer } from '../ports/token-issuer.ts';
import type { UserRepository } from '../ports/user-repository.ts';

/** 开放 API 令牌的用例（ADR 0015）。 */
export interface ApiTokenDeps {
  readonly apiTokens: ApiTokenRepository;
  readonly users: Pick<UserRepository, 'byId' | 'save'>;
  readonly tokens: TokenIssuer;
  readonly audit?: AuditLog;
  readonly now: () => number;
}

export interface CreateApiTokenInput {
  readonly name: string;
  readonly kind: ApiTokenKind;
  readonly scopes: readonly ApiScope[];
  /** null / 不给 = 永不过期。 */
  readonly expiresAt?: number | null;
}

/** 列表里给人看的形状：没有哈希。 */
export type ApiTokenView = Omit<ApiToken, 'tokenHash'> & { readonly usable: boolean };

const view = (token: ApiToken, now: number): ApiTokenView => {
  const { tokenHash: _hash, ...rest } = token;
  return { ...rest, usable: apiTokenUsable(token, now) };
};

async function audit(deps: ApiTokenDeps, actor: Principal, action: 'token.create' | 'token.revoke', token: ApiToken): Promise<void> {
  await deps.audit
    ?.append({
      id: newId(),
      actorId: actor.user.id,
      actorEmail: actor.user.email,
      action,
      target: token.id,
      detail: `${token.kind === 'service' ? '服务账号' : '个人令牌'}「${token.name}」 ${token.scopes.join(' ')}`,
      at: deps.now(),
      ip: null,
      teamId: token.teamId
    })
    .catch(() => undefined);
}

export async function createApiToken(
  deps: ApiTokenDeps,
  actor: Principal,
  input: CreateApiTokenInput
): Promise<Result<{ readonly token: string; readonly info: ApiTokenView }, DomainError>> {
  // 令牌不能再造令牌：只有登录态（人）能管令牌。
  if (actor.via) return err(forbidden('令牌不能创建令牌'));
  const teamId = actor.user.teamId;
  if (!teamId) return err(forbidden('你还没有团队'));
  const name = input.name.trim();
  if (name === '' || name.length > 60) return err(invalid('名字 1–60 个字'));
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0 || scopes.some((scope) => !API_SCOPES.includes(scope))) return err(invalid('至少选一个有效的权限范围'));
  const now = deps.now();
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && expiresAt <= now) return err(invalid('过期时间要在将来'));

  let userId: string = actor.user.id;
  if (input.kind === 'service') {
    if (!can(actor, 'member.manage', { teamId })) return err(forbidden('只有团队主人能建服务账号'));
    const role: Role = 'member'; // 服务账号永远是成员，不能当主人
    const service: User = {
      id: newUserId(),
      email: `svc-${newId().slice(0, 12).toLowerCase()}${SERVICE_EMAIL_DOMAIN}`,
      displayName: name,
      role,
      passwordHash: null,
      emailVerifiedAt: now,
      disabledAt: null,
      createdAt: now,
      teamId: actor.user.teamId,
      hubAdmin: false,
      deletedAt: null
    };
    await deps.users.save(service);
    userId = service.id;
  }

  const issued = deps.tokens.issue();
  const raw = `${API_TOKEN_PREFIX}${issued.token}`;
  const token: ApiToken = {
    id: newId(),
    teamId,
    kind: input.kind,
    userId,
    name,
    scopes,
    prefix: raw.slice(0, API_TOKEN_PREFIX.length + 6),
    tokenHash: deps.tokens.hashOf(raw),
    createdBy: actor.user.id,
    createdAt: now,
    expiresAt,
    lastUsedAt: null,
    revokedAt: null
  };
  await deps.apiTokens.save(token);
  await audit(deps, actor, 'token.create', token);
  return ok({ token: raw, info: view(token, now) });
}

/** 我的个人令牌；团队主人还能看到团队的服务账号。 */
export async function listApiTokens(deps: ApiTokenDeps, actor: Principal): Promise<ApiTokenView[]> {
  const teamId = actor.user.teamId;
  if (!teamId) return [];
  const manage = can(actor, 'member.manage', { teamId });
  const now = deps.now();
  return (await deps.apiTokens.listByTeam(teamId))
    .filter((token) => (token.kind === 'personal' ? token.userId === actor.user.id : manage))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((token) => view(token, now));
}

export async function revokeApiToken(deps: ApiTokenDeps, actor: Principal, id: string): Promise<Result<ApiTokenView, DomainError>> {
  if (actor.via) return err(forbidden('令牌不能吊销令牌'));
  const token = await deps.apiTokens.byId(id);
  const mine = token && token.teamId === actor.user.teamId && (token.kind === 'personal' ? token.userId === actor.user.id : can(actor, 'member.manage', { teamId: token.teamId }));
  if (!token || !mine) return err(notFound('令牌不存在'));
  const now = deps.now();
  if (token.revokedAt !== null) return ok(view(token, now));
  const revoked: ApiToken = { ...token, revokedAt: now };
  await deps.apiTokens.save(revoked);
  if (token.kind === 'service') {
    // 服务账号就是为这个令牌存在的：一起停用（它建的项目、记录仍在，名字照常显示）。
    const user = await deps.users.byId(token.userId as UserId);
    if (user && user.disabledAt === null) await deps.users.save({ ...user, disabledAt: now });
  }
  await audit(deps, actor, 'token.revoke', revoked);
  return ok(view(revoked, now));
}

/** 续期写库的最小间隔。 */
const TOUCH_MS = 60_000;

/** 从 Bearer 明文认出身份；不认识、吊销、过期、账号停用 / 删除 / 没验证邮箱一律 null。 */
export async function authenticateApiToken(deps: Pick<ApiTokenDeps, 'apiTokens' | 'users' | 'tokens' | 'now'>, raw: string): Promise<Principal | null> {
  if (!raw.startsWith(API_TOKEN_PREFIX)) return null;
  const token = await deps.apiTokens.byHash(deps.tokens.hashOf(raw));
  const now = deps.now();
  if (!token || !apiTokenUsable(token, now)) return null;
  const user = await deps.users.byId(token.userId as UserId);
  if (!user || user.disabledAt !== null || user.deletedAt !== null || !isEmailVerified(user)) return null;
  if (user.teamId !== token.teamId) return null;
  if (token.lastUsedAt === null || now - token.lastUsedAt >= TOUCH_MS) await deps.apiTokens.touch(token.id, now);
  return {
    user,
    loginId: asLoginId(`tok_${token.id}`),
    via: { tokenId: token.id, name: token.name, kind: token.kind, permissions: permissionsOf(token.scopes) }
  };
}
