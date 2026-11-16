import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { McpReplayStore } from '@agent-hub/domain';
import { routes } from './routes.ts';

/** 内部转调的标记：只有这个模块拿得到，外面的请求伪造不了（放在 env 里，不是请求头）。 */
export const INTERNAL: unique symbol = Symbol('openapi-internal');

type RouteDef = (typeof routes)[keyof typeof routes];

export type McpModuleName = 'tasks' | 'projects' | 'sessions' | 'assets';

/**
 * 对外 MCP 的白名单：先白名单、再分组、再只读闸门。
 * 新增 v1 路由默认**不**进 MCP——要在这里显式加一行，避免「加个路由就悄悄对外」。
 * 描述写在 routes.ts 的路由上（何时用 / 参数 / 返回 / 下一步），这里只管放行与投影。
 */
const ALLOWED = {
  listProjects: { module: 'projects', readOnly: true },
  getProject: { module: 'projects', readOnly: true },
  listAssets: { module: 'assets', readOnly: true },
  getAsset: { module: 'assets', readOnly: true },
  createProject: { module: 'projects', readOnly: false, expose: 'project_create', idempotent: true },
  updateProject: { module: 'projects', readOnly: false, expose: 'project_update', idempotent: true },
  deleteProject: { module: 'projects', readOnly: false, expose: 'project_archive' },
  createAsset: { module: 'assets', readOnly: false, expose: 'asset_create', idempotent: true },
  // 资产自动化（导入 → 发布 → 分配）：发布与分配要 assets:publish 范围
  importAsset: { module: 'assets', readOnly: false, expose: 'asset_import', idempotent: true },
  publishAsset: { module: 'assets', readOnly: false, expose: 'asset_publish', idempotent: true },
  assignAsset: { module: 'assets', readOnly: false, expose: 'asset_assign', idempotent: true },
  getSession: { module: 'sessions', readOnly: true },
  listTasks: { module: 'tasks', readOnly: true },
  getTask: { module: 'tasks', readOnly: true },
  listTaskLog: { module: 'tasks', readOnly: true },
  events: { module: 'sessions', readOnly: true, project: projectEvents },
  // 委派开发（E4b）：写工具默认关闭，要 MCP_WRITE=1 才出现，且必须带 clientRequestId。
  createTask: { module: 'tasks', readOnly: false, expose: 'task_create', idempotent: true },
  startSession: { module: 'sessions', readOnly: false, expose: 'session_start', idempotent: true },
  prompt: { module: 'sessions', readOnly: false, expose: 'session_reply', idempotent: true },
  interrupt: { module: 'sessions', readOnly: false, expose: 'session_cancel' }
} as const satisfies Record<
  string,
  { module: McpModuleName; readOnly: boolean; expose?: string; project?: (value: unknown) => unknown; idempotent?: boolean }
>;

export interface McpPolicy {
  /** 允许的分组；缺省 = 全部允许的分组。 */
  readonly modules?: ReadonlySet<McpModuleName>;
  /** 只暴露只读工具（并且拒绝调用写工具）。 */
  readonly readOnly?: boolean;
  /** 是否暴露写工具（默认否；`MCP_WRITE=1` 打开）。 */
  readonly writes?: boolean;
}

const ALL_MODULES: readonly McpModuleName[] = ['tasks', 'projects', 'sessions', 'assets'];

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
  readonly readOnly: boolean;
  readonly idempotent: boolean;
  readonly project?: (value: unknown) => unknown;
}

/** SSE 不适合做工具（MCP 客户端用 session_events 轮询）。 */
const SKIP = new Set(['health', 'stream']);

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

export const policyFromEnv = (): McpPolicy => ({
  modules: envModules(),
  readOnly: envFlag('MCP_READ_ONLY'),
  writes: envFlag('MCP_WRITE')
});
const snake = (key: string) => key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

type Shape = Record<string, z.ZodType>;
const shapeOf = (schema: unknown): Shape | null => {
  const s = schema as { shape?: Shape } | undefined;
  return s && typeof s === 'object' && s.shape ? s.shape : null;
};
const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;

function toolOf(key: string, route: RouteDef, allow: (typeof ALLOWED)[keyof typeof ALLOWED]): ToolDef {
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
  const allowWithName = allow as { expose?: string };
  return {
    name: (allowWithName.expose ?? snake(key)),
    description: `${r.summary ?? key}（${r.method.toUpperCase()} ${r.path}）${r.description ? `\n\n${r.description}` : ''}`,
    inputSchema: jsonSchema(z.object(shape)),
    route,
    pathKeys: Object.keys(params),
    queryKeys: Object.keys(query),
    body,
    module: allow.module,
    readOnly: allow.readOnly,
    idempotent: 'idempotent' in allow && allow.idempotent === true,
    ...('project' in allow && typeof allow.project === 'function' ? { project: allow.project } : {})
  };
}

