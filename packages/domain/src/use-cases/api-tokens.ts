import { can, type Permission, type Resource } from '../access.ts';
import type { Principal, Role, User, UserId } from '../account.ts';
import { asLoginId, isEmailVerified, newUserId } from '../account.ts';
import type { ApiScope, ApiToken, ApiTokenKind } from '../api-token.ts';
import { API_SCOPES, API_TOKEN_PREFIX, DEFAULT_TOKEN_TTL_MS, BOT_TOKEN_PREFIX, SERVICE_EMAIL_DOMAIN, apiTokenUsable, effectivePermissions } from '../api-token.ts';
import { conflict, forbidden, invalid, notFound } from '../errors.ts';
import type { DomainError } from '../errors.ts';
import { asProjectId, newId } from '../ids.ts';
import type { Project } from '../project.ts';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import type { ApiTokenRepository } from '../ports/api-token-repository.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { ProjectRepository } from '../ports/project-repository.ts';
import type { TokenIssuer } from '../ports/token-issuer.ts';
import type { UserRepository } from '../ports/user-repository.ts';

/** 开放 API 令牌的用例（ADR 0015）。 */
export interface ApiTokenDeps {
  readonly apiTokens: ApiTokenRepository;
  readonly users: Pick<UserRepository, 'byId' | 'save'>;
  /** bot 令牌签发 / 可见性要确认「签发人是这个项目的 owner / admin」。 */
  readonly projects: Pick<ProjectRepository, 'byId'>;
  /** 给了就校验 botName 真的在这个项目里（不然能给不存在的 @id 发凭据）。 */
  readonly botExists?: (projectId: string, name: string) => Promise<boolean>;
  readonly tokens: TokenIssuer;
  readonly audit?: AuditLog;
  readonly now: () => number;
}

export interface CreateApiTokenInput {
  readonly name: string;
  readonly kind: ApiTokenKind;
  readonly scopes: readonly ApiScope[];
  /** kind = 'bot' 必填：凭据绑定的项目（bot 只能在这个项目里做事）。 */
  readonly projectId?: string;
  /** kind = 'bot' 可选：bot 的 @id；不给就用令牌名。 */
  readonly botName?: string;
  /** 不给 = 30 天（bot 不给 = 不过期）；null = 永不过期。 */
  readonly expiresAt?: number | null;
  /** 个人 / 服务账号令牌：只给这几个项目（不给 / null = 不限）。bot 令牌不用它（bot 自带项目）。 */
  readonly projectIds?: readonly string[] | null;
}

/** 一个令牌最多限定多少个项目（再多就不如不限）。 */
export const MAX_TOKEN_PROJECTS = 50;

/** 列表里给人看的形状：没有哈希。 */
export type ApiTokenView = Omit<ApiToken, 'tokenHash'> & { readonly usable: boolean };

const view = (token: ApiToken, now: number): ApiTokenView => {
  const { tokenHash: _hash, ...rest } = token;
  // bot 凭据永不过期：老库里存过的到期时间不展示，免得界面写「已过期」而实际照常能用
  return { ...rest, ...(token.kind === 'bot' ? { expiresAt: null } : {}), usable: apiTokenUsable(token, now) };
};

async function audit(deps: ApiTokenDeps, actor: Principal, action: 'token.create' | 'token.revoke' | 'token.rotate', token: ApiToken): Promise<void> {
  const label = token.kind === 'bot' ? `bot「${token.bot?.name ?? token.name}」` : token.kind === 'service' ? '服务账号' : '个人令牌';
  await deps.audit
    ?.append({
      id: newId(),
      actorId: actor.user.id,
      actorEmail: actor.user.email,
      action,
      target: token.id,
      detail: `${label}「${token.name}」 ${token.scopes.join(' ')}${token.projectIds ? ` 限项目 ${token.projectIds.join(',')}` : ''}`,
      at: deps.now(),
      ip: null,
      teamId: token.teamId
    })
    .catch(() => undefined);
}

/** 项目当资源（与 authorization.ts 的 projectAsResource 同形）：判断 bot 令牌能不能碰这个项目。 */
const projectResource = (project: Project): Resource => ({
  kind: 'project',
  id: project.id,
  projectId: project.id,
  teamId: project.teamId,
  createdBy: project.createdBy,
  sharedWith: project.members
});

