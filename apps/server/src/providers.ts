import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import {
  checkProviderModel,
  createProvider,
  deleteProvider,
  invalid,
  forbidden,
  notFound,
  listProviders,
  parseHubModel,
  PROVIDER_PROTOCOLS,
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
  type ProviderModel,
  type ProviderProtocol,
  type Subject,
  type ProviderDeps,
  type ProviderGrant,
  type ProviderRouting,
  type Result,
  type WorkerCommand,
  updateProvider
} from '@agent-hub/domain';
import { DEFAULT_PROXY_LIMITS, PayloadTooLarge, authHeaders, errorResponse, forwardProvider, offeredToken, readLimited, type ProxyLimits } from '@agent-hub/node-gateway';
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
  /** 按项目 id 查团队（项目设置里挑提炼模型用）。 */
  projectTeamOf?(projectId: string): Promise<string | null>;
  /** personal 提供商主人所在团队。 */
  userTeam(userId: string): Promise<string | null>;
  hostOf(sessionId: string): string | null;
  testFromWorker(workerId: string, input: { protocol: ModelProvider['protocol']; baseUrl: string; apiKey: string }): Promise<Result<{ ok: boolean; status: number; message: string; models: string[] }, DomainError>>;
  /** 把 provider 的新模型定义推给已建立的 direct 会话（只有 extra 这类请求参数即时生效）。离线/失败返回 false。 */
  updateProvider?(sessionId: string, workerId: string, models: readonly ProviderModel[]): boolean;
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

/** 出 HTTP 的供应商对象。密钥只进保险箱，任何响应都不带 apiKey 字段，也不带明文。 */
export function publicProvider<T extends object>(value: T): Omit<T, 'apiKey'> {
  const copy = { ...value } as Record<string, unknown>;
  delete copy['apiKey'];
  return copy as Omit<T, 'apiKey'>;
}

const same = (offered: string, expected: Buffer): boolean => {
  const given = Buffer.from(offered, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
};

/** hub 直连探测的边界：15 秒、1MB、最多 500 个模型（与 worker 侧一致）。 */
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_BYTES = 1024 * 1024;
const PROBE_MAX_MODELS = 500;

export interface ProviderProbe {
  readonly ok: boolean;
  readonly status: number;
  readonly message: string;
  readonly models: ProviderModel[];
}

/** 上游元数据只在是正数时才算数：0 / null / 字符串一律当没有。 */
const positiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

/**
 * 从 GET /models 的 JSON 里尽力富化模型（拿不到元数据就只给 id）：
 * data[]（OpenAI / Anthropic）或 models[]（兼容实现），
 * 认 context_length、max_completion_tokens、max_output_tokens、display_name 与 OpenRouter 的 top_provider.max_completion_tokens。
 */
export function modelsFromProbeBody(value: unknown): ProviderModel[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Array.isArray((value as { data?: unknown }).data)
        ? (value as { data: unknown[] }).data
        : Array.isArray((value as { models?: unknown }).models)
          ? (value as { models: unknown[] }).models
          : []
      : [];
  const out: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, PROBE_MAX_MODELS)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    if (typeof item['id'] !== 'string' || !item['id'].trim()) continue;
    const id = item['id'].trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const top = item['top_provider'];
    const contextWindow = positiveInt(item['context_length']);
    const maxTokens =
      positiveInt(item['max_completion_tokens']) ??
      positiveInt(item['max_output_tokens']) ??
      (top && typeof top === 'object' ? positiveInt((top as Record<string, unknown>)['max_completion_tokens']) : undefined);
    const display = typeof item['display_name'] === 'string' ? item['display_name'].trim() : typeof item['name'] === 'string' ? item['name'].trim() : '';
    out.push({ id, ...(display ? { name: display } : {}), ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}) });
  }
  return out;
}

