import { can, type Resource } from '../access.ts';
import type { Principal, Role, User, UserId } from '../account.ts';
import { asLoginId, isEmailVerified, newUserId } from '../account.ts';
import type { ApiScope, ApiToken, ApiTokenKind } from '../api-token.ts';
import { API_SCOPES, API_TOKEN_PREFIX, BOT_TOKEN_PREFIX, SERVICE_EMAIL_DOMAIN, apiTokenUsable, effectivePermissions } from '../api-token.ts';
import { forbidden, invalid, notFound } from '../errors.ts';
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
  const label = token.kind === 'bot' ? `bot「${token.bot?.name ?? token.name}」` : token.kind === 'service' ? '服务账号' : '个人令牌';
  await deps.audit
    ?.append({
      id: newId(),
      actorId: actor.user.id,
      actorEmail: actor.user.email,
      action,
      target: token.id,
      detail: `${label}「${token.name}」 ${token.scopes.join(' ')}`,
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
  return project !== null && project.deletedAt === null && can(actor, 'project.update', projectResource(project));
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
    if (!can(actor, 'project.update', projectResource(project))) return err(forbidden('只有项目主人能给 bot 发凭据'));
    // 请求的 scope 照旧记下来，但有效权限一律与 BOT_PERMISSIONS 取交集（见 effectivePermissions），
    // 所以 projects:write 里的 project.create / project.delete 这类越界权限不会生效，这里不需要额外拒绝。
    bot = { projectId: project.id, name: input.botName?.trim() || name };
    if (deps.botExists && !(await deps.botExists(bot.projectId, bot.name))) {
      return err(invalid(`这个项目里没有 bot「${bot.name}」`));
    }
    // 一个 bot 同时只有一条有效凭据：重新生成即轮换（旧的那条立刻失效）。
    for (const existing of await deps.apiTokens.listBotsByProject(project.id)) {
      if (existing.revokedAt === null && existing.bot?.name === bot.name) {
        await deps.apiTokens.save({ ...existing, revokedAt: now });
      }
    }
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
      ...(token.bot ? { bot: { projectId: token.bot.projectId, name: token.bot.name } } : {})
    }
  };
}