/** bot 令牌的可见 / 可吊销规则：这个项目的 owner / admin（project.update）才行。 */
async function botAdmin(deps: Pick<ApiTokenDeps, 'projects'>, actor: Principal, token: ApiToken): Promise<boolean> {
  const projectId = token.bot?.projectId;
  if (!projectId) return false;
  const project = await deps.projects.byId(asProjectId(projectId));
  return project !== null && project.deletedAt === null && can(actor, 'project.share', projectResource(project));
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
  // 个人 / 服务账号令牌：不给 = 默认 30 天；要永不过期得显式传 null。
  // bot 凭据是项目里长期挂着的集成，永不过期，也不接受有效期（免得 bot 到期突然失联）。
  if (input.kind === 'bot' && input.expiresAt != null) return err(invalid('bot 凭据不会过期，不用设有效期'));
  const expiresAt = input.kind === 'bot' ? null : input.expiresAt !== undefined ? input.expiresAt : now + DEFAULT_TOKEN_TTL_MS;
  if (expiresAt !== null && expiresAt <= now) return err(invalid('过期时间要在将来'));

  let userId: string = actor.user.id;
  let bot: ApiToken['bot'];
  if (input.kind === 'service') {
    if (!can(actor, 'team.manage', { teamId })) return err(forbidden('只有团队主人能建服务账号'));
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
      clusterAdmin: false,
      deletedAt: null
    };
    await deps.users.save(service);
    userId = service.id;
  }
  if (input.kind === 'bot') {
    const projectId = input.projectId?.trim();
    if (!projectId) return err(invalid('bot 令牌要指定项目'));
    const project = await deps.projects.byId(asProjectId(projectId));
    if (!project || project.deletedAt !== null || project.teamId !== teamId) return err(forbidden('只有项目主人能给 bot 发凭据'));
    // project.share 是「只有创建者 / owner·admin」的权限；project.update 对共享成员也放行，太宽。
    if (!can(actor, 'project.share', projectResource(project))) return err(forbidden('只有项目主人能给 bot 发凭据'));
    // 请求的 scope 照旧记下来，但有效权限一律与 BOT_PERMISSIONS 取交集（见 effectivePermissions），
    // 所以 projects:write 里的 project.create / project.delete 这类越界权限不会生效，这里不需要额外拒绝。
    bot = { projectId: project.id, name: input.botName?.trim() || name };
    if (deps.botExists && !(await deps.botExists(bot.projectId, bot.name))) {
      return err(invalid(`这个项目里没有 bot「${bot.name}」`));
    }
  }

  let projectIds: readonly string[] | null = null;
  if (input.projectIds !== undefined && input.projectIds !== null) {
    if (input.kind === 'bot') return err(invalid('bot 凭据自带项目，不用再限定'));
    const wanted = [...new Set(input.projectIds.map((id) => id.trim()).filter(Boolean))];
    if (wanted.length === 0) return err(invalid('限定项目时至少选一个'));
    if (wanted.length > MAX_TOKEN_PROJECTS) return err(invalid(`最多限定 ${MAX_TOKEN_PROJECTS} 个项目`));
    for (const id of wanted) {
      const project = await deps.projects.byId(asProjectId(id));
      // 只能限定到自己看得见的项目；看不见的一律说「没有」，不泄露存在性
      if (!project || project.deletedAt !== null || project.teamId !== teamId || !can(actor, 'project.read', projectResource(project))) {
        return err(invalid('选的项目里有你看不到的'));
      }
    }
    projectIds = wanted;
  }

  const issued = deps.tokens.issue();
  const prefix = input.kind === 'bot' ? BOT_TOKEN_PREFIX : API_TOKEN_PREFIX;
  const raw = `${prefix}${issued.token}`;
  const token: ApiToken = {
    id: newId(),
    teamId,
    kind: input.kind,
    userId,
    ...(bot ? { bot } : {}),
    ...(projectIds ? { projectIds } : {}),
    name,
    scopes,
    prefix: raw.slice(0, prefix.length + 6),
    tokenHash: deps.tokens.hashOf(raw),
    createdBy: actor.user.id,
    createdAt: now,
    expiresAt,
    lastUsedAt: null,
    revokedAt: null
  };
  await deps.apiTokens.save(token);
  if (token.kind === 'bot' && token.bot) {
    // 一个 bot 同时只有一条有效凭据：新的先落库，再把旧的掐掉（中途失败也不会两个都没）。
    for (const existing of await deps.apiTokens.listBotsByProject(asProjectId(token.bot.projectId))) {
      if (existing.id !== token.id && existing.revokedAt === null && existing.bot?.name === token.bot.name) {
        await deps.apiTokens.save({ ...existing, revokedAt: now });
      }
    }
  }
  await audit(deps, actor, 'token.create', token);
  return ok({ token: raw, info: view(token, now) });
}

/** 我的个人令牌；团队主人还能看到团队的服务账号；bot 令牌对项目 owner/admin（以及 team.manage）可见。 */
export async function listApiTokens(deps: ApiTokenDeps, actor: Principal): Promise<ApiTokenView[]> {
  const teamId = actor.user.teamId;
  if (!teamId) return [];
  const manage = can(actor, 'team.manage', { teamId });
  const now = deps.now();
  const visible: ApiToken[] = [];
  for (const token of await deps.apiTokens.listByTeam(teamId)) {
    if (token.kind === 'personal') {
      if (token.userId === actor.user.id) visible.push(token);
    } else if (token.kind === 'bot') {
      if (manage || (await botAdmin(deps, actor, token))) visible.push(token);
    } else if (manage) {
      visible.push(token);
    }
  }
  return visible.sort((a, b) => b.createdAt - a.createdAt).map((token) => view(token, now));
}

