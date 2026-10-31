import { can, principalOfSubject, type Subject } from '../access.ts';
import { conflict, forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { ProviderRepository } from '../ports/provider-repository.ts';
import {
  canManageProvider,
  canSeeProvider,
  canUseProvider,
  effectiveRouting,
  parseHubModel,
  validateProviderInput,
  type ModelProvider,
  type ProviderActor,
  type ProviderCheck,
  type ProviderInput,
  type ProviderRouting,
  type ProviderScope,
  type ProviderUsage
} from '../provider.ts';
import { err, ok, type Result } from '../result.ts';

export interface ProviderDeps {
  readonly providers: ProviderRepository;
  readonly audit: AuditLog | null;
  readonly now: () => number;
}

/** 授权主体就是 ProviderActor（判断全走 can()）。没装账号体系时调用方传系统主体，不再用 null 代表「hub 管理员」。 */
export const providerActor = (subject: Subject | null): ProviderActor => subject;

async function audit(deps: ProviderDeps, subject: Subject | null, action: 'provider.create' | 'provider.update' | 'provider.key' | 'provider.delete' | 'provider.test' | 'provider.routing', target: string, detail: string) {
  const principal = principalOfSubject(subject);
  if (!deps.audit || !principal) return;
  await deps.audit.append({ id: newId(), actorId: principal.user.id, actorEmail: principal.user.email, action, target, detail, at: deps.now() });
}

export interface ProviderView extends ModelProvider {
  readonly canManage: boolean;
  readonly usage: ProviderUsage;
}

export async function listProviders(deps: ProviderDeps, principal: Subject | null): Promise<ProviderView[]> {
  const actor = providerActor(principal);
  const out: ProviderView[] = [];
  for (const provider of await deps.providers.list()) {
    if (!canSeeProvider(actor, provider)) continue;
    out.push({ ...provider, canManage: canManageProvider(actor, provider), usage: await deps.providers.usage(provider.id) });
  }
  return out;
}

export interface CreateProviderInput extends ProviderInput {
  readonly scope: ProviderScope;
  readonly apiKey?: string;
}

export async function createProvider(deps: ProviderDeps, principal: Subject | null, input: CreateProviderInput): Promise<Result<ModelProvider, DomainError>> {
  const actor = providerActor(principal);
  const me = principalOfSubject(actor);
  const ownerId = input.scope === 'hub' ? null : input.scope === 'team' ? (me?.user.teamId ?? null) : (me?.user.id ?? null);
  if (input.scope === 'team' && ownerId === null) return err(invalid('你不在任何团队里，建不了团队提供商'));
  if (input.scope === 'personal' && ownerId === null) return err(invalid('个人提供商要登录后建'));
  if (!canManageProvider(actor, { scope: input.scope, ownerId })) return err(forbidden(input.scope === 'hub' ? '只有集群管理员能建全站提供商' : '只有团队 owner / admin 能建团队提供商'));
  const valid = validateProviderInput(input);
  if (!valid.ok) return valid;
  if (await deps.providers.bySlug(valid.value.slug)) return err(conflict(`标识「${valid.value.slug}」已被占用`));
  const at = deps.now();
  const provider: Omit<ModelProvider, 'hasKey'> = {
    id: newId(), scope: input.scope, ownerId, ...valid.value, lastCheck: null, createdBy: me?.user.id ?? 'system', createdAt: at, updatedAt: at
  };
  await deps.providers.save(provider);
  if (input.apiKey) await deps.providers.setKey(provider.id, input.apiKey, at);
  await audit(deps, principal, 'provider.create', provider.slug, `${input.scope} · ${provider.protocol} · ${provider.routing}`);
  return ok({ ...provider, hasKey: Boolean(input.apiKey) });
}

async function managed(deps: ProviderDeps, principal: Subject | null, id: string): Promise<Result<ModelProvider, DomainError>> {
  const provider = await deps.providers.byId(id);
  if (!provider || !canSeeProvider(providerActor(principal), provider)) return err(notFound('没有这个模型提供商'));
  if (!canManageProvider(providerActor(principal), provider)) return err(forbidden('无权管理这个模型提供商'));
  return ok(provider);
}

export async function updateProvider(deps: ProviderDeps, principal: Subject | null, id: string, input: ProviderInput): Promise<Result<ModelProvider, DomainError>> {
  const current = await managed(deps, principal, id);
  if (!current.ok) return current;
  const valid = validateProviderInput(input);
  if (!valid.ok) return valid;
  const taken = await deps.providers.bySlug(valid.value.slug);
  if (taken && taken.id !== id) return err(conflict(`标识「${valid.value.slug}」已被占用`));
  const next = { ...current.value, ...valid.value, updatedAt: deps.now() };
  await deps.providers.save(next);
  await audit(deps, principal, 'provider.update', next.slug, `${next.protocol} · ${next.routing} · ${next.enabled ? '启用' : '停用'}`);
  return ok(next);
}

/** 轮换密钥：只进不出；审计只记「换了」。 */
export async function setProviderKey(deps: ProviderDeps, principal: Subject | null, id: string, apiKey: string): Promise<Result<void, DomainError>> {
  const current = await managed(deps, principal, id);
  if (!current.ok) return current;
  if (!apiKey.trim() || apiKey.length > 4096) return err(invalid('密钥不能为空'));
  await deps.providers.setKey(id, apiKey.trim(), deps.now());
  await audit(deps, principal, 'provider.key', current.value.slug, '密钥已更新');
  return ok(undefined);
}

export async function deleteProvider(deps: ProviderDeps, principal: Subject | null, id: string): Promise<Result<void, DomainError>> {
  const current = await managed(deps, principal, id);
  if (!current.ok) return current;
  await deps.providers.remove(id);
  await audit(deps, principal, 'provider.delete', current.value.slug, '');
  return ok(undefined);
}

export async function setWorkerProviderRouting(deps: ProviderDeps, principal: Subject | null, workerId: string, routing: ProviderRouting | null): Promise<Result<void, DomainError>> {
  if (!can(principal, 'hub.providers')) return err(forbidden('只有集群管理员能改机器的提供商路由'));
  await deps.providers.setWorkerRouting(workerId, routing);
  await audit(deps, principal, 'provider.routing', workerId, routing ?? '跟随提供商');
  return ok(undefined);
}

export async function recordProviderCheck(deps: ProviderDeps, principal: Subject | null, provider: ModelProvider, check: ProviderCheck): Promise<void> {
  await deps.providers.recordCheck(provider.id, check);
  await audit(deps, principal, 'provider.test', provider.slug, `${check.via} · ${check.workerId} · ${check.ok ? '通' : '不通'}：${check.message.slice(0, 160)}`);
}

/** 派生时：选了 hub 模型就核对这个人能不能在这个项目里用它。 */
export async function checkProviderModel(
  deps: Pick<ProviderDeps, 'providers'>,
  principal: Subject | null,
  model: string,
  projectTeamId: string | null
): Promise<Result<ModelProvider | null, DomainError>> {
  const parsed = parseHubModel(model);
  if (!parsed) return ok(null);
  const provider = await deps.providers.bySlug(parsed.slug);
  if (!provider) return err(invalid(`没有模型提供商「${parsed.slug}」`));
  if (!provider.models.some((item) => item.id === parsed.modelId)) return err(invalid(`模型提供商「${provider.name}」没有模型 ${parsed.modelId}`));
  const allowed = canUseProvider(providerActor(principal), provider, projectTeamId);
  return allowed.ok ? ok(provider) : allowed;
}

/**
 * 启动 / 每次经 hub 中转的请求：会话没有创建者，按项目团队核对作用域——
 * 全站的谁都能用；团队的只给本团队项目；个人的只给主人所在团队的项目。
 */
export function providerUsableIn(provider: ModelProvider, projectTeamId: string | null, ownerTeamId: string | null): Result<true, DomainError> {
  if (!provider.enabled) return err(invalid('这个模型提供商已停用'));
  if (!provider.hasKey) return err(invalid('这个模型提供商还没有配置密钥'));
  if (projectTeamId === null) return ok(true);
  if (provider.scope === 'team' && provider.ownerId !== projectTeamId) return err(invalid('团队模型提供商只能用在本团队的项目里'));
  if (provider.scope === 'personal' && ownerTeamId !== projectTeamId) return err(invalid('个人模型提供商只能用在主人所在团队的项目里'));
  return ok(true);
}

export async function routingFor(deps: Pick<ProviderDeps, 'providers'>, provider: ModelProvider, workerId: string): Promise<ProviderRouting> {
  return effectiveRouting(provider, (await deps.providers.workerRouting())[workerId]);
}
