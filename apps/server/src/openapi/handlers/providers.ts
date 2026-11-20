// providers 能力的处理函数（从 app.ts 原样搬出；鉴权/限流/审计仍在 app.ts 的前导里）。
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { V1Runtime } from '../context.ts';
import { openapiOn, valid } from '../context.ts';
import type { Env } from '../context.ts';
import { visibleWorkerRouting } from '../../visible-worker-routing.ts';
import type {
  Context
} from 'hono';
import {
  can,
  forbidden,
  notFound,
  listProviders,
  createProvider,
  setWorkerProviderRouting,
  hubModelId,
  canManageProvider,
  canSeeProvider,
  providerActor
} from '@agent-hub/domain';
import { fail } from '../../http-error.ts';
import {
  publicProvider
} from '../../providers.ts';
import {
  routes
} from '.././routes.ts';

/** installProviders：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installProviders(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  const noProviders = (c: Context) => fail(c, { code: 'not_implemented', message: '这台 hub 没装模型提供商' });
  const providerImpact = async (providerId: string) => {
    const api = rt.providers;
    if (!api) return null;
    const provider = await api.deps.providers.byId(providerId);
    if (!provider) return null;
    const usage = await api.deps.providers.usage(provider.id);
    const models = provider.models.map((model) => hubModelId(provider.slug, model.id));
    return {
      action: 'delete',
      provider: publicProvider({
        id: provider.id,
        slug: provider.slug,
        name: provider.name,
        scope: provider.scope,
        hasKey: provider.hasKey,
        enabled: provider.enabled
      }),
      models,
      usage: { sessions: usage.sessions, requests: usage.requests, lastUsedAt: usage.lastUsedAt },
      message:
        usage.sessions > 0
          ? `删除后 ${models.length} 个模型将不可用，有 ${usage.sessions} 个会话用过这个提供商。`
          : `删除后 ${models.length} 个模型将不可用。`
    };
  };
  /** LOW6：机器维度的路由覆盖只给能看见这台机器的令牌——按 worker.read 逐台过滤；没有 workers:read 就整个字段省略。逻辑见 apps/server/src/visible-worker-routing.ts（Web 路由共用）。 */
  on(routes.providerList, async (c) => {
    if (!rt.providers) return noProviders(c);
    const actor = rt.principal(c);
    if (!can(actor, 'provider.read')) return fail(c, forbidden('令牌没有 providers:read'));
    const listed = await listProviders(rt.providers.deps, actor);
    // LOW6：workerRouting 只含调用方能看见的机器；没有 workers:read 的令牌整个字段省略。
    const workerRouting = await visibleWorkerRouting(rt.deps.access, actor, rt.providers.deps.providers.workerRouting);
    return workerRouting === undefined ? c.json({ providers: listed.map(publicProvider) }) : c.json({ providers: listed.map(publicProvider), workerRouting });
  });
  on(routes.providerCreate, async (c) => {
    if (!rt.providers) return noProviders(c);
    const actor = rt.principal(c);
    if (!can(actor, 'provider.manage')) return fail(c, forbidden('令牌没有 providers:manage'));
    const input = valid<{
      slug: string;
      name: string;
      protocol: 'openai-chat' | 'openai-responses' | 'anthropic';
      baseUrl: string;
      models: unknown[];
      routing: 'direct' | 'hub';
      enabled?: boolean;
      scope?: 'personal' | 'team' | 'hub';
      apiKey?: string;
    }>(c, 'json');
    const result = await createProvider(rt.providers.deps, actor, {
      ...rt.providers.asInput(input as unknown as Record<string, unknown>),
      scope: input.scope ?? 'personal',
      ...(input.apiKey ? { apiKey: input.apiKey } : {})
    });
    return result.ok ? c.json(publicProvider(result.value), 201) : fail(c, result.error);
  });
  on(routes.providerUpdate, async (c) => {
    if (!rt.providers) return noProviders(c);
    const actor = rt.principal(c);
    if (!can(actor, 'provider.manage')) return fail(c, forbidden('令牌没有 providers:manage'));
    const input = valid<Record<string, unknown>>(c, 'json');
    const result = await rt.providers.updateManaged(actor, c.req.param('providerId') ?? '', rt.providers.asInput(input));
    return result.ok ? c.json(publicProvider(result.value)) : fail(c, result.error);
  });
  on(routes.providerSetKey, async (c) => {
    if (!rt.providers) return noProviders(c);
    const actor = rt.principal(c);
    if (!can(actor, 'provider.manage')) return fail(c, forbidden('令牌没有 providers:manage'));
    const input = valid<{ apiKey: string }>(c, 'json');
    const result = await rt.providers.setKeyManaged(actor, c.req.param('providerId') ?? '', input.apiKey);
    return result.ok ? c.json({ ok: true as const }) : fail(c, result.error);
  });
  on(routes.providerProbe, async (c) => {
    if (!rt.providers) return noProviders(c);
    const actor = rt.principal(c);
    if (!can(actor, 'provider.manage')) return fail(c, forbidden('令牌没有 providers:manage'));
    const input = valid<Record<string, unknown>>(c, 'json');
    const result = await rt.providers.probe(actor, input);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.providerTest, async (c) => {
    if (!rt.providers) return noProviders(c);
    const actor = rt.principal(c);
    if (!can(actor, 'provider.manage')) return fail(c, forbidden('令牌没有 providers:manage'));
    const input = valid<{ workerId: string }>(c, 'json');
    const result = await rt.providers.testProvider(actor, c.req.param('providerId') ?? '', input.workerId);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.providerDelete, async (c) => {
    if (!rt.providers) return noProviders(c);
    const actor = rt.principal(c);
    if (!can(actor, 'provider.manage')) return fail(c, forbidden('令牌没有 providers:manage'));
    const providerId = c.req.param('providerId') ?? '';
    const confirm = valid<{ confirm?: boolean }>(c, 'json').confirm === true;
    const current = await rt.providers.deps.providers.byId(providerId);
    const view = providerActor(actor);
    if (!current || !canSeeProvider(view, current)) return fail(c, notFound('没有这个模型提供商'));
    if (!canManageProvider(view, current)) return fail(c, forbidden('无权管理这个模型提供商'));
    const impact = await providerImpact(providerId);
    if (!impact) return fail(c, notFound('没有这个模型提供商'));
    if (!confirm) return c.json({ confirmRequired: true, ...impact });
    const result = await rt.providers.removeProvider(actor, providerId);
    return result.ok ? c.json({ confirmed: true, ...impact }) : fail(c, result.error);
  });
  on(routes.providerRoutingSet, async (c) => {
    if (!rt.providers) return noProviders(c);
    const actor = rt.principal(c);
    if (!can(actor, 'provider.manage')) return fail(c, forbidden('令牌没有 providers:manage'));
    const workerId = c.req.param('workerId') ?? '';
    const input = valid<{ routing: 'direct' | 'hub' | null; confirm?: boolean }>(c, 'json');
    const routing = input.routing;
    const message =
      routing === null
        ? `将清除机器 ${workerId} 的路由覆盖，之后跟随提供商设置。已有会话保持当前路径，直到重启。`
        : `将把机器 ${workerId} 的路由改为${routing === 'hub' ? '经 hub 中转' : '直连'}。已有会话保持当前路径，直到重启。`;
    const impact = { action: 'routing_set', workerId, routing, message };
    if (input.confirm !== true) return c.json({ confirmRequired: true, ...impact });
    const result = await setWorkerProviderRouting(rt.providers.deps, actor, workerId, routing);
    return result.ok ? c.json({ confirmed: true, ...impact }) : fail(c, result.error);
  });
}
