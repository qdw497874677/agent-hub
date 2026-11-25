import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { Scalar } from '@scalar/hono-api-reference';
import { ATTACHMENT_LIMITS, authenticateApiToken, invalid, newId } from '@agent-hub/domain';
import type { Principal } from '@agent-hub/domain';
import { createIdempotency } from './idempotency.ts';
import { installAccess } from '../access.ts';
import { installHandoffMutationGate } from '../handoff-mutation-gate.ts';
import { fail } from '../http-error.ts';
import { createRateLimiter } from '../rate-limit.ts';
import { V1, routes } from './routes.ts';
import { effectiveWrites, handleMcp, INTERNAL } from './mcp.ts';
import { type Env, type OpenApiOptions, type V1Context, type V1Runtime } from './context.ts';
import { installAssets } from './handlers/assets.ts';
import { installMe, installMisc } from './handlers/misc.ts';
import { installProjects } from './handlers/projects.ts';
import { installProviders } from './handlers/providers.ts';
import { installSessionComms } from './handlers/session-comms.ts';
import { installSessionSettle, installSessionWork } from './handlers/session-work.ts';
import { installSessions, installSessionsLive, installSessionsStart } from './handlers/sessions.ts';
import { installTaskPulls, installTasks } from './handlers/tasks.ts';
import { installTokens } from './handlers/tokens.ts';
import { installWorkers } from './handlers/workers.ts';
import { installWorkspaces, installWorkspacesSweep } from './handlers/workspaces.ts';

export type { OpenApiOptions, V1Context } from './context.ts';

const unauthorized = (c: Context) => {
  c.header('WWW-Authenticate', 'Bearer realm="agent-hub"');
  return c.json({ error: { code: 'unauthorized', message: '缺少或无效的 API 令牌（Authorization: Bearer ahp_…）' } }, 401);
};

/**
 * 开放 API v1（ADR 0015）：/openapi/v1/*，只认 API 令牌（不认 cookie，所以没有 CSRF 这回事）。
 * 授权与网页同一套：installAccess（换前缀）+ 领域 can()，令牌的权限范围在 can() 里与账号权限取交集。
 */