let cached: readonly ToolDef[] | null = null;
export function mcpTools(policy: McpPolicy = {}): ToolDef[] {
  cached ??= Object.entries(routes)
    .filter(([key]) => !SKIP.has(key) && key in ALLOWED)
    .map(([key, route]) => toolOf(key, route, ALLOWED[key as keyof typeof ALLOWED]));
  const modules = policy.modules ?? envModules();
  const readOnly = policy.readOnly ?? envFlag('MCP_READ_ONLY');
  const writes = policy.writes ?? envFlag('MCP_WRITE');
  return cached.filter((tool) => modules.has(tool.module) && (!readOnly || tool.readOnly) && (writes || tool.readOnly));
}

/** 会话事件投影：工具输入/输出、思考、提示词原文都不出去（只留工具名与成败）。 */
export function projectEvents(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const out: Record<string, unknown>[] = [];
  for (const raw of value) {
    const entry = raw as { seq?: number; at?: number; turn?: number; event?: Record<string, unknown> };
    const event = entry.event ?? {};
    const kind = typeof event['kind'] === 'string' ? event['kind'] : '';
    // turn 要带上：调用方靠它把「这一句」和「这一轮的事件」对上（events?sinceTurn=）。
    const base = { seq: entry.seq ?? 0, at: entry.at ?? 0, ...(typeof entry.turn === 'number' ? { turn: entry.turn } : {}) };
    if (kind === 'text') {
      // 领域里正文是 `delta`（增量）；老数据 / 其它 codec 可能给 `text`，两个都认。
      const text = typeof event['delta'] === 'string' ? event['delta'] : typeof event['text'] === 'string' ? event['text'] : '';
      out.push({ ...base, event: { kind: 'text', text } });
    } else if (kind === 'tool_call') {
      out.push({ ...base, event: { kind: 'tool', name: String(event['name'] ?? 'tool') } });
    } else if (kind === 'tool_result') {
      out.push({ ...base, event: { kind: 'tool_result', ok: event['ok'] === true } });
    } else if (kind === 'ended') {
      out.push({ ...base, event: { kind: 'ended', outcome: String(event['outcome'] ?? 'done'), ...(typeof event['reason'] === 'string' ? { reason: event['reason'] } : {}) } });
    } else if (kind === 'diagnostic') {
      out.push({ ...base, event: { kind: 'diagnostic', level: String(event['level'] ?? 'info'), text: '诊断细节已省略' } });
    }
    // 其余（thinking / prompt / commands / approval / artifact…）一律不出。
  }
  return out;
}

/**
 * 开放 API 的 MCP 端点：无状态 streamable HTTP，每个请求一个 SDK Server。
 * 工具调用原样转成对 v1 接口的内部请求（同一个 Authorization），所以权限、审计、校验与 HTTP 完全一致。
 */
const routeTitle = (route: RouteDef): string => (route as { summary?: string }).summary ?? '工具';

export interface McpOptions {
  readonly replays?: McpReplayStore;
  readonly now?: () => number;
  /** 覆盖环境变量推导的策略（测试用）。 */
  readonly policy?: McpPolicy;
}

const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex');

export async function handleMcp(c: Context, v1: Hono, options: McpOptions = {}): Promise<Response> {
  const authorization = c.req.header('authorization') ?? '';
  const env = c.env as { mcpPolicy?: McpPolicy; mcpReplays?: McpReplayStore } | undefined;
  const replays = options.replays ?? env?.mcpReplays;
  const tools = mcpTools(options.policy ?? env?.mcpPolicy ?? policyFromEnv());
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
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
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text' as const, text: `没有这个工具：${request.params.name}` }] };
    const args = { ...((request.params.arguments ?? {}) as Record<string, unknown>) };
    // 写工具：clientRequestId 是调用方给的重试键，先取出、不转发给内部 HTTP。
    let replayKey: string | null = null;
    if (!tool.readOnly) {
      const clientRequestId = String(args['clientRequestId'] ?? '').trim();
      delete args['clientRequestId'];
      if (clientRequestId === '') {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: '写工具要带 clientRequestId（同一请求重试用同一个值，服务端 24 小时内返回同一份结果）' }]
        };
      }
      if (tool.idempotent) {
        replayKey = `${digestOf(authorization)}\u0000${tool.name}\u0000${clientRequestId}`;
        const hit = await replays?.get(replayKey).catch(() => null);
        if (hit) return JSON.parse(hit) as ReturnType<typeof Object>;
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
        headers: { authorization, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: payload !== undefined ? JSON.stringify(payload) : undefined
      },
      { [INTERNAL]: true }
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
      content: [{ type: 'text' as const, text: response.ok ? JSON.stringify(value, null, 2) : `HTTP ${response.status}：${text}` }],
      ...(response.ok ? { structuredContent: structured } : {})
    };
    if (response.ok && replayKey && replays) {
      await replays.put(replayKey, JSON.stringify(result), (options.now ?? Date.now)()).catch(() => undefined);
    }
    return result;
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    void server.close().catch(() => undefined);
  }
}
