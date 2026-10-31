import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { routes } from './routes.ts';

/** 内部转调的标记：只有这个模块拿得到，外面的请求伪造不了（放在 env 里，不是请求头）。 */
export const INTERNAL: unique symbol = Symbol('openapi-internal');

type RouteDef = (typeof routes)[keyof typeof routes];
interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly route: RouteDef;
  readonly pathKeys: readonly string[];
  readonly queryKeys: readonly string[];
  /** 'flat' = 请求体字段直接摊在参数里；'nested' = 放在 body 里；null = 没有请求体。 */
  readonly body: 'flat' | 'nested' | null;
}

/** SSE 不适合做工具（MCP 客户端用 session_events 轮询）。 */
const SKIP = new Set(['health', 'stream']);
const snake = (key: string) => key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

type Shape = Record<string, z.ZodType>;
const shapeOf = (schema: unknown): Shape | null => {
  const s = schema as { shape?: Shape } | undefined;
  return s && typeof s === 'object' && s.shape ? s.shape : null;
};
const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;

function toolOf(key: string, route: RouteDef): ToolDef {
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
  return {
    name: snake(key),
    description: `${r.summary ?? key}（${r.method.toUpperCase()} ${r.path}）${r.description ? `\n\n${r.description}` : ''}`,
    inputSchema: jsonSchema(z.object(shape)),
    route,
    pathKeys: Object.keys(params),
    queryKeys: Object.keys(query),
    body
  };
}

let cached: ToolDef[] | null = null;
export function mcpTools(): ToolDef[] {
  cached ??= Object.entries(routes)
    .filter(([key]) => !SKIP.has(key))
    .map(([key, route]) => toolOf(key, route));
  return cached;
}

/**
 * 开放 API 的 MCP 端点：无状态 streamable HTTP，每个请求一个 SDK Server。
 * 工具调用原样转成对 v1 接口的内部请求（同一个 Authorization），所以权限、审计、校验与 HTTP 完全一致。
 */
export async function handleMcp(c: Context, v1: Hono): Promise<Response> {
  const authorization = c.req.header('authorization') ?? '';
  const tools = mcpTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const server = new Server({ name: 'agent-hub-openapi', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as { type: 'object' } }))
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text' as const, text: `没有这个工具：${request.params.name}` }] };
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
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
    const structured = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { result: value };
    return {
      isError: !response.ok,
      content: [{ type: 'text' as const, text: response.ok ? JSON.stringify(value, null, 2) : `HTTP ${response.status}：${text}` }],
      ...(response.ok ? { structuredContent: structured } : {})
    };
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    void server.close().catch(() => undefined);
  }
}
