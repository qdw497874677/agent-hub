import { forbidden, invalid, type DomainError } from './errors.ts';
import { can, isSystem, principalOfSubject, type Resource, type Subject } from './access.ts';
import type { Result } from './result.ts';

/**
 * Hub 统一配置的模型提供商（docs/adr/0013）。密钥不在这个实体里：单独加密存放，
 * 只在会话启动时按「选中的那一个」下发（D3），或在「经 hub 中转」模式下根本不离开 hub。
 */
export type ProviderScope = 'personal' | 'team' | 'hub';
export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic';
/** direct：worker 本机中继直连提供商；hub：worker 本机中继转发给 hub，由 hub 注入密钥再调提供商。 */
export type ProviderRouting = 'direct' | 'hub';

export const PROVIDER_PROTOCOLS: readonly ProviderProtocol[] = ['openai-chat', 'openai-responses', 'anthropic'];
export const PROVIDER_ROUTINGS: readonly ProviderRouting[] = ['direct', 'hub'];

export interface ProviderModel {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export interface ProviderCheck {
  readonly ok: boolean;
  readonly message: string;
  readonly at: number;
  readonly via: ProviderRouting;
  readonly workerId: string;
}

export interface ModelProvider {
  readonly id: string;
  readonly scope: ProviderScope;
  /** personal = 用户 id；team = 团队 id；hub = null。 */
  readonly ownerId: string | null;
  /** 全局唯一，进模型 id：hub-<slug>/<model>。 */
  readonly slug: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly models: readonly ProviderModel[];
  readonly routing: ProviderRouting;
  readonly enabled: boolean;
  readonly hasKey: boolean;
  readonly lastCheck: ProviderCheck | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProviderUsage {
  readonly requests: number;
  readonly errors: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly sessions: number;
  readonly lastUsedAt: number | null;
}

export const EMPTY_USAGE: ProviderUsage = { requests: 0, errors: 0, bytesIn: 0, bytesOut: 0, sessions: 0, lastUsedAt: null };

export const HUB_MODEL_PREFIX = 'hub-';

export function hubModelId(slug: string, modelId: string): string {
  return `${HUB_MODEL_PREFIX}${slug}/${modelId}`;
}

/** 「hub-<slug>/<model>」拆开；不是 hub 模型返回 null。 */
export function parseHubModel(model: string | undefined | null): { slug: string; modelId: string } | null {
  if (!model?.startsWith(HUB_MODEL_PREFIX)) return null;
  const rest = model.slice(HUB_MODEL_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  const slug = rest.slice(0, slash);
  return SLUG.test(slug) ? { slug, modelId: rest.slice(slash + 1) } : null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,30}$/;

export interface ProviderInput {
  readonly slug: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly models: readonly ProviderModel[];
  readonly routing: ProviderRouting;
  readonly enabled: boolean;
}

export function validateProviderInput(input: ProviderInput): Result<ProviderInput, DomainError> {
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG.test(slug)) return { ok: false, error: invalid('标识只能用小写字母、数字和短横线，1–31 位，字母或数字开头') };
  const name = input.name.trim();
  if (!name || name.length > 80) return { ok: false, error: invalid('名称必填，最多 80 字') };
  if (!PROVIDER_PROTOCOLS.includes(input.protocol)) return { ok: false, error: invalid('不支持的协议') };
  if (!PROVIDER_ROUTINGS.includes(input.routing)) return { ok: false, error: invalid('不支持的路由方式') };
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+(\/\S*)?$/.test(baseUrl)) return { ok: false, error: invalid('Base URL 需要是 http(s) 地址') };
  if (/@/.test(baseUrl.split('/')[2] ?? '')) return { ok: false, error: invalid('Base URL 里不能带账号密码，密钥单独填') };
  if (input.models.length === 0 || input.models.length > 100) return { ok: false, error: invalid('至少列一个模型，最多 100 个') };
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const model of input.models) {
    const id = model.id.trim();
    if (!id || id.length > 120 || /\s/.test(id)) return { ok: false, error: invalid(`模型 id「${id}」不合法`) };
    if (seen.has(id)) return { ok: false, error: invalid(`模型 id「${id}」重复`) };
    seen.add(id);
    models.push({
      id,
      ...(model.name?.trim() ? { name: model.name.trim() } : {}),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens ? { maxTokens: model.maxTokens } : {})
    });
  }
  return { ok: true, value: { ...input, slug, name, baseUrl, models } };
}

