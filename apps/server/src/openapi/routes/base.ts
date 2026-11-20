// 路由构造原语：schema 无关的公共部件 + `route()`（mcp 元数据不可枚举）。
import { createRoute, z } from '@hono/zod-openapi';
import type { Permission } from '@agent-hub/domain';

export const V1 = '/openapi/v1';

export const errorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi('Error');

export const json = <T extends z.ZodType>(schema: T, description = '成功') => ({ content: { 'application/json': { schema } }, description });
export const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { 'application/json': { schema } }, required: true } });
export const errors = {
  400: json(errorSchema, '请求不合法'),
  401: json(errorSchema, '缺少或无效的令牌'),
  403: json(errorSchema, '令牌的权限范围或账号权限不够'),
  404: json(errorSchema, '不存在或看不见'),
  429: json(errorSchema, '太频繁（看 Retry-After）')
} as const;
export const okSchema = z.object({ ok: z.literal(true) });

/** 每条路由要的权限范围（文档里写清楚；真正的判断在 can()）。 */
export type ScopeNote =
  | 'projects:read'
  | 'projects:write'
  | 'sessions:read'
  | 'sessions:write'
  | 'files:read'
  | 'workers:read'
  | 'assets:submit'
  | 'assets:read'
  | 'assets:write'
  | 'assets:publish'
  | 'providers:read'
  | 'providers:use'
  | 'providers:manage'
  | 'tokens:manage'
  | null;

export type McpModule = 'tasks' | 'projects' | 'sessions' | 'assets' | 'workers' | 'workspaces' | 'providers' | 'tokens';

/**
 * 路由上的 MCP 元数据 —— 对外工具清单的**唯一来源**（mcp.ts 只读这里，不再另有一张平行表）。
 * 写在路由旁边：加一条路由就必须顺手回答「它对外是不是工具、叫什么、要什么权限」。
 */
export interface McpRouteMeta {
  readonly module: McpModule;
  /** 令牌要有这个权限点，工具才出现在 tools/list 里（mcpToolsFor 用它筛）。 */
  readonly need: Permission;
  /** false 的写操作；只读路由可省略（默认按 method 判）。 */
  readonly readOnly?: boolean;
  /** 工具名；缺省 = handle 的 snake_case。 */
  readonly expose?: string;
  readonly idempotent?: boolean;
  /** 会删除或改路由这类不可逆操作。缺省 = 非只读即视为破坏性（兼容已有写工具）。 */
  readonly destructive?: boolean;
  readonly project?: (value: unknown) => unknown;
}

/** 明确不暴露时必须写原因（parity 测试会读到）。 */
export type McpRouteExposure = McpRouteMeta | { readonly skip: string } | 'auto';




/** 解析后的元数据：mcp.ts 用这个建工具，routes.ts 用它写「MCP 工具：`x`」。 */
export interface ResolvedMcp {
  readonly key: string;
  readonly module: McpModule;
  readonly need: Permission;
  readonly name: string;
  readonly readOnly: boolean;
  readonly idempotent: boolean;
  readonly destructive: boolean;
  readonly project?: (value: unknown) => unknown;
}

export interface McpRouteLike {
  readonly method: string;
  readonly tags?: readonly string[] | undefined;
  readonly mcp: McpRouteExposure;
}


export const route = <R extends Parameters<typeof createRoute>[0]>(scope: ScopeNote, config: R, mcp: McpRouteExposure = 'auto') => {
  const made = createRoute({
    ...config,
    security: scope ? [{ bearer: [scope] }] : [],
    // MCP 工具名由文件末尾的 annotate 统一追加：'auto' 要拿到路由 key 才推得出 snake_case 名。
    description: `${config.description ?? ''}${scope ? `\n\n权限范围：\`${scope}\`` : ''}`.trim(),
    responses: { ...errors, ...config.responses }
  });
  // 不能整体 spread：createRoute 的 getRoutingPath 是不可枚举属性，spread 会丢。
  // mcp 也做成不可枚举：它是给工具清单用的内部元数据，不该混进对外规范（docs/openapi/v1.json）的 operation 里。
  return Object.defineProperty(made, 'mcp', { value: mcp, enumerable: false, writable: false, configurable: true }) as typeof made & {
    readonly mcp: McpRouteExposure;
  };
};



