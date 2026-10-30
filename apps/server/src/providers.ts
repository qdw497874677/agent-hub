import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import {
  checkProviderModel,
  createProvider,
  deleteProvider,
  invalid,
  listProviders,
  parseHubModel,
  providerActor,
  providerUsableIn,
  recordProviderCheck,
  routingFor,
  setProviderKey,
  setWorkerProviderRouting,
  canManageProvider,
  canUseProvider,
  hubModelId,
  err,
  ok,
  type DomainError,
  type ModelProvider,
  type Principal,
  type ProviderDeps,
  type ProviderGrant,
  type ProviderRouting,
  type Result,
  type WorkerCommand,
  updateProvider
} from '@agent-hub/domain';
import { DEFAULT_PROXY_LIMITS, PayloadTooLarge, errorResponse, forwardProvider, offeredToken, readLimited, type ProxyLimits } from '@agent-hub/node-gateway';
import { fail } from './http-error.ts';

/**
 * 模型提供商的组合根（ADR 0013）：
 * - start_session 发出前配上 ProviderGrant（D3：只给选中的那一个）；
 * - 经 hub 中转（via=hub）的 /provider-relay/:handle/*：每个请求都重新核对提供商、作用域和会话落点，
 *   真密钥只在这里换到发往上游的请求头上，不离开 hub；
 * - /api/providers 的增删改查、密钥、连通测试（从 worker 发起，D4）与按 worker 的路由覆盖。
 */
export interface ProviderWiring {
  readonly deps: ProviderDeps;
  /** 项目的团队（null = 不分团队）。 */
  projectTeam(taskId: string): Promise<string | null>;
  /** personal 提供商主人所在团队。 */
  userTeam(userId: string): Promise<string | null>;
  hostOf(sessionId: string): string | null;
  testFromWorker(workerId: string, input: { protocol: ModelProvider['protocol']; baseUrl: string; apiKey: string }): Promise<Result<{ ok: boolean; status: number; message: string; models: string[] }, DomainError>>;
  log(line: string): void;
  limits?: ProxyLimits;
  /** 中转句柄的路径前缀（worker 按自己连的 hub 地址补全）。 */
  readonly relayPath?: string;
}

interface Handle {
  readonly sessionId: string;
  readonly workerId: string;
  readonly providerId: string;
  readonly projectTeam: string | null;
  readonly token: Buffer;
  /** 测试句柄：不绑会话，过期即作废。 */
  readonly expiresAt: number | null;
}

export const RELAY_PATH = '/provider-relay';