export async function revokeApiToken(deps: ApiTokenDeps, actor: Principal, id: string): Promise<Result<ApiTokenView, DomainError>> {
  if (actor.via) return err(forbidden('令牌不能吊销令牌'));
  const token = await deps.apiTokens.byId(id);
  if (!token || token.teamId !== actor.user.teamId) return err(notFound('令牌不存在'));
  const mine =
    token.kind === 'personal'
      ? token.userId === actor.user.id
      : token.kind === 'bot'
        ? await botAdmin(deps, actor, token)
        : can(actor, 'team.manage', { teamId: token.teamId });
  if (!mine) return err(notFound('令牌不存在'));
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
  if (!raw.startsWith(API_TOKEN_PREFIX) && !raw.startsWith(BOT_TOKEN_PREFIX)) return null;
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
    via: {
      tokenId: token.id,
      name: token.name,
      kind: token.kind,
      // bot 令牌再与 BOT_PERMISSIONS 取交集：scope 可以更宽，越界权限不会生效。
      permissions: effectivePermissions(token),
      ...(token.bot ? { bot: { projectId: token.bot.projectId, name: token.bot.name } } : {}),
      ...(token.projectIds && token.projectIds.length > 0 ? { projectIds: token.projectIds } : {})
    }
  };
}

/** 管得了这个令牌吗（看得见、能吊销 / 轮换）：个人 = 本人；服务账号 = 团队主人；bot = 项目 admin。 */
async function manages(deps: ApiTokenDeps, actor: Principal, token: ApiToken): Promise<boolean> {
  if (token.teamId !== actor.user.teamId) return false;
  if (token.kind === 'personal') return token.userId === actor.user.id;
  if (token.kind === 'bot') return botAdmin(deps, actor, token);
  return can(actor, 'team.manage', { teamId: token.teamId });
}

/**
 * 轮换：发一个同名、同权限、同项目范围的新令牌，旧的立刻吊销（记录保留，列表里看得到）。
 * 有效期沿用原来的长度（原来永不过期就还是永不过期）。服务账号轮换不停用账号——新令牌还要用它。
 * bot 凭据走「重新生成」（createApiToken 自带同名轮换），这里不收。
 */
export async function rotateApiToken(
  deps: ApiTokenDeps,
  actor: Principal,
  id: string
): Promise<Result<{ readonly token: string; readonly info: ApiTokenView; readonly replaced: ApiTokenView }, DomainError>> {
  if (actor.via) return err(forbidden('令牌不能轮换令牌'));
  const old = await deps.apiTokens.byId(id);
  if (!old || !(await manages(deps, actor, old))) return err(notFound('令牌不存在'));
  if (old.kind === 'bot') return err(invalid('bot 凭据请在 Bot 页重新生成'));
  if (old.revokedAt !== null) return err(conflict('这个令牌已经吊销了，新建一个吧'));
  const now = deps.now();
  const length = old.expiresAt === null ? null : Math.max(old.expiresAt - old.createdAt, 60_000);
  const issued = deps.tokens.issue();
  const raw = `${API_TOKEN_PREFIX}${issued.token}`;
  const next: ApiToken = {
    ...old,
    id: newId(),
    prefix: raw.slice(0, API_TOKEN_PREFIX.length + 6),
    tokenHash: deps.tokens.hashOf(raw),
    createdBy: actor.user.id,
    createdAt: now,
    expiresAt: length === null ? null : now + length,
    lastUsedAt: null,
    revokedAt: null
  };
  await deps.apiTokens.save(next);
  const revoked: ApiToken = { ...old, revokedAt: now };
  await deps.apiTokens.save(revoked);
  await audit(deps, actor, 'token.rotate', next);
  return ok({ token: raw, info: view(next, now), replaced: view(revoked, now) });
}

/** 一个令牌的最近活动（创建 / 轮换 / 吊销 / MCP 调用），给外部接入页的「调用记录」用。 */
export async function apiTokenActivity(
  deps: ApiTokenDeps,
  actor: Principal,
  id: string,
  limit = 50
): Promise<Result<readonly { readonly action: string; readonly detail: string; readonly at: number }[], DomainError>> {
  if (actor.via) return err(forbidden('令牌不能查令牌'));
  const token = await deps.apiTokens.byId(id);
  if (!token || !(await manages(deps, actor, token))) return err(notFound('令牌不存在'));
  if (!deps.audit) return ok([]);
  const rows = await deps.audit.query({ target: token.id, teamId: token.teamId, limit: Math.min(Math.max(limit, 1), 200) });
  return ok(rows.map((row) => ({ action: row.action, detail: row.detail, at: row.at })));
}

/** 管理者查看某个令牌的有效权限（外部接入页算「接上能看到哪些工具」用）；不认证明文，只看记录。 */
export async function authenticateApiTokenById(
  deps: ApiTokenDeps,
  actor: Principal,
  id: string
): Promise<Result<{ readonly permissions: readonly Permission[]; readonly usable: boolean }, DomainError>> {
  if (actor.via) return err(forbidden('令牌不能查令牌'));
  const token = await deps.apiTokens.byId(id);
  if (!token || !(await manages(deps, actor, token))) return err(notFound('令牌不存在'));
  return ok({ permissions: effectivePermissions(token), usable: apiTokenUsable(token, deps.now()) });
}
