import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AuditLog, McpReplayStore, Permission, Principal } from '@agent-hub/domain';
import { resolveMcp, routes, type McpModule, type ResolvedMcp } from './routes.ts';

/** 内部转调的标记：只有这个模块拿得到，外面的请求伪造不了（放在 env 里，不是请求头）。 */
export const INTERNAL: unique symbol = Symbol('openapi-internal');

type RouteDef = (typeof routes)[keyof typeof routes];

export type McpModuleName = McpModule;

/**
 * 对外 MCP 的工具清单**不在这里登记**——唯一来源是 routes.ts 每条路由上的第三参（`McpRouteExposure`）。
 * 新增 v1 路由必须在路由上回答「是不是工具 / 叫什么 / 要什么权限」（GET 可用 `'auto'`，写操作与不暴露必须显式写），
 * 这样「加个路由就悄悄对外」和「表漂移」都不会再发生。这里只负责分组、只读闸门与调用转调。
 */

export interface McpPolicy {
  /** 允许的分组；缺省 = 全部允许的分组。 */
  readonly modules?: ReadonlySet<McpModuleName>;
  /** 只暴露只读工具（并且拒绝调用写工具）。 */
  readonly readOnly?: boolean;
  /** 是否暴露写工具（默认否；`MCP_WRITE=1` 打开）。 */
  readonly writes?: boolean;
}

const ALL_MODULES: readonly McpModuleName[] = ['tasks', 'projects', 'sessions', 'assets', 'workers', 'workspaces'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly route: RouteDef;
  readonly pathKeys: readonly string[];
  readonly queryKeys: readonly string[];
  /** 'flat' = 请求体字段直接摊在参数里；'nested' = 放在 body 里；null = 没有请求体。 */
  readonly body: 'flat' | 'nested' | null;
  readonly module: McpModuleName;
  /** 令牌要有这个权限点，工具才会出现在 tools/list 里（#E4：不列令牌用不了的工具）。 */
  readonly need: Permission;
  /** 文档里的权限范围（报错时告诉调用方缺哪个）。 */
  readonly scope: string | null;
  readonly readOnly: boolean;
  readonly idempotent: boolean;
  readonly project?: (value: unknown) => unknown;
}

/** SSE 不适合做工具（MCP 客户端用 session_events 轮询）——这条在 routes.ts 的 stream 上已标 skip。 */

const envFlag = (name: string): boolean => {
  const raw = typeof process === 'undefined' ? undefined : process.env[name];
  return raw === '1' || raw?.toLowerCase() === 'true';
};