export function installOpenApi(app: Hono, options: OpenApiOptions, ctx: V1Context): void {
  const { deps, hub } = ctx;
  const now = options.tokens.now;
  const v1 = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) return fail(c, invalid(`请求不合法：${result.error.issues.map((i) => `${i.path.join('.') || '(body)'} ${i.message}`).join('；')}`));
    }
  });
  const principal = (c: Context): Principal => c.get('principal') as Principal;
  /** 审计里标出「经哪个令牌做的」：自动化发布 / 分配要能追到令牌。 */
  const viaNote = (actor: Principal): string => (actor.via ? `（经令牌 ${actor.via.name} / ${actor.via.tokenId}）` : '');
  const projectLimited = (actor: Principal): boolean => (actor.via?.projectIds?.length ?? 0) > 0;
  const auditDefaultAgent = async (
    actor: Principal,
    target: string,
    agent: { readonly runtime: string; readonly model: string } | null
  ): Promise<void> => {
    if (!options.audit) return;
    const detail = agent === null ? '清空默认 Agent' : `默认 Agent：${agent.runtime} · ${agent.model === '' ? '运行时默认模型' : agent.model}`;
    await options.audit.append({
      id: newId(),
      actorId: actor.user.id,
      actorEmail: actor.user.email,
      action: 'project.worktree',
      target,
      detail: `${detail}${viaNote(actor)}`,
      at: now(),
      ip: null,
      teamId: actor.user.teamId ?? null
    });
  };
  const needGit = () => ctx.git ?? null;
  const openPolls = new Map<string, number>();
  /** 长轮询（P1d）：每 500ms 看一次，满足条件或到点就返回；客户端断开（signal.abort）立刻停。 */
  const waitUntil = async (c: Context, seconds: number | undefined, done: () => Promise<boolean>): Promise<Response | null> => {
    if (!seconds) return null;
    const token = principal(c).via!.tokenId;
    const open = openPolls.get(token) ?? 0;
    if (open >= maxStreams) return tooMany(c, 5, `每个令牌最多同时挂起 ${maxStreams} 条长轮询`);
    openPolls.set(token, open + 1);
    try {
      const until = Date.now() + Math.min(seconds, 50) * 1000;
      while (Date.now() < until && !c.req.raw.signal.aborted && !(await done())) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      const left = (openPolls.get(token) ?? 1) - 1;
      if (left <= 0) openPolls.delete(token);
      else openPolls.set(token, left);
    }
    return null;
  };
  const teamDefaultsDeps = () => {
    if (!options.teams || !deps.agentDefaults) return null;
    return { teams: options.teams, agentDefaults: deps.agentDefaults };
  };

  const general = createRateLimiter({ max: options.rate?.general ?? 120, windowMs: 60_000, now });
  const prompts = createRateLimiter({ max: options.rate?.prompt ?? 20, windowMs: 60_000, now });
  const maxStreams = options.rate?.streams ?? 5;
  const openStreams = new Map<string, number>();
  const tooMany = (c: Context, retry: number, message: string) => {
    c.header('Retry-After', String(retry));
    return c.json({ error: { code: 'rate_limited', message } }, 429);
  };

  const rt: V1Runtime = {
    ...ctx,
    deps,
    hub,
    options,
    now,
    principal,
    viaNote,
    projectLimited,
    auditDefaultAgent,
    teamDefaultsDeps,
    needGit,
    waitUntil,
    general,
    prompts,
    maxStreams,
    openStreams,
    tooMany
  };

  const PUBLIC = new Set([`${V1}/openapi.json`, `${V1}/docs`, `${V1}/health`, `${V1}/skills/agent-hub-workbench`]);
  v1.use(`${V1}/*`, async (c, next) => {
    if (PUBLIC.has(c.req.path) && c.req.method === 'GET') return next();
    const header = c.req.header('authorization') ?? '';
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const actor = raw ? await authenticateApiToken(options.tokens, raw) : null;
    if (!actor || !actor.via) return unauthorized(c);
    c.set('principal', actor);
    // MCP 工具内部转调的请求已经在 /mcp 那一次计过数了
    if (c.env?.[INTERNAL] !== true) {
      const key = actor.via.tokenId;
      if (!general.hit(key)) return tooMany(c, general.retryAfter(key), '请求太频繁了，稍后再试');
    }
    if (/\/sessions\/[^/]+\/prompt$/.test(c.req.path) && c.req.method === 'POST') {
      const key = actor.via.tokenId;
      if (!prompts.hit(key)) return tooMany(c, prompts.retryAfter(key), '发得太频繁了，稍后再试');
    }
    return next();
  });
  installAccess(v1 as unknown as Hono, deps, (c) => (c.get('principal') as Principal | undefined) ?? null, V1);
  installHandoffMutationGate(v1 as unknown as Hono, deps, V1, (c) => (c.get('principal') as Principal | undefined) ?? null);
  // 写请求的幂等重试：MCP 的 clientRequestId 与 REST 的 Idempotency-Key 走同一张表（24h）。
  v1.use(`${V1}/*`, createIdempotency({ store: options.replays }).handle);
  v1.use(
    `${V1}/sessions/:sessionId/prompt`,
    bodyLimit({ maxSize: Math.ceil((ATTACHMENT_LIMITS.totalBytes * 4) / 3) + 256 * 1024, onError: (c) => fail(c, invalid('附件合计太大')) as never })
  );

  v1.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
    description: '在「设置 → API 令牌」里创建；形如 `ahp_…`。'
  });

  // 注册顺序与拆分前逐条一致：Hono 先注册先匹配，参数路由会盖住后注册的同前缀静态路径。
  installMisc(v1, rt);
  installAssets(v1, rt);
  installMe(v1, rt);
  installWorkers(v1, rt);
  installProjects(v1, rt);
  installTasks(v1, rt);
  installSessionsStart(v1, rt);
  installWorkspaces(v1, rt);
  installSessionWork(v1, rt);
  installTaskPulls(v1, rt);
  installSessionSettle(v1, rt);
  installWorkspacesSweep(v1, rt);
  installSessions(v1, rt);
  installSessionComms(v1, rt);
  installProviders(v1, rt);
  installTokens(v1, rt);
  installSessionsLive(v1, rt);

  // MCP（streamable HTTP，无状态）：工具 = 上面这些路由；同一个令牌、同一套权限。
  v1.post(`${V1}/mcp`, async (c) =>
    handleMcp(c, v1 as unknown as Hono, {
      ...(options.replays === undefined ? {} : { replays: options.replays }),
      ...(options.audit === undefined ? {} : { audit: options.audit }),
      writes: effectiveWrites(await options.settings?.get().catch(() => null)).writes,
      now: options.tokens.now
    })
  );
  v1.on(['GET', 'DELETE'], `${V1}/mcp`, (c) => c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed（无状态，只收 POST）' }, id: null }, 405));

  v1.doc31(`${V1}/openapi.json`, openApiInfo);
  v1.get(`${V1}/docs`, Scalar({ url: `${V1}/openapi.json`, pageTitle: 'Agent Hub 开放 API', theme: 'default' }));

  app.route('/', v1 as unknown as Hono);
}

export const openApiInfo = {
  openapi: '3.1.0',
  info: {
    title: 'Agent Hub 开放 API',
    version: '1.0.0',
    description:
      '给内部 / 外部 agent 和脚本用的稳定接口（ADR 0015）。\n\n' +
      '- 认证：`Authorization: Bearer ahp_…`，令牌在「设置 → API 令牌」里创建，只显示一次。\n' +
      '- 权限 = 令牌的权限范围 ∩ 账号在团队里的权限；hub 本机的机器永远用不了。\n' +
      '- 限流：每个令牌每分钟 120 次请求、20 次 prompt，超了 429 + Retry-After。\n' +
      '- MCP：同一个令牌 POST `/openapi/v1/mcp`（streamable HTTP）。对外只暴露显式登记的工具（项目、任务、工作日志、会话事件；写工具要 `MCP_WRITE=1`，且必须带 `clientRequestId`）。\n' +
      '- 错误统一为 `{ error: { code, message } }`。'
  },
  servers: [{ url: '/' }]
};

/** 给契约快照用：不起服务，直接生成规范。 */
export function buildSpecApp(): OpenAPIHono<Env> {
  const v1 = new OpenAPIHono<Env>();
  v1.openAPIRegistry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer', description: '在「设置 → API 令牌」里创建；形如 `ahp_…`。' });
  for (const r of Object.values(routes)) v1.openapi(r as never, (() => new Response()) as never);
  return v1;
}
