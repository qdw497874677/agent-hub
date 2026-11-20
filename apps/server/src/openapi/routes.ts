// 开放 API v1 的路由表入口（ADR 0015）。
// 路径、参数、请求体、响应形状按能力分在 ./routes/*.ts；这里只做按原顺序汇总 + MCP 元数据解析。
// 顺序 = 注册顺序 = docs/openapi/v1.json 里 paths 的顺序，改动前先看 openapi 快照。
import type { Permission } from '@agent-hub/domain';
import { type McpModule, type McpRouteExposure, type McpRouteLike, type ResolvedMcp, V1 } from './routes/base.ts';
import { assets } from './routes/assets.ts';
import { misc } from './routes/misc.ts';
import { projects } from './routes/projects.ts';
import { providers } from './routes/providers.ts';
import { sessions, sessionsSettle, sessionsWork } from './routes/sessions.ts';
import { taskPulls, tasks } from './routes/tasks.ts';
import { tokens } from './routes/tokens.ts';
import { workers } from './routes/workers.ts';
import { workspaces, workspacesCleanup } from './routes/workspaces.ts';

export { V1 };
export type { McpModule, McpRouteExposure, McpRouteMeta, ResolvedMcp, ScopeNote } from './routes/base.ts';

const snake = (key: string) => key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

/** tags[0] → 模块（`auto` 只靠这个推，所以每个 tag 都得能映射）。 */
const MODULE_OF_TAG: Readonly<Record<string, McpModule>> = {
  projects: 'projects',
  tasks: 'tasks',
  sessions: 'sessions',
  assets: 'assets',
  workers: 'workers',
  workspaces: 'workspaces',
  providers: 'providers',
  tokens: 'tokens'
};

/** 模块的默认读权限点：`auto` 的只读路由用它（写操作必须显式写 need）。 */
const NEED_OF_TAG: Readonly<Record<McpModule, Permission>> = {
  tasks: 'task.read',
  projects: 'project.read',
  sessions: 'session.read',
  assets: 'asset.read',
  workers: 'worker.read',
  workspaces: 'project.read',
  providers: 'provider.read',
  tokens: 'token.manage'
};

/**
 * `'auto'`：GET 自动只读暴露（模块与权限点按 tags[0] 推）；其它 method 必须显式声明。
 * 返回 null = 不进 MCP（skip，或写法不合规的 auto）。
 */
export function resolveMcp(key: string, route: McpRouteLike): ResolvedMcp | null {
  const exposure = route.mcp;
  if (exposure !== 'auto' && 'skip' in exposure) return null;
  if (exposure === 'auto') {
    const module = MODULE_OF_TAG[route.tags?.[0] ?? ''];
    if (route.method !== 'get' || module === undefined) return null;
    return { key, module, need: NEED_OF_TAG[module], name: snake(key), readOnly: true, idempotent: false, destructive: false };
  }
  const readOnly = exposure.readOnly ?? route.method === 'get';
  return {
    key,
    module: exposure.module,
    need: exposure.need,
    name: exposure.expose ?? snake(key),
    readOnly,
    idempotent: exposure.idempotent === true,
    destructive: exposure.destructive ?? !readOnly,
    ...(exposure.project === undefined ? {} : { project: exposure.project })
  };
}

export const routes = {
  ...misc,
  ...workers,
  ...projects,
  ...assets,
  ...tasks,
  ...sessions,
  ...workspaces,
  ...sessionsWork,
  ...taskPulls,
  ...sessionsSettle,
  ...workspacesCleanup,
  ...providers,
  ...tokens
} as const;
/**
 * 双向可发现：REST 文档里写明这条路由对应哪个 MCP 工具（skip 的不写）。
 * 放在这里而不是 route() 里，是因为 `'auto'` 的工具名要拿到路由 key 才推得出 snake_case。
 * 只改 description 一个字段——不能整体重建对象，createRoute 的 getRoutingPath 是不可枚举的。
 */
for (const [key, entry] of Object.entries(routes) as unknown as [
  string,
  { description?: string; method: string; tags?: readonly string[]; mcp: McpRouteExposure }
][]) {
  const meta = resolveMcp(key, entry);
  if (meta !== null) entry.description = `${entry.description ?? ''}\n\nMCP 工具：\`${meta.name}\``.trim();
}