const envModules = (): ReadonlySet<McpModuleName> => {
  const raw = typeof process === 'undefined' ? undefined : process.env['MCP_MODULES'];
  const listed = (raw ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  const known = ALL_MODULES.filter((m) => listed.includes(m));
  return new Set(known.length > 0 ? known : ALL_MODULES);
};

/** 环境变量里的强制只读：MCP_READ_ONLY=1，或旧变量 MCP_WRITE=0。 */
export const envForcedReadOnly = (): boolean =>
  envFlag('MCP_READ_ONLY') ||
  (typeof process === 'undefined' ? undefined : process.env['MCP_WRITE']) === '0';

export const policyFromEnv = (): McpPolicy => ({
  modules: envModules(),
  readOnly: envForcedReadOnly(),
  writes: !envForcedReadOnly()
});

type Shape = Record<string, z.ZodType>;
const shapeOf = (schema: unknown): Shape | null => {
  const s = schema as { shape?: Shape } | undefined;
  return s && typeof s === 'object' && s.shape ? s.shape : null;
};
const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;

function toolOf(key: string, route: RouteDef, meta: ResolvedMcp): ToolDef {
  const request = (route as { request?: { params?: unknown; query?: unknown; body?: { content: Record<string, { schema: z.ZodType }> } } }).request ?? {};
  const params = shapeOf(request.params) ?? {};
  const query = shapeOf(request.query) ?? {};
  const bodySchema = request.body?.content['application/json']?.schema ?? null;
  const bodyShape = bodySchema ? shapeOf(bodySchema) : null;
  const shape: Shape = {};
  for (const [k, v] of Object.entries(params)) shape[k] = v;
  for (const [k, v] of Object.entries(query)) shape[k] = v;
  let body: ToolDef['body'] = null;
  if (bodySchema && bodyShape && !Object.keys(bodyShape).some((k) => k in shape)) {
    Object.assign(shape, bodyShape);
    body = 'flat';
  } else if (bodySchema) {
    shape.body = bodySchema;
    body = 'nested';
  }
  const r = route as { summary?: string; description?: string; method: string; path: string };
  // 路由 description 末尾那句「MCP 工具：`x`」是写给 REST 文档的；放进工具说明里是自指，去掉。
  const described = (r.description ?? '').replace(/\n*MCP 工具：`[^`]*`\s*$/, '');
  const rest = `${r.method.toUpperCase()} ${r.path}`;
  const head = `${r.summary ?? key}（${rest}）${described ? `\n\n${described}` : ''}`;
  return {
    name: meta.name,
    // 工具说明里点名对应的 REST 路径：模型照着报错 / 让人查文档时能直接对上。
    description: head.includes('对应 REST：') ? head : `${head}\n\n对应 REST：${rest}`,
    inputSchema: jsonSchema(z.object(shape)),
    route,
    pathKeys: Object.keys(params),
    queryKeys: Object.keys(query),
    body,
    module: meta.module,
    need: meta.need,
    scope: ((route as { security?: { bearer?: string[] }[] }).security?.[0]?.bearer?.[0]) ?? null,
    readOnly: meta.readOnly,
    idempotent: meta.idempotent,
    ...(meta.project === undefined ? {} : { project: meta.project })
  };
}

let cached: readonly ToolDef[] | null = null;
export function mcpTools(policy: McpPolicy = {}): ToolDef[] {
  cached ??= Object.entries(routes).flatMap(([key, route]) => {
    const meta = resolveMcp(key, route);
    return meta === null ? [] : [toolOf(key, route, meta)];
  });
  const modules = policy.modules ?? envModules();
  const readOnly = policy.readOnly ?? envForcedReadOnly();
  const writes = policy.writes ?? !readOnly;
  return cached.filter((tool) => modules.has(tool.module) && (!readOnly || tool.readOnly) && (writes || tool.readOnly));
}

/**
 * 按令牌的有效权限再筛一遍：令牌用不了的工具不进 tools/list，免得 agent 规划出调不通的步骤。
 * permissions 为 undefined（没有令牌信息，比如单测直接调）时不筛。真正的授权仍在 v1 路由里的 can()。
 */
export function mcpToolsFor(permissions: readonly Permission[] | undefined, policy: McpPolicy = {}): ToolDef[] {
  const tools = mcpTools(policy);
  if (permissions === undefined) return tools;
  const have = new Set(permissions);
  return tools.filter((tool) => have.has(tool.need));
}

/** 会话事件投影（实现在 projection.ts，routes.ts 的 events 路由也用它）。 */
export { projectEvents } from './projection.ts';

/**
 * 开放 API 的 MCP 端点：无状态 streamable HTTP，每个请求一个 SDK Server。
 * 工具调用原样转成对 v1 接口的内部请求（同一个 Authorization），所以权限、审计、校验与 HTTP 完全一致。
 */
const routeTitle = (route: RouteDef): string => (route as { summary?: string }).summary ?? '工具';

export interface McpOptions {
  /** 只是转交给内部请求：幂等在 v1 中间件里做，这里要让内部请求也拿得到同一张表。 */
  readonly replays?: McpReplayStore;
  readonly now?: () => number;
  /** 覆盖环境变量推导的策略（测试用）。 */
  readonly policy?: McpPolicy;
  /** 外部接入页的写工具开关；null / 不给 = 沿用 MCP_WRITE。 */
  readonly writes?: boolean | null;
  /** 每次 tools/call 记一条 mcp.call（target = 令牌 id），外部接入页的调用记录从这里读。 */
  readonly audit?: Pick<AuditLog, 'append'>;
}

/**
 * 写工具是否可用：默认跟随令牌权限（scope 里没有写权限就调不通），只读是显式选择。
 * 页面「只读模式」优先；老库的 mcpWrites=false 仍算只读；都没设就看环境变量。
 */
export const effectiveWrites = (
  setting: { readonly mcpReadOnly?: boolean | null; readonly mcpWrites?: boolean | null } | null | undefined
): { writes: boolean; source: 'setting' | 'env' } => {
  if (typeof setting?.mcpReadOnly === 'boolean') return { writes: !setting.mcpReadOnly, source: 'setting' };
  if (typeof setting?.mcpWrites === 'boolean') return { writes: setting.mcpWrites, source: 'setting' };
  return { writes: !envForcedReadOnly(), source: 'env' };
};

/** v1 的错误体是 {error:{code,message}}：给人读的只要 message。 */
const errorMessage = (value: unknown): string | null => {
  const message = (value as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' && message !== '' ? message : null;
};


export async function handleMcp(c: Context, v1: Hono, options: McpOptions = {}): Promise<Response> {
  const authorization = c.req.header('authorization') ?? '';
  const env = c.env as { mcpPolicy?: McpPolicy; mcpReplays?: McpReplayStore } | undefined;
  const replays = options.replays ?? env?.mcpReplays;
  const policy = options.policy ?? env?.mcpPolicy ?? { ...policyFromEnv(), writes: options.writes ?? !envForcedReadOnly() };
  const principal = c.get('principal') as Principal | undefined;
  const permissions = principal?.via?.permissions;
  const tools = mcpToolsFor(permissions, policy);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  /** 开着、但这个令牌没权限的工具：调用时明确说缺哪个权限（列表里不出现）。 */
  const withheld = new Map(mcpTools(policy).filter((tool) => !byName.has(tool.name)).map((tool) => [tool.name, tool]));
  const server = new Server({ name: 'agent-hub-openapi', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object' },
      annotations: {
        title: routeTitle(tool.route),
        readOnlyHint: tool.readOnly,
        destructiveHint: !tool.readOnly,
        idempotentHint: tool.idempotent
      }
    }))
  }));
  const callTool = async (request: { params: { name: string; arguments?: Record<string, unknown> | undefined } }) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      const locked = withheld.get(request.params.name);
      const text = locked
        ? `HTTP 403：令牌没有权限用 ${locked.name}${locked.scope ? `（需要 ${locked.scope}）` : ''}`
        : `没有这个工具：${request.params.name}`;
      return { isError: true, content: [{ type: 'text' as const, text }] };
    }
    const args = { ...((request.params.arguments ?? {}) as Record<string, unknown>) };
    // 写工具：clientRequestId 是调用方给的重试键。它不再在工具层重放，而是转成
    // Idempotency-Key 交给 v1 的共享幂等中间件——REST 调用方拿到的是同一份保证。
    let clientRequestId = '';
    if (!tool.readOnly) {
      clientRequestId = String(args['clientRequestId'] ?? '').trim();
      delete args['clientRequestId'];
      if (clientRequestId === '') {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: '写工具要带 clientRequestId（同一请求重试用同一个值，服务端 24 小时内返回同一份结果）' }]
        };
      }
    }
    const r = tool.route as { method: string; path: string };
    let path = r.path;
    for (const key of tool.pathKeys) path = path.replace(`{${key}}`, encodeURIComponent(String(args[key] ?? '')));
    const search = new URLSearchParams();
    for (const key of tool.queryKeys) if (args[key] !== undefined && args[key] !== null) search.set(key, String(args[key]));
    let payload: unknown;
    if (tool.body === 'nested') payload = args.body ?? {};
    if (tool.body === 'flat') {
      payload = Object.fromEntries(Object.entries(args).filter(([key]) => !tool.pathKeys.includes(key) && !tool.queryKeys.includes(key)));
    }
    const response = await v1.request(
      `${path}${search.size ? `?${search}` : ''}`,
      {
        method: r.method.toUpperCase(),
        headers: {
          authorization,
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(clientRequestId === '' ? {} : { 'idempotency-key': clientRequestId })
        },
        body: payload !== undefined ? JSON.stringify(payload) : undefined
      },
      { [INTERNAL]: true, ...(replays === undefined ? {} : { mcpReplays: replays }) }
    );
    const text = await response.text();
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // 不是 JSON 就原样给
    }
    if (response.ok && tool.project) value = tool.project(value);
    const structured = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { result: value };
    const result = {
      isError: !response.ok,
      content: [{ type: 'text' as const, text: response.ok ? JSON.stringify(value, null, 2) : `HTTP ${response.status}：${errorMessage(value) ?? text}` }],
      ...(response.ok ? { structuredContent: structured } : {})
    };
    return result;
  };
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = (await callTool(request)) as { isError?: boolean; content?: { text?: string }[] };
    const via = principal?.via;
    if (options.audit && via && principal) {
      // 只记工具名和结果，不记参数（参数里可能有提示词、代码）
      const outcome = result.isError ? `失败：${String(result.content?.[0]?.text ?? '').split('\n')[0]!.slice(0, 120)}` : '成功';
      await options.audit
        .append({
          id: randomUUID(),
          actorId: principal.user.id,
          actorEmail: principal.user.email,
          action: 'mcp.call',
          target: via.tokenId,
          detail: `${request.params.name} · ${outcome}`,
          at: (options.now ?? Date.now)(),
          ip: null,
          teamId: principal.user.teamId ?? null
        })
        .catch(() => undefined);
    }
    return result as never;
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    void server.close().catch(() => undefined);
  }
}