const same = (offered: string, expected: Buffer): boolean => {
  const given = Buffer.from(offered, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
};

export function createProviderWiring(wiring: ProviderWiring) {
  const { deps } = wiring;
  const limits = wiring.limits ?? DEFAULT_PROXY_LIMITS;
  const relayPath = wiring.relayPath ?? RELAY_PATH;
  const handles = new Map<string, Handle>();
  const bySession = new Map<string, string>();

  function issue(entry: Omit<Handle, 'token'>): { handle: string; token: string } {
    const handle = randomBytes(18).toString('base64url');
    const token = randomBytes(32).toString('base64url');
    handles.set(handle, { ...entry, token: Buffer.from(token, 'utf8') });
    if (entry.expiresAt === null) {
      const previous = bySession.get(entry.sessionId);
      if (previous) handles.delete(previous);
      bySession.set(entry.sessionId, handle);
    }
    return { handle, token };
  }

  function revoke(sessionId: string): void {
    const handle = bySession.get(sessionId);
    if (handle) handles.delete(handle);
    bySession.delete(sessionId);
  }

  async function ownerTeam(provider: ModelProvider): Promise<string | null> {
    return provider.scope === 'personal' && provider.ownerId ? wiring.userTeam(provider.ownerId) : null;
  }

  /** start_session 发出前：选的是 hub-<slug>/… 就配上提供商；不能用就报错（会话以失败收场，不静默换模型）。 */
  async function grantFor(command: WorkerCommand): Promise<Result<WorkerCommand, DomainError>> {
    if (command.kind !== 'start_session') return ok(command);
    const model = typeof command.options['model'] === 'string' ? (command.options['model'] as string) : '';
    const parsed = parseHubModel(model);
    if (!parsed) return ok(command);
    const provider = await deps.providers.bySlug(parsed.slug);
    if (!provider) return err(invalid(`没有模型提供商「${parsed.slug}」`));
    const projectTeam = await wiring.projectTeam(command.taskId);
    const usable = providerUsableIn(provider, projectTeam, await ownerTeam(provider));
    if (!usable.ok) return usable;
    const via = await routingFor(deps, provider, command.workerId);
    let grant: ProviderGrant;
    if (via === 'hub') {
      const issued = issue({ sessionId: command.sessionId, workerId: command.workerId, providerId: provider.id, projectTeam, expiresAt: null });
      grant = { slug: provider.slug, name: provider.name, protocol: provider.protocol, models: provider.models, via, baseUrl: `${relayPath}/${issued.handle}`, apiKey: issued.token };
    } else {
      const apiKey = await deps.providers.revealKey(provider.id);
      if (!apiKey) return err(invalid('这个模型提供商还没有配置密钥'));
      grant = { slug: provider.slug, name: provider.name, protocol: provider.protocol, models: provider.models, via, baseUrl: provider.baseUrl, apiKey };
    }
    await deps.providers.addUsage(provider.id, { sessions: 1 }, deps.now());
    wiring.log(`会话 ${command.sessionId} 用模型提供商「${provider.slug}」（${via === 'hub' ? '经 hub 中转' : 'worker 直连'}）`);
    return ok({ ...command, provider: grant });
  }

  /** 经 hub 中转的请求。不在 /api 下（worker 没有登录态），凭句柄 + 令牌认。 */
  async function relay(c: Context): Promise<Response> {
    const handle = c.req.param('handle') ?? '';
    const entry = handles.get(handle);
    if (!entry) return errorResponse(404, '没有这个中转会话（会话已结束？）');
    if (!same(offeredToken({ get: (name) => c.req.header(name) ?? null }), entry.token)) return errorResponse(401, '中转令牌不对');
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      handles.delete(handle);
      return errorResponse(404, '测试句柄已过期');
    }
    // 每个请求重新核对：会话还在这台 worker 上、提供商还在、还启用、作用域仍允许
    if (entry.expiresAt === null && wiring.hostOf(entry.sessionId) !== entry.workerId) return errorResponse(403, '会话不在这台 worker 上');
    const provider = await deps.providers.byId(entry.providerId);
    if (!provider) return errorResponse(403, '模型提供商已删除');
    const usable = providerUsableIn(provider, entry.projectTeam, await ownerTeam(provider));
    if (!usable.ok) return errorResponse(403, usable.error.message);
    const apiKey = await deps.providers.revealKey(provider.id);
    if (!apiKey) return errorResponse(403, '这个模型提供商还没有配置密钥');
    const prefix = `${relayPath}/${handle}`;
    const url = new URL(c.req.url);
    const subpath = url.pathname.slice(url.pathname.indexOf(prefix) + prefix.length) + url.search || '/';
    let body: Uint8Array;
    try {
      body = c.req.raw.body ? await readLimited(c.req.raw.body as unknown as AsyncIterable<Uint8Array>, limits.maxRequestBytes) : new Uint8Array();
    } catch (failure) {
      return errorResponse(failure instanceof PayloadTooLarge ? 413 : 400, failure instanceof PayloadTooLarge ? '请求体太大' : '请求体读不完');
    }
    return forwardProvider(
      { method: c.req.method, subpath, headers: { get: (name) => c.req.header(name) ?? null }, body },
      { baseUrl: provider.baseUrl, apiKey, protocol: provider.protocol },
      limits,
      (outcome) =>
        void deps.providers
          .addUsage(provider.id, { requests: 1, errors: outcome.ok ? 0 : 1, bytesIn: outcome.bytesIn, bytesOut: outcome.bytesOut }, deps.now())
          .catch(() => undefined)
    );
  }

  /** 派生 / 分叉时核对选的 hub 模型。 */
  async function checkModel(principal: Principal | null, model: string | undefined, taskId: string): Promise<Result<true, DomainError>> {
    if (!parseHubModel(model)) return ok(true);
    const checked = await checkProviderModel(deps, principal, model ?? '', await wiring.projectTeam(taskId));
    return checked.ok ? ok(true) : checked;
  }

  /** D3：换提供商 = 新开会话；同一提供商里换模型可以。 */
  function optionAllowed(currentModel: string, optionId: string, value: unknown): Result<true, DomainError> {
    if (optionId !== 'model' || typeof value !== 'string') return ok(true);
    const before = parseHubModel(currentModel)?.slug ?? null;
    const after = parseHubModel(value)?.slug ?? null;
    if (before === after) return ok(true);
    return err(invalid('换模型提供商需新开会话（hub 提供商的模型只能在开会话时选）'));
  }

  function install(app: Hono, principalOf: (c: Context) => Principal | null): void {
    const read = async (c: Context): Promise<Record<string, unknown> | null> => {
      try {
        const value = (await c.req.json()) as unknown;
        return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    const badBody = (c: Context) => fail(c, invalid('请求体不是 JSON 对象'));
    const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
    const asInput = (input: Record<string, unknown>) => ({
      slug: str(input['slug']),
      name: str(input['name']),
      protocol: str(input['protocol'], 'openai-chat') as ModelProvider['protocol'],
      baseUrl: str(input['baseUrl']),
      models: Array.isArray(input['models'])
        ? (input['models'] as unknown[]).flatMap((item) =>
            typeof item === 'string'
              ? [{ id: item }]
              : item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
                ? [{ id: (item as { id: string }).id, ...(typeof (item as { name?: unknown }).name === 'string' ? { name: (item as { name: string }).name } : {}), ...(typeof (item as { contextWindow?: unknown }).contextWindow === 'number' ? { contextWindow: (item as { contextWindow: number }).contextWindow } : {}), ...(typeof (item as { maxTokens?: unknown }).maxTokens === 'number' ? { maxTokens: (item as { maxTokens: number }).maxTokens } : {}) }]
                : []
          )
        : [],
      routing: str(input['routing'], 'direct') as ProviderRouting,
      enabled: input['enabled'] !== false
    });

    app.get('/api/providers', async (c) => c.json({ providers: await listProviders(deps, principalOf(c)), workerRouting: await deps.providers.workerRouting() }));

    /** 会话里能选的 hub 模型（按项目团队过滤）：模型选择器用。 */
    app.get('/api/providers/models', async (c) => {
      const principal = principalOf(c);
      const actor = providerActor(principal);
      const taskId = c.req.query('taskId') ?? '';
      const team = taskId ? await wiring.projectTeam(taskId) : null;
      const out = [];
      for (const provider of await deps.providers.list()) {
        if (!canUseProvider(actor, provider, team).ok) continue;
        out.push({ slug: provider.slug, name: provider.name, protocol: provider.protocol, models: provider.models.map((model) => ({ id: hubModelId(provider.slug, model.id), label: model.name ?? model.id })) });
      }
      return c.json(out);
    });

    app.post('/api/providers', async (c) => {
      const input = await read(c);
      if (!input) return badBody(c);
      const scope = str(input['scope'], 'personal') as 'personal' | 'team' | 'hub';
      const apiKey = typeof input['apiKey'] === 'string' && input['apiKey'] ? input['apiKey'] : undefined;
      const result = await createProvider(deps, principalOf(c), { ...asInput(input), scope, ...(apiKey ? { apiKey } : {}) });
      return result.ok ? c.json(result.value, 201) : fail(c, result.error);
    });
    app.put('/api/providers/:id', async (c) => {
      const input = await read(c);
      if (!input) return badBody(c);
      const result = await updateProvider(deps, principalOf(c), c.req.param('id'), asInput(input));
      return result.ok ? c.json(result.value) : fail(c, result.error);
    });
    app.put('/api/providers/:id/key', async (c) => {
      const input = await read(c);
      if (!input) return badBody(c);
      const result = await setProviderKey(deps, principalOf(c), c.req.param('id'), str(input['apiKey']));
      return result.ok ? c.json({ ok: true }) : fail(c, result.error);
    });
    app.delete('/api/providers/:id', async (c) => {
      const result = await deleteProvider(deps, principalOf(c), c.req.param('id'));
      return result.ok ? c.json({ ok: true }) : fail(c, result.error);
    });
    app.put('/api/providers/routing/:workerId', async (c) => {
      const input = await read(c);
      if (!input) return badBody(c);
      const routing = input['routing'] === 'direct' || input['routing'] === 'hub' ? input['routing'] : null;
      const result = await setWorkerProviderRouting(deps, principalOf(c), c.req.param('workerId'), routing);
      return result.ok ? c.json({ ok: true }) : fail(c, result.error);
    });

    /** D4：从 worker 发起（直连 = worker→提供商；经 hub = worker→hub→提供商）。 */
    app.post('/api/providers/:id/test', async (c) => {
      const principal = principalOf(c);
      const input = await read(c);
      if (!input) return badBody(c);
      const workerId = str(input['workerId']);
      const provider = await deps.providers.byId(c.req.param('id'));
      if (!provider || !canManageProvider(providerActor(principal), provider)) return fail(c, invalid('没有这个模型提供商，或你无权管理它'));
      if (!workerId) return fail(c, invalid('要选一台 worker 来测'));
      const via = await routingFor(deps, provider, workerId);
      let target: { baseUrl: string; apiKey: string };
      let testHandle: string | null = null;
      if (via === 'hub') {
        if (!provider.hasKey) return fail(c, invalid('这个模型提供商还没有配置密钥'));
        const issued = issue({ sessionId: `test:${provider.id}`, workerId, providerId: provider.id, projectTeam: null, expiresAt: Date.now() + 60_000 });
        testHandle = issued.handle;
        target = { baseUrl: `${relayPath}/${issued.handle}`, apiKey: issued.token };
      } else {
        const apiKey = await deps.providers.revealKey(provider.id);
        if (!apiKey) return fail(c, invalid('这个模型提供商还没有配置密钥'));
        target = { baseUrl: provider.baseUrl, apiKey };
      }
      const result = await wiring.testFromWorker(workerId, { protocol: provider.protocol, ...target });
      if (testHandle) handles.delete(testHandle);
      if (!result.ok) return fail(c, result.error);
      const check = { ok: result.value.ok, message: result.value.message, at: deps.now(), via, workerId };
      await recordProviderCheck(deps, principal, provider, check);
      return c.json({ ...check, models: result.value.models });
    });
  }

  return { grantFor, relay, revoke, checkModel, optionAllowed, install, activeHandles: () => handles.size };
}

export type ProviderWiringApi = ReturnType<typeof createProviderWiring>;