/** 谁在看 / 用：授权主体（登录的人、系统主体）。判断全走 can()（ADR 0017）。 */
export type ProviderActor = Subject | null;

/** 提供商当资源：全站 = hub 资源；团队 = 那个团队的（无主，只有 team 范围的角色能管）；个人 = 只看主人。 */
export function providerAsResource(provider: Pick<ModelProvider, 'scope' | 'ownerId'> & { readonly id?: string }): Resource {
  const id = provider.id;
  if (provider.scope === 'hub') return { kind: 'provider', ...(id ? { id } : {}), teamId: null, hub: true };
  if (provider.scope === 'team') return { kind: 'provider', ...(id ? { id } : {}), teamId: provider.ownerId, createdBy: null };
  return { kind: 'provider', ...(id ? { id } : {}), teamId: null, personal: true, createdBy: provider.ownerId };
}

export function canManageProvider(actor: ProviderActor, provider: Pick<ModelProvider, 'scope' | 'ownerId'>): boolean {
  if (provider.scope === 'hub') return can(actor, 'hub.providers');
  if (provider.ownerId === null) return isSystem(actor);
  return can(actor, 'provider.manage', providerAsResource(provider));
}

export function canSeeProvider(actor: ProviderActor, provider: Pick<ModelProvider, 'scope' | 'ownerId'>): boolean {
  if (provider.scope !== 'hub' && provider.ownerId === null) return isSystem(actor);
  return can(actor, 'provider.read', providerAsResource(provider));
}

/**
 * 能不能在某个项目的会话里用：先得有 provider.use，再看作用域和项目团队对不对得上——
 * 团队提供商只给本团队项目；个人提供商只给本人所在团队的项目（不让个人密钥流进别的团队）。
 */
export function canUseProvider(
  actor: ProviderActor,
  provider: Pick<ModelProvider, 'scope' | 'ownerId' | 'enabled' | 'hasKey'>,
  projectTeamId: string | null
): Result<true, DomainError> {
  if (!provider.enabled) return { ok: false, error: invalid('这个模型提供商已停用') };
  if (!provider.hasKey) return { ok: false, error: invalid('这个模型提供商还没有配置密钥') };
  if (!canSeeProvider(actor, provider) || !can(actor, 'provider.use', providerAsResource(provider))) {
    return { ok: false, error: forbidden('无权使用这个模型提供商') };
  }
  if (provider.scope === 'team' && projectTeamId !== null && provider.ownerId !== projectTeamId) {
    return { ok: false, error: invalid('团队模型提供商只能用在本团队的项目里') };
  }
  const principal = principalOfSubject(actor);
  if (provider.scope === 'personal' && projectTeamId !== null && principal !== null && principal.user.teamId !== projectTeamId) {
    return { ok: false, error: invalid('个人模型提供商只能用在你所在团队的项目里') };
  }
  return { ok: true, value: true };
}

/** 生效的路由：worker 覆盖优先于提供商自己的设置。 */
export function effectiveRouting(provider: Pick<ModelProvider, 'routing'>, workerOverride: ProviderRouting | null | undefined): ProviderRouting {
  return workerOverride ?? provider.routing;
}

/**
 * 启动会话时随 start_session 下发的那一个提供商（D3）。
 * via=direct：baseUrl 是提供商地址，apiKey 是真密钥（只交给 worker 的本机中继，不进 agent）。
 * via=hub：baseUrl 是 hub 上的中转路径（/provider-relay/<handle>，worker 按 hub 地址补全），apiKey 是这次会话的中转令牌；真密钥不离开 hub。
 */
export interface ProviderGrant {
  readonly slug: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: readonly ProviderModel[];
  readonly via: ProviderRouting;
}

/** worker 交给运行时的那一份：baseUrl 是本机中继地址，token 是中继令牌——都不是真密钥。 */
export interface ProviderLaunch {
  readonly slug: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly models: readonly ProviderModel[];
  readonly baseUrl: string;
  readonly token: string;
}

/** agent 进程里装中继令牌 / 地址的环境变量名（渲染出来的配置只引用名字，不写值）。 */
export const PROVIDER_TOKEN_ENV = 'HUB_PROVIDER_TOKEN';
export const PROVIDER_BASE_URL_ENV = 'HUB_PROVIDER_BASE_URL';