/** 读完探测响应，超过 1MB 返回 null（不把上游的大响应读进内存）。 */
async function readProbeBody(response: Response): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PROBE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * hub 直连探测 GET <baseUrl>/models：15s 超时、1MB 响应上限，按协议带鉴权头。
 * 上游 4xx/5xx 不抛错，照实返回 ok:false（message 里不回显密钥）；连不上 status:0。
 */
export async function probeModelsDirect(input: { readonly protocol: ProviderProtocol; readonly baseUrl: string; readonly apiKey?: string }): Promise<ProviderProbe> {
  const url = input.baseUrl.trim().replace(/\/+$/, '') + '/models';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (input.apiKey) {
    Object.assign(headers, authHeaders(input.protocol, input.apiKey));
    if (input.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  }
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (failure) {
    const timedOut = failure instanceof Error && (failure.name === 'TimeoutError' || failure.name === 'AbortError');
    return { ok: false, status: 0, message: timedOut ? '连不上：超时' : `连不上：${failure instanceof Error ? failure.message : String(failure)}`, models: [] };
  }
  const text = await readProbeBody(response);
  if (text === null) return { ok: false, status: response.status, message: `响应太大（超过 ${PROBE_MAX_BYTES} 字节）`, models: [] };
  const scrubbed = input.apiKey ? text.split(input.apiKey).join('***') : text;
  const snippet = scrubbed.replace(/\s+/g, ' ').slice(0, 200);
  if (!response.ok) return { ok: false, status: response.status, message: `HTTP ${response.status}${snippet ? `：${snippet}` : ''}`, models: [] };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 不是 JSON：照样算通，只是拿不到模型
  }
  const models = modelsFromProbeBody(parsed);
  return { ok: true, status: response.status, message: `通了：${models.length} 个模型`, models };
}

/** 宽松解析模型字段：不认识的值留给领域校验（extra 非法时由 providerModelExtraError 给出中文原因）。 */
function asModel(item: unknown): ProviderModel[] {
  if (typeof item === 'string') return [{ id: item }];
  if (!item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string') return [];
  const model = item as Record<string, unknown>;
  const extra = model['extra'];
  return [
    {
      id: model['id'] as string,
      ...(typeof model['name'] === 'string' ? { name: model['name'] } : {}),
      ...(typeof model['contextWindow'] === 'number' ? { contextWindow: model['contextWindow'] } : {}),
      ...(typeof model['maxTokens'] === 'number' ? { maxTokens: model['maxTokens'] } : {}),
      ...(extra === undefined || extra === null ? {} : { extra: extra as Record<string, unknown> })
    }
  ];
}

export function createProviderWiring(wiring: ProviderWiring) {
  const { deps } = wiring;
  const limits = wiring.limits ?? DEFAULT_PROXY_LIMITS;
  const relayPath = wiring.relayPath ?? RELAY_PATH;
  const handles = new Map<string, Handle>();
  const bySession = new Map<string, string>();
  /**
   * 已建立的 direct 会话（worker 直连上游）：provider 的请求参数改了要把新模型定义推下去。
   * via=hub 的中继每个请求都重新读库，不用推。
   */
  const directSessions = new Map<string, { readonly providerId: string; readonly workerId: string }>();

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
    directSessions.delete(sessionId);
  }

  /**
   * 把某 provider 的新模型定义推给仍在跑的 direct 会话（best-effort）：
   * extra 这类请求参数即时生效；contextWindow / maxTokens 已写进 agent 启动配置，要下次启动才变。
   */
  function pushModels(provider: ModelProvider, models: readonly ProviderModel[]): void {
    for (const [sessionId, entry] of directSessions) {
      if (entry.providerId !== provider.id) continue;
      let pushed = false;
      try {
        pushed = wiring.updateProvider?.(sessionId, entry.workerId, models) ?? false;
      } catch (failure) {
        wiring.log(`推送模型参数给会话 ${sessionId} 时出错：${failure instanceof Error ? failure.message : String(failure)}`);
      }
      if (!pushed) wiring.log(`会话 ${sessionId} 没收到「${provider.slug}」的新模型参数（worker 离线或版本过旧），它仍用旧参数`);
    }
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
      directSessions.delete(command.sessionId);
      const issued = issue({ sessionId: command.sessionId, workerId: command.workerId, providerId: provider.id, projectTeam, expiresAt: null });
      grant = { slug: provider.slug, name: provider.name, protocol: provider.protocol, models: provider.models, via, baseUrl: `${relayPath}/${issued.handle}`, apiKey: issued.token };
    } else {
      const apiKey = await deps.providers.revealKey(provider.id);
      if (!apiKey) return err(invalid('这个模型提供商还没有配置密钥'));
      directSessions.set(command.sessionId, { providerId: provider.id, workerId: command.workerId });
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
      { baseUrl: provider.baseUrl, apiKey, protocol: provider.protocol, models: provider.models },
      limits,
      (outcome) =>
        void deps.providers
          .addUsage(provider.id, { requests: 1, errors: outcome.ok ? 0 : 1, bytesIn: outcome.bytesIn, bytesOut: outcome.bytesOut }, deps.now())
          .catch(() => undefined)
    );
  }

  /** 派生 / 分叉时核对选的 hub 模型。 */
  async function checkModel(principal: Subject | null, model: string | undefined, taskId: string): Promise<Result<ModelProvider['protocol'] | null, DomainError>> {
    if (!parseHubModel(model)) return ok(null);
    const checked = await checkProviderModel(deps, principal, model ?? '', await wiring.projectTeam(taskId));
    return checked.ok ? ok(checked.value?.protocol ?? null) : checked;
  }

  /** D3：换提供商 = 新开会话；同一提供商里换模型可以。 */
  function optionAllowed(currentModel: string, optionId: string, value: unknown): Result<true, DomainError> {
    if (optionId !== 'model' || typeof value !== 'string') return ok(true);
    const before = parseHubModel(currentModel)?.slug ?? null;
    const after = parseHubModel(value)?.slug ?? null;
    if (before === after) return ok(true);
    return err(invalid('换模型提供商需新开会话（hub 提供商的模型只能在开会话时选）'));
  }

  function install(app: Hono, principalOf: (c: Context) => Subject | null): void {
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
      models: Array.isArray(input['models']) ? (input['models'] as unknown[]).flatMap(asModel) : [],
      routing: str(input['routing'], 'direct') as ProviderRouting,
      enabled: input['enabled'] !== false
    });

    app.get('/api/providers', async (c) => c.json({ providers: (await listProviders(deps, principalOf(c))).map(publicProvider), workerRouting: await deps.providers.workerRouting() }));

    /** 会话里能选的 hub 模型（按项目团队过滤）：模型选择器用。 */
    app.get('/api/providers/models', async (c) => {
      const principal = principalOf(c);
      const actor = providerActor(principal);
      const taskId = c.req.query('taskId') ?? '';
      const projectId = c.req.query('projectId') ?? '';
      const team = taskId ? await wiring.projectTeam(taskId) : projectId && wiring.projectTeamOf ? await wiring.projectTeamOf(projectId) : null;
      const out = [];
      for (const provider of await deps.providers.list()) {
        if (!canUseProvider(actor, provider, team).ok) continue;
        out.push({ slug: provider.slug, name: provider.name, protocol: provider.protocol, scope: provider.scope, models: provider.models.map((model) => ({ id: hubModelId(provider.slug, model.id), label: model.name ?? model.id })) });
      }
      return c.json(out);
    });

    /**
     * 探测模型列表：给 providerId 就用库里存的密钥（要能管它），否则接受临时填的地址 / 密钥。
     * 指定 worker 且在线时从 worker 发起（D4）；否则 hub 直连 GET /models。
     * 上游 4xx/5xx 也返回 200 + ok:false；连不上 status:0。
     */
    app.post('/api/providers/probe', async (c) => {
      const principal = principalOf(c);
      if (!principal) return fail(c, forbidden('登录后才能探测模型列表'));
      const input = await read(c);
      if (!input) return badBody(c);
      let provider: ModelProvider | null = null;
      const providerId = str(input['providerId']);
      if (providerId) {
        provider = await deps.providers.byId(providerId);
        if (!provider) return fail(c, notFound('没有这个模型提供商'));
        if (!canManageProvider(providerActor(principal), provider)) return fail(c, forbidden('无权管理这个模型提供商'));
      }
      const protocol = (str(input['protocol']) || provider?.protocol || 'openai-chat') as ProviderProtocol;
      if (!PROVIDER_PROTOCOLS.includes(protocol)) return fail(c, invalid('不支持的协议'));
      const baseUrl = (str(input['baseUrl']) || provider?.baseUrl || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s/]+(\/\S*)?$/.test(baseUrl)) return fail(c, invalid('Base URL 需要是 http(s) 地址'));
      let apiKey = typeof input['apiKey'] === 'string' ? input['apiKey'].trim() : '';
      if (!apiKey && provider) apiKey = (await deps.providers.revealKey(provider.id)) ?? '';
      const workerId = str(input['workerId']);
      // 契约里 apiKey 必填：没密钥（本机免鉴权的上游）就直接走 hub 直连
      if (workerId && apiKey) {
        const tested = await wiring.testFromWorker(workerId, { protocol, baseUrl, apiKey });
        if (tested.ok) {
          return c.json({ ok: tested.value.ok, status: tested.value.status, message: tested.value.message, via: 'worker', models: tested.value.models.map((id) => ({ id })) });
        }
        // 这台 worker 不在线 / 通道不可用：退回 hub 直连，别让探测因为选错机器就失败
      }
      const probe = await probeModelsDirect({ protocol, baseUrl, ...(apiKey ? { apiKey } : {}) });
      return c.json({ ...probe, via: 'hub' });
    });

    app.post('/api/providers', async (c) => {
      const input = await read(c);
      if (!input) return badBody(c);
      const scope = str(input['scope'], 'personal') as 'personal' | 'team' | 'hub';
      const apiKey = typeof input['apiKey'] === 'string' && input['apiKey'] ? input['apiKey'] : undefined;
      const result = await createProvider(deps, principalOf(c), { ...asInput(input), scope, ...(apiKey ? { apiKey } : {}) });
      return result.ok ? c.json(publicProvider(result.value), 201) : fail(c, result.error);
    });
    app.put('/api/providers/:id', async (c) => {
      const input = await read(c);
      if (!input) return badBody(c);
      const result = await updateProvider(deps, principalOf(c), c.req.param('id'), asInput(input));
      if (result.ok) pushModels(result.value, result.value.models);
      return result.ok ? c.json(publicProvider(result.value)) : fail(c, result.error);
    });
    app.put('/api/providers/:id/key', async (c) => {
      const input = await read(c);
      if (!input) return badBody(c);
      const result = await setProviderKey(deps, principalOf(c), c.req.param('id'), str(input['apiKey']));
      if (result.ok) {
        // 换密钥不影响 extra，但顺手推一次：保证已建立的会话与库里的定义一致
        const provider = await deps.providers.byId(c.req.param('id'));
        if (provider) pushModels(provider, provider.models);
      }
      return result.ok ? c.json({ ok: true }) : fail(c, result.error);
    });
    app.delete('/api/providers/:id', async (c) => {
      const provider = await deps.providers.byId(c.req.param('id'));
      const result = await deleteProvider(deps, principalOf(c), c.req.param('id'));
      if (result.ok && provider) {
        // 提供商没了：已建立的 direct 会话不再带它原来的 extra
        pushModels(provider, []);
        for (const [sessionId, entry] of directSessions) if (entry.providerId === provider.id) directSessions.delete(sessionId);
      }
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
