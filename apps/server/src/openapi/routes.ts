import { createRoute, z } from '@hono/zod-openapi';
import type { Permission } from '@agent-hub/domain';
import { projectEvents } from './projection.ts';
import {
  appendLogRequest,
  assetRevisionSchema,
  assetSchema,
  changeOptionRequest,
  createProjectRequest,
  createWorkspaceRequest,
  createTaskRequest,
  deleteProjectRequest,
  deriveSessionRequest,
  editLogRequest,
  forkSessionRequest,
  journalEntrySchema,
  projectSchema,
  promptAckSchema,
  promptRequest,
  sessionSchema,
  setProjectDescriptionRequest,
  updateProjectRequest,
  removeWorkspaceRequest,
  settleSessionRequest,
  syncWorkspaceResultSchema,
  workspaceSchema,
  setProjectRepoRequest,
  setSessionModelRequest,
  setProjectReposRequest,
  setTaskStatusRequest,
  setTaskSummaryRequest,
  taskSchema,
  workerInfoSchema,
  workLogEntrySchema,
  workLogPage,
  workspaceChangesSchema
} from '@agent-hub/contract';

/**
 * 开放 API v1 的路由表（ADR 0015）：路径、参数、请求体、响应形状都在这里，
 * 规范（openapi.json）和 MCP 工具清单都从它生成。请求 / 响应 schema 直接复用 @agent-hub/contract。
 */
export const V1 = '/openapi/v1';

export const errorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi('Error');

const json = <T extends z.ZodType>(schema: T, description = '成功') => ({ content: { 'application/json': { schema } }, description });
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { 'application/json': { schema } }, required: true } });
const errors = {
  400: json(errorSchema, '请求不合法'),
  401: json(errorSchema, '缺少或无效的令牌'),
  403: json(errorSchema, '令牌的权限范围或账号权限不够'),
  404: json(errorSchema, '不存在或看不见'),
  429: json(errorSchema, '太频繁（看 Retry-After）')
} as const;
const okSchema = z.object({ ok: z.literal(true) });

// ── 会话通信 P1d（docs/design/session-communication.md §5.4 / §10.2）──
const messagePartSchema = z.record(z.string(), z.unknown()).openapi('MessagePart');
const agentMessageSchema = z
  .object({
    messageId: z.string(),
    traceId: z.string(),
    kind: z.enum(['send', 'ask', 'reply']),
    from: z.string(),
    fromLabel: z.string().nullable(),
    to: z.string(),
    targetSessionId: z.string().nullable(),
    status: z.string(),
    body: z.string(),
    replyTo: z.string().nullable(),
    failure: z.string().nullable(),
    failureDetail: z.string().nullable(),
    parts: z.array(messagePartSchema),
    replyStatus: z.string().nullable(),
    createdAt: z.number()
  })
  .passthrough()
  .openapi('AgentMessage');
const peerSchema = z
  .object({ address: z.string(), handle: z.string().optional(), label: z.string(), status: z.string(), workerId: z.string().nullable().optional(), repo: z.string().nullable().optional(), branch: z.string().nullable().optional(), title: z.string().nullable().optional(), connected: z.boolean().optional() })
  .passthrough()
  .openapi('SessionPeer');
const sessionLinkSchema = z.object({ projectId: z.string(), aSessionId: z.string(), bSessionId: z.string() }).passthrough().openapi('SessionLink');
const sendMessageRequest = z
  .object({
    kind: z.enum(['send', 'ask']),
    body: z.string().min(1).max(32768),
    parts: z.array(messagePartSchema).max(8).optional(),
    wake: z.boolean().optional(),
    timeoutSec: z.number().int().min(30).max(14400).optional()
  })
  .openapi('SendMessageRequest');
const acceptedSchema = z.object({ messageId: z.string(), traceId: z.string(), status: z.string(), targetSessionId: z.string().nullable() }).openapi('MessageAccepted');
const waitSec = z.coerce.number().int().min(0).max(50).optional();

const projectId = z.object({ projectId: z.string().openapi({ param: { name: 'projectId', in: 'path' } }) });
const taskId = z.object({ taskId: z.string().openapi({ param: { name: 'taskId', in: 'path' } }) });
const sessionId = z.object({ sessionId: z.string().openapi({ param: { name: 'sessionId', in: 'path' } }) });
const workspaceId = z.object({ workspaceId: z.string().openapi({ param: { name: 'workspaceId', in: 'path' } }) });
const groupId = z.object({ groupId: z.string().openapi({ param: { name: 'groupId', in: 'path' } }) });
const providerId = z.object({ providerId: z.string().openapi({ param: { name: 'providerId', in: 'path' } }) });
const workerIdParam = z.object({ workerId: z.string().openapi({ param: { name: 'workerId', in: 'path' } }) });

/** 每条路由要的权限范围（文档里写清楚；真正的判断在 can()）。 */
export type ScopeNote =
  | 'projects:read'
  | 'projects:write'
  | 'sessions:read'
  | 'sessions:write'
  | 'workers:read'
  | 'assets:submit'
  | 'assets:read'
  | 'assets:write'
  | 'assets:publish'
  | 'providers:read'
  | 'providers:use'
  | 'providers:manage'
  | null;

export type McpModule = 'tasks' | 'projects' | 'sessions' | 'assets' | 'workers' | 'workspaces' | 'providers';

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

const snake = (key: string) => key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

/** tags[0] → 模块（`auto` 只靠这个推，所以每个 tag 都得能映射）。 */
const MODULE_OF_TAG: Readonly<Record<string, McpModule>> = {
  projects: 'projects',
  tasks: 'tasks',
  sessions: 'sessions',
  assets: 'assets',
  workers: 'workers',
  workspaces: 'workspaces',
  providers: 'providers'
};

/** 模块的默认读权限点：`auto` 的只读路由用它（写操作必须显式写 need）。 */
const NEED_OF_TAG: Readonly<Record<McpModule, Permission>> = {
  tasks: 'task.read',
  projects: 'project.read',
  sessions: 'session.read',
  assets: 'asset.read',
  workers: 'worker.read',
  workspaces: 'project.read',
  providers: 'provider.read'
};

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

const route = <R extends Parameters<typeof createRoute>[0]>(scope: ScopeNote, config: R, mcp: McpRouteExposure = 'auto') => {
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


const memberBranch = z.object({ repoId: z.string().min(1).max(80), branch: z.string().min(1).max(200) });
const createWorkspaceGroupRequest = z.object({
  taskId: z.string().min(1).max(80),
  workerId: z.string().min(1).max(120).optional(),
  repoIds: z.array(z.string().min(1).max(80)).max(8).optional(),
  fromGroupId: z.string().min(1).max(80).optional(),
  branches: z.array(memberBranch).max(8).optional(),
  sessionId: z.string().min(1).max(80).optional()
});
const addWorkspaceGroupMemberRequest = z.object({ repoId: z.string().min(1).max(80) });
const workspaceGroupMemberSchema = z.object({
  workspaceId: z.string(),
  repoId: z.string(),
  name: z.string(),
  state: z.enum(['ready', 'preparing', 'failed']),
  error: z.string().nullable()
});
const workspaceGroupSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workerId: z.string().nullable(),
  root: z.string(),
  members: z.array(workspaceGroupMemberSchema),
  state: z.string(),
  layout: z.string().optional(),
  primaryRepoId: z.string().nullable().optional(),
  ownerTaskId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  createdAt: z.number(),
  error: z.string().nullable()
});
const sessionGitRunRequest = z.object({
  action: z.enum(['commit', 'push', 'pr']),
  message: z.string().max(8000).optional(),
  title: z.string().max(300).optional(),
  body: z.string().max(65_536).optional(),
  member: z.string().min(1).max(120).optional()
});
const pullRequestLinkSchema = z.object({
  id: z.string(),
  url: z.string(),
  number: z.number().optional(),
  title: z.string().optional(),
  state: z.string(),
  workspaceId: z.string().optional(),
  repo: z.string().nullable().optional()
}).passthrough();
const sessionGitStateSchema = z.object({
  isGit: z.boolean(),
  branch: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  hasOrigin: z.boolean(),
  repo: z.string().nullable(),
  files: z.array(z.unknown()),
  ahead: z.number(),
  upstream: z.string().nullable(),
  canPush: z.boolean(),
  prBlocked: z.string().nullable(),
  prVia: z.string(),
  pullRequests: z.array(pullRequestLinkSchema)
}).passthrough();
const sessionGitRunResultSchema = z.object({
  sha: z.string().nullable(),
  committed: z.boolean(),
  pushed: z.boolean(),
  branch: z.string().nullable(),
  pullRequest: pullRequestLinkSchema.nullable(),
  compareUrl: z.string().nullable(),
  notes: z.array(z.string())
});
const sweepItemSchema = z.object({
  runId: z.string(),
  projectId: z.string().nullable(),
  workspaceId: z.string(),
  path: z.string(),
  branch: z.string().nullable(),
  action: z.enum(['removed', 'kept', 'failed']),
  reason: z.string(),
  sizeBytes: z.number().nullable(),
  at: z.number()
});
const sweepReportSchema = z.object({
  removed: z.array(z.string()),
  kept: z.array(z.string()),
  skipped: z.array(z.string()),
  failed: z.array(z.string()).optional(),
  runId: z.string().nullable().optional(),
  items: z.array(sweepItemSchema).optional()
});
const cleanupRecordsSchema = z.object({
  items: z.array(sweepItemSchema),
  orphans: z.array(z.object({ path: z.string(), workerId: z.string().nullable() }))
});


const providerModelInput = z.union([
  z.string().min(1).max(120),
  z.object({
    id: z.string().min(1).max(120),
    name: z.string().max(80).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    extra: z.record(z.string(), z.unknown()).optional()
  })
]);
const providerProtocol = z.enum(['openai-chat', 'openai-responses', 'anthropic']);
const providerRouting = z.enum(['direct', 'hub']);
const providerInputFields = {
  slug: z.string().min(1).max(31),
  name: z.string().min(1).max(80),
  protocol: providerProtocol,
  baseUrl: z.string().min(1).max(500),
  models: z.array(providerModelInput).min(1).max(100),
  routing: providerRouting,
  enabled: z.boolean().optional()
};
const providerCreateRequest = z.object({
  ...providerInputFields,
  scope: z.enum(['personal', 'team', 'hub']).default('personal'),
  apiKey: z.string().min(1).max(4096).optional()
}).openapi('ProviderCreateRequest');
const providerUpdateRequest = z.object(providerInputFields).openapi('ProviderUpdateRequest');
const providerKeyRequest = z.object({ apiKey: z.string().min(1).max(4096) }).openapi('ProviderKeyRequest');
const providerProbeRequest = z.object({
  providerId: z.string().min(1).optional(),
  protocol: providerProtocol.optional(),
  baseUrl: z.string().min(1).max(500).optional(),
  apiKey: z.string().max(4096).optional(),
  workerId: z.string().min(1).max(120).optional()
}).openapi('ProviderProbeRequest');
const providerTestRequest = z.object({ workerId: z.string().min(1).max(120) }).openapi('ProviderTestRequest');
const providerConfirmRequest = z.object({ confirm: z.boolean().optional() }).openapi('ProviderConfirmRequest');
const providerRoutingRequest = z.object({
  routing: providerRouting.nullable(),
  confirm: z.boolean().optional()
}).openapi('ProviderRoutingRequest');
const providerUsageSchema = z.object({
  requests: z.number(),
  errors: z.number(),
  bytesIn: z.number(),
  bytesOut: z.number(),
  sessions: z.number(),
  lastUsedAt: z.number().nullable()
});
const providerViewSchema = z.object({
  id: z.string(),
  scope: z.enum(['personal', 'team', 'hub']),
  ownerId: z.string().nullable(),
  slug: z.string(),
  name: z.string(),
  protocol: providerProtocol,
  baseUrl: z.string(),
  models: z.array(z.object({ id: z.string(), name: z.string().optional(), contextWindow: z.number().optional(), maxTokens: z.number().optional(), extra: z.record(z.string(), z.unknown()).optional() })),
  routing: providerRouting,
  enabled: z.boolean(),
  hasKey: z.boolean(),
  lastCheck: z.unknown().nullable(),
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  canManage: z.boolean().optional(),
  usage: providerUsageSchema.optional()
}).passthrough().openapi('Provider');
const providerListSchema = z.object({
  providers: z.array(providerViewSchema),
  workerRouting: z.record(z.string(), providerRouting)
}).openapi('ProviderList');
const providerProbeResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().optional(),
  message: z.string(),
  via: z.string().optional(),
  models: z.array(z.unknown())
}).passthrough().openapi('ProviderProbeResult');
const providerImpactSchema = z.object({
  confirmRequired: z.boolean().optional(),
  confirmed: z.boolean().optional(),
  action: z.string(),
  message: z.string(),
  provider: z.unknown().optional(),
  models: z.array(z.string()).optional(),
  usage: z.unknown().optional(),
  workerId: z.string().optional(),
  routing: z.string().nullable().optional()
}).passthrough().openapi('ProviderImpact');

export const routes = {
  health: route(null, {
    method: 'get', path: `${V1}/health`, tags: ['meta'], summary: '健康检查',
    responses: { 200: json(z.object({ ok: z.boolean() })) }
  }, { skip: '健康检查没有可执行的动作；探活直接打 REST /openapi/v1/health' }),
  workbenchSkill: route(null, {
    method: 'get', path: `${V1}/skills/agent-hub-workbench`, tags: ['meta'], summary: '下载 agent-hub-workbench skill',
    description:
      '给外部 agent 用的工作台操作说明（Agent Skills 格式：一份 SKILL.md 加 references/）。\n' +
      '参数：format=zip（默认，附件 agent-hub-workbench.zip）或 format=json（{ name, description, files[] }）。\n' +
      '本路径无需令牌。已连接 MCP 的客户端也可以 resources/list、resources/read（uri 形如 skill://agent-hub-workbench/SKILL.md）。',
    request: { query: z.object({ format: z.enum(['zip', 'json']).optional() }) },
    responses: {
      200: {
        description: 'zip 附件或 JSON 清单',
        content: {
          'application/zip': { schema: z.string() },
          'application/json': { schema: z.object({
            name: z.string(),
            description: z.string(),
            files: z.array(z.object({ path: z.string(), content: z.string() }))
          }) }
        }
      }
    }
  }, { skip: '给外部 agent 下载的文件，不是可执行工具；用 MCP resources/read 或本 GET' }),
  me: route(null, {
    method: 'get', path: `${V1}/me`, tags: ['meta'], summary: '当前令牌是谁',
    description: '返回令牌所属的账号与令牌的权限范围。任何有效令牌都能调。',
    responses: { 200: json(z.object({ user: z.object({ id: z.string(), name: z.string(), service: z.boolean() }), token: z.object({ id: z.string(), name: z.string(), kind: z.enum(['personal', 'service']) }) })) }
  }, { skip: '令牌自己的身份在 /me 里；工具清单不需要一个「查我自己」的工具' }),
  listWorkers: route('workers:read', {
    method: 'get', path: `${V1}/workers`, tags: ['workers'], summary: '能用的机器',
    responses: { 200: json(z.array(workerInfoSchema)) }
  }, { module: 'workers', need: 'worker.read', expose: 'list_workers' }),

  listProjects: route('projects:read', {
    method: 'get', path: `${V1}/projects`, tags: ['projects'], summary: '我可见的项目',
    description:
      '列出令牌账号能看见的项目（不含回收站）。\n' +
      '参数：无。\n' +
      '返回：项目数组（id、name、description、repo/repos、previewPort…）。\n' +
      '下一步：用 list_tasks 传 projectId 看任务；用 get_session 看某条会话。\n' +
      '错误：401 令牌无效。',
    responses: { 200: json(z.array(projectSchema)) }
  }),
  createProject: route('projects:write', {
    method: 'post', path: `${V1}/projects`, tags: ['projects'], summary: '新建项目',
    description:
      '新建一个项目（代码与任务的边界）。\n' +
      '参数：name（1–60）、rootPath（这台 hub 上已存在的目录）。\n' +
      '返回：项目对象（id、name、rootPath）。记下 id。\n' +
      '下一步：用 task_create 在项目里建任务，再 session_start 派一台机器。\n' +
      '错误：401 令牌无效；403 无 projects:write；409 同名或目录不合法。',
    request: body(createProjectRequest),
    responses: { 201: json(projectSchema, '已创建') }
  }, { module: 'projects', need: 'project.create', readOnly: false, expose: 'project_create', idempotent: true }),
  getProject: route('projects:read', {
    method: 'get', path: `${V1}/projects/{projectId}`, tags: ['projects'], summary: '看一个项目',
    description:
      '按 id 看项目详情。\n' +
      '参数：projectId（路径）。\n' +
      '返回：项目对象（description、repo/repos、checks、previewPort…）。\n' +
      '下一步：用 list_tasks 看任务，或用 project_update 改说明/检查命令。\n' +
      '错误：401 令牌无效；404 项目不存在或你看不见。',
    request: { params: projectId },
    responses: { 200: json(projectSchema) }
  }),
  updateProject: route('projects:write', {
    method: 'patch', path: `${V1}/projects/{projectId}`, tags: ['projects'], summary: '改项目说明或检查命令',
    description:
      '改项目的说明（description）和/或检查命令（checks，最多 5 条、每条 ≤300 字、不能换行；空数组=清掉）。\n' +
      '参数：projectId（路径）；body 至少给 description 或 checks 之一。\n' +
      '返回：更新后的项目对象。\n' +
      '下一步：用 get_project 复核；检查命令由 agent 的 run_checks 执行。\n' +
      '错误：400 参数不合法（含换行、超长）；403 无 projects:write 或不是项目管理员；404 项目不存在。',
    request: { params: projectId, ...body(updateProjectRequest) },
    responses: { 200: json(projectSchema) }
  }, { module: 'projects', need: 'project.update', readOnly: false, expose: 'project_update', idempotent: true }),
  setProjectRepos: route('projects:write', {
    method: 'put', path: `${V1}/projects/{projectId}/repos`, tags: ['projects'], summary: '设置项目仓库清单（可带私有仓库令牌）',
    description:
      '整体替换项目的仓库清单（最多 8 个）：空数组 = 解除全部绑定。\n' +
      '参数：projectId（路径）；repos[].url、name（可选，小写字母数字与连字符）、defaultBranch（可选，null=远端默认）；primaryRepoId（可选，指定组合会话的主仓库；不指定则不能开组合会话）。\n' +
      'credential：私有 HTTPS 仓库的令牌，只写不读——非空存进密钥箱、空串清掉、省略不动；响应里只有 hasToken，永远不回显。\n' +
      '返回：更新后的项目对象（repos[].hasToken 表明有没有令牌）。\n' +
      '下一步：用 get_project 复核；之后新建的会话/工作空间克隆与推送都会自动用这个令牌。\n' +
      '错误：400 仓库超过 8 个或字段不合法；403 无 projects:write 或不是项目管理员；404 项目不存在。',
    request: { params: projectId, ...body(setProjectReposRequest) },
    responses: { 200: json(projectSchema), ...errors }
  }, { module: 'projects', need: 'project.update', readOnly: false, expose: 'project_repos', idempotent: true }),
  setProjectRepo: route('projects:write', {
    method: 'put', path: `${V1}/projects/{projectId}/repo`, tags: ['projects'], summary: '绑定 / 解除项目仓库',
    request: { params: projectId, ...body(setProjectRepoRequest) },
    responses: { 200: json(projectSchema) }
  }, { skip: '单个仓库绑定是网页的老路径；对外用 project_repos 整体替换清单' }),
  setProjectDescription: route('projects:write', {
    method: 'put', path: `${V1}/projects/{projectId}/description`, tags: ['projects'], summary: '改项目说明',
    request: { params: projectId, ...body(setProjectDescriptionRequest) },
    responses: { 200: json(projectSchema) }
  }, { skip: '改说明用 project_update（PATCH /projects/{projectId}）；这条是网页专用' }),
  deleteProject: route('projects:write', {
    method: 'delete', path: `${V1}/projects/{projectId}`, tags: ['projects'], summary: '把项目放进回收站',
    description:
      '把项目放进回收站（磁盘目录保留，可恢复）。\n' +
      '参数：projectId（路径）、confirmName（必须等于项目名，防误删）。\n' +
      '返回：{ id, deleted: true }。\n' +
      '下一步：任务与会话不再出现在列表里；恢复要回工作台。\n' +
      '错误：400 名字对不上；403 不是团队主人或建项目的人；404 项目不存在。',
    request: { params: projectId, ...body(deleteProjectRequest) },
    responses: { 200: json(z.object({ id: z.string(), deleted: z.literal(true) })) }
  }, { module: 'projects', need: 'project.delete', readOnly: false, expose: 'project_archive' }),
  workspaceChanges: route('projects:read', {
    method: 'get', path: `${V1}/workspaces/{workspaceId}/changes`, tags: ['projects'], summary: '工作空间里未提交的改动',
    request: { params: z.object({ workspaceId: z.string().openapi({ param: { name: 'workspaceId', in: 'path' } }) }) },
    responses: { 200: json(workspaceChangesSchema) }
  }),

  listAssets: route('assets:read', {
    method: 'get', path: `${V1}/assets`, tags: ['assets'], summary: '我能用的资产',
    description:
      '列出令牌账号能看见的资产（全局、团队、可见项目、自己的个人资产）。\n' +
      '参数：kind（可选，skill / instruction / mcp）。\n' +
      '返回：资产数组（id、kind、name、scope、pinned/latest digest、描述）。\n' +
      '下一步：用 get_asset 看某个资产的版本；会话要用它就先给会话配资产集。\n' +
      '错误：401 令牌无效；403 无 assets:read。',
    request: { query: z.object({ kind: z.enum(['skill', 'instruction', 'mcp']).optional() }) },
    responses: { 200: json(z.array(assetSchema)) }
  }),
  getAsset: route('assets:read', {
    method: 'get', path: `${V1}/assets/{assetId}`, tags: ['assets'], summary: '看一个资产与它的版本',
    description:
      '按 id 看资产详情与版本列表（不含文件内容）。\n' +
      '参数：assetId（路径）。\n' +
      '返回：{ asset, revisions: [{ digest, commit, createdAt }] }。\n' +
      '下一步：要用某个版本就把 digest 记下来（会话资产集按 digest 钉）。\n' +
      '错误：401 令牌无效；404 资产不存在或你看不见。',
    request: { params: z.object({ assetId: z.string().openapi({ param: { name: 'assetId', in: 'path' } }) }) },
    responses: { 200: json(z.object({ asset: assetSchema, revisions: z.array(assetRevisionSchema) })) }
  }),
  createAsset: route('assets:write', {
    method: 'post', path: `${V1}/assets`, tags: ['assets'], summary: '新建资产（默认进审核）',
    description:
      '上传一个新资产（skill / instruction / mcp）。**默认只进审核队列**，审核通过后才可用于会话。\n' +
      '参数：kind、name（可选，不给自己推）、scope（personal/team/project）、projectId（scope=project 时必填）、publish（默认 false；true = 直接发布，要 assets:publish）、files（[{path, data(base64)}]，≤200 个、单文件 ≤1MB）。\n' +
      '返回：资产对象（pinned 为空表示还没发布）。\n' +
      '下一步：publish=false 时等审核；publish=true 时接着用 asset_assign 装到机器。用 get_asset 复核 pinned digest。\n' +
      '错误：400 文件不合法或超限；403 无 assets:write，或 publish=true 但没有 assets:publish；409 同范围同名已存在。',
    request: body(
      z.object({
        kind: z.enum(['skill', 'instruction', 'mcp']),
        name: z.string().max(64).nullable().optional(),
        scope: z.enum(['personal', 'team', 'project']).default('personal'),
        projectId: z.string().nullable().optional(),
        publish: z.boolean().default(false),
        files: z.array(z.object({ path: z.string().min(1).max(512), data: z.string() })).min(1).max(200)
      })
    ),
    responses: { 201: json(assetSchema, '已创建') }
  }, { module: 'assets', need: 'asset.submit', readOnly: false, expose: 'asset_create', idempotent: true }),
  importAsset: route('assets:write', {
    method: 'post', path: `${V1}/assets/import`, tags: ['assets'], summary: '从 Git 仓库导入资产（可选直接发布）',
    description:
      '从一个 Git 仓库导入 skill / instruction / mcp 资产。默认只建版本、进审核队列；publish=true 时直接发布（要 assets:publish）。\n' +
      '参数：kind、url（https 或 git 地址，可直接粘 GitHub 文件 / 目录网址）、ref（可选，分支 / 标签）、path（技能目录如 skills/foo，或指令 / mcp 文件如 AGENTS.md）、name（可选，不给自己推）、scope（personal/team/project）、projectId（scope=project 时必填）、publish（默认 false）。\n' +
      'policy：locked（默认，钉在导入时的提交上）或 track（跟随分支，可用 asset_check 看新提交）。\n' +
      'credential：私有仓库令牌，只用于这次拉取；policy=track 时服务端存进密钥箱供以后检查更新，永不回显。\n' +
      '返回：资产对象（pinned 为空表示还没发布；latest 是刚导入版本的 digest）。\n' +
      '下一步：publish=true 时已可直接用，用 asset_assign 装到机器；否则用 asset_publish 发布（要 assets:publish）或等审核。\n' +
      '错误：400 仓库读不出来、路径不存在或文件超限；403 无 assets:write，或 publish=true 但没有 assets:publish；409 同范围同名已存在。\n' +
      '重试：MCP 调用要给 clientRequestId，同一值重试返回同一份结果。',
    request: body(
      z.object({
        kind: z.enum(['skill', 'instruction', 'mcp']),
        url: z.string().min(1).max(512),
        ref: z.string().max(200).nullable().optional(),
        path: z.string().max(512).optional(),
        name: z.string().max(64).nullable().optional(),
        scope: z.enum(['personal', 'team', 'project']).default('personal'),
        projectId: z.string().nullable().optional(),
        publish: z.boolean().default(false),
        policy: z.enum(['track', 'locked']).optional(),
        credential: z.string().min(1).max(512).optional()
      })
    ),
    responses: { 201: json(assetSchema, '已导入') }
  }, { module: 'assets', need: 'asset.submit', readOnly: false, expose: 'asset_import', idempotent: true }),
  publishAsset: route('assets:publish', {
    method: 'post', path: `${V1}/assets/{assetId}/publish`, tags: ['assets'], summary: '发布资产的最新版本',
    description:
      '把资产的最新版本（latest）钉成线上版本（pinned），会话随即用上新版本。自动化路径，审计留痕。\n' +
      '参数：assetId（路径）。\n' +
      '返回：发布后的资产对象（pinned === latest）。\n' +
      '下一步：用 asset_assign 把它装到会话要用的机器上；用 get_asset 复核 pinned。\n' +
      '错误：403 无 assets:publish，或全局资产但不是集群管理员；404 资产不存在或看不见；409 latest 为空或已经发布（没有待发布的新版本）。',
    request: { params: z.object({ assetId: z.string().openapi({ param: { name: 'assetId', in: 'path' } }) }) },
    responses: { 200: json(assetSchema) }
  }, { module: 'assets', need: 'asset.review', readOnly: false, expose: 'asset_publish', idempotent: true }),
  assignAsset: route('assets:publish', {
    method: 'post', path: `${V1}/assets/{assetId}/workers`, tags: ['assets'], summary: '把资产装到机器上（或卸下）',
    description:
      '分配 / 取消分配：把资产装到某台机器（installed=true，默认）或从机器上卸下（false）。装好后这台机器上开的会话，资产集（resolveSessionAssets）就会带上它。\n' +
      '参数：assetId（路径）；workerId（机器 id，先 list_workers 看有哪些）；installed（默认 true）。\n' +
      '返回：{ assetId, workerId, installed }。\n' +
      '下一步：用 session_start 在这台机器上开会话，资产自动带上；用 get_asset 看钉住的 pinned 版本。\n' +
      '错误：403 无 assets:publish；404 资产或机器不存在 / 看不见。',
    request: {
      params: z.object({ assetId: z.string().openapi({ param: { name: 'assetId', in: 'path' } }) }),
      ...body(z.object({ workerId: z.string().min(1), installed: z.boolean().default(true) }))
    },
    responses: { 200: json(z.object({ assetId: z.string(), workerId: z.string(), installed: z.boolean() })) }
  }, { module: 'assets', need: 'asset.assign', readOnly: false, expose: 'asset_assign', idempotent: true }),
  submitAssetRevision: route('assets:submit', {
    method: 'post', path: `${V1}/assets/{assetId}/revisions`, tags: ['assets'], summary: '给资产交一个新版本（进审核）',
    description: '只有作者（或团队负责人）能交；新版本进待审队列，审核通过才上线。令牌默认不能审核、发布、装机或下架（除非显式给了 assets:publish）。文件内容 base64。',
    request: {
      params: z.object({ assetId: z.string().openapi({ param: { name: 'assetId', in: 'path' } }) }),
      ...body(z.object({ files: z.array(z.object({ path: z.string().min(1).max(512), data: z.string() })).min(1).max(200) }))
    },
    responses: {
      200: json(z.object({ assetId: z.string(), latest: z.string(), submissionId: z.string().nullable(), status: z.string().nullable() }))
    }
  }, { skip: '交新版本进审核队列是网页 / 审核流程的路径；对外用 asset_create 或 asset_import' }),

  listTasks: route('projects:read', {
    method: 'get', path: `${V1}/tasks`, tags: ['tasks'], summary: '项目下的任务',
    description:
      '列出某个项目里的任务。\n' +
      '参数：projectId（必填）；没有分页，按更新时间倒序。\n' +
      '返回：任务数组（id、title、status、branch、updatedAt…）。\n' +
      '下一步：用 get_task 取详情与会话列表，list_task_log 看进展。\n' +
      '错误：401 令牌无效；403 无 projects:read；404 项目不存在或看不见。',
    request: { query: z.object({ projectId: z.string().min(1) }) },
    responses: { 200: json(z.array(taskSchema)) }
  }),
  createTask: route('projects:write', {
    method: 'post', path: `${V1}/tasks`, tags: ['tasks'], summary: '新建任务',
    description:
      '在项目下建一条任务（工作单元）。不会自动开会话。\n' +
      '参数：projectId、title（≤200）、goal（可选，≤2000）。\n' +
      '返回：任务对象（id、status=todo、projectId）。记下 id。\n' +
      '下一步：用 session_start 给这条任务派一台机器上的会话，再用 session_reply 说话。\n' +
      '错误：401 令牌无效；403 无 projects:write；404 项目不存在或看不见。\n' +
      '重试：MCP 调用要给 clientRequestId，同一值重试返回同一任务。',
    request: body(createTaskRequest),
    responses: { 201: json(taskSchema, '已创建') }
  }, { module: 'tasks', need: 'task.create', readOnly: false, expose: 'task_create', idempotent: true }),
  getTask: route('projects:read', {
    method: 'get', path: `${V1}/tasks/{taskId}`, tags: ['tasks'], summary: '任务详情（带会话列表）',
    description:
      '取一条任务的详情和它下面的会话。\n' +
      '参数：taskId。\n' +
      '返回：任务对象 + sessions[]（id、status、model、updatedAt）。\n' +
      '下一步：用 events 传入会话 id 读这条会话说了什么。\n' +
      '错误：404 任务不存在、或属于看不见的项目（响应里不会有标题或目标）。',
    request: { params: taskId },
    responses: { 200: json(taskSchema.extend({ sessions: z.array(sessionSchema) })) }
  }),
  setTaskStatus: route('projects:write', {
    method: 'patch', path: `${V1}/tasks/{taskId}/status`, tags: ['tasks'], summary: '改任务状态',
    request: { params: taskId, ...body(setTaskStatusRequest) },
    responses: { 200: json(taskSchema) }
  }, { module: 'tasks', need: 'task.create', readOnly: false, expose: 'set_task_status', idempotent: true }),
  setTaskSummary: route('projects:write', {
    method: 'patch', path: `${V1}/tasks/{taskId}/summary`, tags: ['tasks'], summary: '改任务摘要',
    request: { params: taskId, ...body(setTaskSummaryRequest) },
    responses: { 200: json(taskSchema) }
  }, { module: 'tasks', need: 'task.create', readOnly: false, expose: 'set_task_summary', idempotent: true }),
  listTaskLog: route('projects:read', {
    method: 'get', path: `${V1}/tasks/{taskId}/log`, tags: ['tasks'], summary: '工作日志（倒序分页）',
    description:
      '任务进展的规范流：开始、阶段里程碑、结束都在这里，可按 seq 重放。\n' +
      '参数：taskId；limit（1-200，默认 50）；beforeSeq（翻页游标）。\n' +
      '返回：{ entries[], nextBeforeSeq }。\n' +
      '下一步：要原始会话事件用 events；要交付物看任务详情里的分支与 PR。\n' +
      '错误：404 任务不存在或看不见。',
    request: { params: taskId, query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), beforeSeq: z.coerce.number().int().optional() }) },
    responses: { 200: json(workLogPage) }
  }),
  appendTaskLog: route('projects:write', {
    method: 'post', path: `${V1}/tasks/{taskId}/log`, tags: ['tasks'], summary: '写一条工作日志',
    request: { params: taskId, ...body(appendLogRequest) },
    responses: { 201: json(workLogEntrySchema, '已写入') }
  }, { module: 'tasks', need: 'task.create', readOnly: false, expose: 'append_task_log', idempotent: true }),
  editTaskLog: route('projects:write', {
    method: 'patch', path: `${V1}/tasks/{taskId}/log/{entryId}`, tags: ['tasks'], summary: '改自己写的日志',
    request: { params: taskId.extend({ entryId: z.string().openapi({ param: { name: 'entryId', in: 'path' } }) }), ...body(editLogRequest) },
    responses: { 200: json(workLogEntrySchema) }
  }, { module: 'tasks', need: 'task.create', readOnly: false, expose: 'edit_task_log', idempotent: true }),

  startSession: route('sessions:write', {
    method: 'post', path: `${V1}/sessions`, tags: ['sessions'], summary: '在任务下开一条会话',
    description:
      '在任务下开一条会话，派到指定机器（workerId）上跑。本机（hub 同机）的机器开放 API 永远用不了，必须给一台已登记的远程 Worker。\n' +
      '参数：taskId、agentId、model（空串=运行时默认）、workerId（建议显式给在线机器）、workspaceId（可选）、groupId（可选：已有的组合工作空间；多仓项目要先在 Hub 建组，本工具不会自动建组合组）、assetIds（可选：只带这些资产）。\n' +
      '会话通信：repoId（可选：一仓一会话——只为项目里这个仓库新开隔离 worktree，和 workspaceId / groupId 互斥）、handle（可选：任务内短名，别的会话用 peer:<handle> 找它）、linkWith（可选：建好后和这些同项目会话连线，连上才能互发消息）。\n' +
      '资产：不传 assetIds = 用项目生效的全部资产；要排除某个技能/指令时，传完整清单减掉它（清单里的 id 必须对该项目可见，看不见的会被丢掉）。\n' +
      '返回：会话对象（id、status、model、workspaceId）。\n' +
      '下一步：用 session_reply 发第一句；用 events 或 list_task_log 跟进展。\n' +
      '错误：400 参数不合法（含 handle 格式、repoId 不在项目里）；403 无 sessions:write 或不能和 linkWith 里的会话说话；404 linkWith 的会话不在同一项目；409 机器不可用、没装该 runtime、短名已被占用或 linkWith 的会话已收起（archived）。\n' +
      '重试：MCP 调用要给 clientRequestId，同一值重试不会开第二条会话。',
    request: body(deriveSessionRequest),
    responses: { 201: json(sessionSchema, '已开始') }
  }, { module: 'sessions', need: 'session.create', readOnly: false, expose: 'session_start', idempotent: true }),
  forkSession: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/fork`, tags: ['sessions'], summary: '从某条消息分叉',
    request: body(forkSessionRequest),
    responses: { 201: json(sessionSchema, '已分叉') }
  }, { module: 'sessions', need: 'session.create', readOnly: false, expose: 'fork_session', idempotent: true }),
  getSession: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}`, tags: ['sessions'], summary: '会话详情',
    description:
      '取一条会话的状态与配置。**status 只描述最近一轮**：running = 这一轮在跑；done/stopped/interrupted/failed = 这一轮的结果。\n' +
      '参数：sessionId。\n' +
      '返回：会话对象（status、turn、lastSeq、model、workspaceId、taskId…；taskId 可能为 null，表示常驻容器会话）。\n' +
      '轮询用法：记下 turn；调 events(sessionId, sinceTurn=turn) 或 events(sessionId, after=lastSeq)；未到终态就 3–5 秒后再看；看到本 turn 的 ended 事件即这一轮结束。\n' +
      '下一步：用 events 读它的时间线；要发下一句用 session_reply。\n' +
      '长轮询：waitSec（0–50）= 这一轮还在跑时最多等这么久再返回（不取消这一轮；到点仍在跑就原样返回 running）。\n' +
      '错误：404 会话不存在或属于看不见的项目。',
    request: { params: sessionId, query: z.object({ waitSec }) },
    responses: { 200: json(sessionSchema) }
  }),
  setSessionModel: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/model`, tags: ['sessions'], summary: '换这条会话的模型（可换提供商）',
    description:
      '把会话切到另一个模型；目标模型在另一个提供商下时，服务端会停掉旧进程、按新配置重启，并用 resume 接回历史。\n' +
      '参数：sessionId（路径）、model（模型 id；hub 提供商的模型写成 hub-<标识>/<模型>，用 list_models 看有哪些）。\n' +
      '返回：更新后的会话对象。\n' +
      '副作用：正在跑的回合会中断；历史保留。\n' +
      '错误：400 模型不在可选清单里；403 没有 session.prompt 权限或那个提供商用不了；404 会话不存在；409 会话已结束或无法重启。',
    request: { params: sessionId, ...body(setSessionModelRequest) },
    responses: { 200: json(sessionSchema), ...errors }
  }, { module: 'sessions', need: 'session.prompt', readOnly: false, expose: 'session_model', idempotent: true }),
  prompt: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/prompt`, tags: ['sessions'], summary: '对会话说话',
    description:
      '给会话发一条消息，立即返回（202）；回合在后台跑。\n' +
      '参数：text、clientMessageId（建议总是带；同一条消息重试用同一个值，服务端按它去重）。\n' +
      '返回：{ ok, turn, seq, deliveryId, state }——turn 是这句开启的轮次。\n' +
      '轮询用法：拿返回的 turn，反复调 events(sessionId, sinceTurn=turn)；读到的每条事件都带同一个 turn；看到 ended 就是这一轮结束（事件里 outcome 区分 done/stopped/interrupted/failed）。\n' +
      '下一步：轮询 events 或 list_task_log 看进展与结论；要打断用 session_cancel。\n' +
      '错误：404 会话不存在或看不见；409 会话不在运行（先 session_start）；429 太频繁。',
    request: { params: sessionId, ...body(promptRequest) },
    responses: { 202: json(promptAckSchema, '已接收（回合在后台跑）') }
  }, { module: 'sessions', need: 'session.prompt', readOnly: false, expose: 'session_reply', idempotent: true }),
  interrupt: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/interrupt`, tags: ['sessions'], summary: '打断正在跑的会话',
    description:
      '打断当前回合（相当于人点「停止」），会话本身保留，之后还能继续发消息。\n' +
      '参数：sessionId。\n' +
      '返回：{ ok: true }。\n' +
      '下一步：要放弃任务用任务状态接口；要重跑直接 session_reply。\n' +
      '错误：404 会话不存在或看不见。',
    request: { params: sessionId },
    responses: { 200: json(okSchema) }
  }, { module: 'sessions', need: 'session.interrupt', readOnly: false, expose: 'session_cancel' }),
  changeOption: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/options`, tags: ['sessions'], summary: '改可调项（模型、思考强度…）',
    request: { params: sessionId, ...body(changeOptionRequest) },
    responses: { 200: json(sessionSchema) }
  }, { module: 'sessions', need: 'session.prompt', readOnly: false, expose: 'change_option', idempotent: true }),
  events: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/events`, tags: ['sessions'], summary: '会话事件（after 之后的）',
    description:
      '读会话时间线（对外已投影）：只有文本、工具名与成败、结束原因、诊断占位。\n' +
      '参数：sessionId；after（只取 seq > after 的事件）；sinceTurn（只取第几轮及之后的事件，配合 session_reply 返回的 turn 用）；waitSec（0–50，没有新事件时最多等这么久，有新事件立刻返回）。\n' +
      '返回：[{ seq, at, turn, event }]，event.kind ∈ text | tool | tool_result | ended | diagnostic。\n' +
      '轮询用法：第一次 sinceTurn=turn；之后用 after=最后一条 seq 增量拉；本 turn 出现 ended 即结束；没结束时 3–5 秒后再拉（running 时密一点，卡住时退到 10 秒）。\n' +
      '下一步：把 after 设为最后一条 seq 继续轮；工具细节与思考过程不对开放 API 暴露。\n' +
      '错误：404 会话不存在或看不见。',
    request: {
      params: sessionId,
      query: z.object({
        after: z.coerce.number().int().min(0).optional(),
        sinceTurn: z.coerce.number().int().min(0).optional(),
        waitSec
      })
    },
    responses: { 200: json(z.array(journalEntrySchema)) }
  }, { module: 'sessions', need: 'session.read', expose: 'events', project: projectEvents }),
  linkSession: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/links`, tags: ['sessions'], summary: '把两条会话连起来（能互发消息、只读看对方工作空间）',
    description:
      '连两条同项目的会话（无向、幂等）。连上后两边的 agent 能用 agent.ask / agent.send 互发消息（to 写 peer:<短名>），能用 workspace.read 的 session 参数只读看对方文件。\n' +
      '参数：sessionId；body `{ otherSessionId }`。两条会话你都要能 session.prompt。\n' +
      '返回：连线对象。\n' +
      '下一步：session_peers 看短名；session_message 给其中一条派活。\n' +
      '错误：400 连自己；404 不在同一个项目；409 两边机器都不在线。',
    request: { params: sessionId, ...body(z.object({ otherSessionId: z.string().min(1) })) },
    responses: { 201: json(sessionLinkSchema, '已连上') }
  }, { module: 'sessions', need: 'session.prompt', readOnly: false, expose: 'session_link', idempotent: true }),
  unlinkSession: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/unlink`, tags: ['sessions'], summary: '断开两条会话',
    description:
      '断开连线（重复断开也成功）。断开后双方不能再互发消息（派生父子关系不受影响），已发的消息和审计保留。\n' +
      '参数：sessionId；body `{ otherSessionId }`。\n' +
      '返回：{ ok: true }。\n' +
      '错误：400 断自己；403 / 404。',
    request: { params: sessionId, ...body(z.object({ otherSessionId: z.string().min(1) })) },
    responses: { 200: json(okSchema) }
  }, { module: 'sessions', need: 'session.prompt', readOnly: false, expose: 'session_unlink' }),
  sessionPeers: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/peers`, tags: ['sessions'], summary: '会话的同伴',
    description:
      '这条会话能直接说话的同伴（显式连线 + 派生父会话）：短名 handle（用 peer:<handle> 寻址）、session id、机器 workerId、仓库、分支、标题、状态（idle / busy / archived）。\n' +
      '参数：sessionId。\n' +
      '返回：{ peers: [...] }。\n' +
      '下一步：session_link 增加同伴；session_message 给某条会话发消息。',
    request: { params: sessionId },
    responses: { 200: json(z.object({ peers: z.array(peerSchema) })) }
  }, { module: 'sessions', need: 'session.read', expose: 'session_peers' }),
  sessionMessage: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/messages`, tags: ['sessions'], summary: '以外部 agent 身份给会话发消息（send / ask）',
    description:
      '经消息总线给会话发一条 agent 消息，署名「外部 · <令牌名>」，包在不可信边界里；ask 的回复进你的外部收件箱（不唤醒任何会话）。\n' +
      '和 session_reply 的区别：session_reply 是以令牌主人身份对会话下指令（普通一轮）；session_message 是 agent 消息，受限额和防风暴约束，回复能按 messageId 关联。\n' +
      '参数：sessionId；body `{ kind: send|ask, body, parts?, wake?, timeoutSec? }`。parts 是结构化附件（data / ref / file / link，≤8 个，≤16KB）；wake=false 只进对方收件箱（只有 send）；timeoutSec 30–14400（只有 ask，默认 1800）。\n' +
      '返回：{ messageId, traceId, status, targetSessionId }；status = delivered（对方空闲，已开新一轮）/ queued（对方忙，排队）/ done（wake=false）。\n' +
      '下一步：ask 用 message_get(messageId, waitSec≤50) 等回复，或 message_inbox 增量取；回复的 replyStatus 是 ok / failed / refused。\n' +
      '错误：400 参数不合法；403 没有 session.prompt 或 duplicate（10 分钟内重复）；409 archived（会话已收起）/ rate_limited（同一会话每分钟最多 6 条）；404 会话不存在。\n' +
      '重试：给 clientRequestId，同一值重试不会发第二条。',
    request: { params: sessionId, ...body(sendMessageRequest) },
    responses: { 201: json(acceptedSchema, '已接收') }
  }, { module: 'sessions', need: 'session.prompt', readOnly: false, expose: 'session_message', idempotent: true }),
  getMessage: route('sessions:read', {
    method: 'get', path: `${V1}/messages/{messageId}`, tags: ['sessions'], summary: '外部发的一条消息与它的回复',
    description:
      '查你（这个令牌）发出的一条消息的状态和回复。waitSec（0–50）：还没有回复时最多等这么久（长轮询，到点没回复就照常返回）。\n' +
      '参数：messageId；waitSec。\n' +
      '返回：{ message, reply }；reply 为 null 表示还没回；reply.replyStatus = ok / failed / refused，reply.failure 有值表示超时（timeout）/ 对方已收起（archived）等。\n' +
      '下一步：没回复就再调一次（带 waitSec）；多条在等时用 message_inbox。\n' +
      '错误：404 不是这个令牌发的或不存在。',
    request: { params: z.object({ messageId: z.string().openapi({ param: { name: 'messageId', in: 'path' } }) }), query: z.object({ waitSec }) },
    responses: { 200: json(z.object({ message: agentMessageSchema, reply: agentMessageSchema.nullable() })) }
  }, { module: 'sessions', need: 'session.read', expose: 'message_get' }),
  messageInbox: route('sessions:read', {
    method: 'get', path: `${V1}/inbox`, tags: ['sessions'], summary: '外部收件箱（回复）',
    description:
      '这个令牌收到的回复（含失败通知），按时间正序。收件箱绑令牌：吊销令牌后就打不开了。\n' +
      '参数：after（上一页最后一条的 createdAt，默认 0）；limit（1–100，默认 50）。\n' +
      '返回：{ messages: [...], next }；next = 最后一条的 createdAt，下一次作为 after 传回。\n' +
      '下一步：按 replyTo 关联到你发的 ask。',
    request: { query: z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }) },
    responses: { 200: json(z.object({ messages: z.array(agentMessageSchema), next: z.number() })) }
  }, { module: 'sessions', need: 'session.read', expose: 'message_inbox' }),
  stream: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/stream`, tags: ['sessions'], summary: '会话事件流（SSE）',
    description:
      '先补发 `after`（或 `Last-Event-ID`）之后的事件，再实时推。\n\n' +
      '- `event: event`，`id` = 事件序号，`data` = `{ seq, event, at, turn }`（同 /events 的一项）\n' +
      '- `event: status`，`data` = `{ status }`：只有状态变了\n' +
      '- 每 15 秒一条 `: ping` 注释保活。每个令牌最多同时开 5 条。',
    request: { params: sessionId, query: z.object({ after: z.coerce.number().int().min(0).optional() }) },
    responses: { 200: { content: { 'text/event-stream': { schema: z.string() } }, description: 'SSE 流' } }
  }, { skip: 'SSE 不适合做工具调用；长任务用 session_events 轮询或 REST /stream' }),
  activity: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/activity`, tags: ['sessions'], summary: '谁对这条会话做了什么',
    request: { params: sessionId },
    responses: { 200: json(z.array(z.object({ action: z.string(), actor: z.object({ id: z.string(), name: z.string() }), detail: z.string(), at: z.number() }))) }
  }),
  syncWorkspace: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/workspaces/{workspaceId}/sync`, tags: ['workspaces'], summary: '把项目仓库同步到这个工作空间',
      description:
        '项目后来又加了仓库时，已有工作空间不会自动多出目录：调这里把缺的仓库补克隆到工作空间的**同级目录**（<上级目录>/<仓库名>），已经在的不重复克隆。\n' +
        '参数：workspaceId。\n' +
        '返回：workspace（更新后的登记）、added（这次克隆的）、present（本来就在的）、skipped（同名目录不是 git 等，带原因）。\n' +
        '限制：只处理单目录工作空间；组合工作空间（groupId 非空）成员由建组 / workspace_retry_setup 管理。\n' +
        '下一步：派生或开会话前调一次即可；之后用 workspace_changes 看状态。\n' +
        '错误：404 / 403 项目没有 project.update / 400 不是 git 空间或组合空间。',
      request: { params: workspaceId },
      responses: { 200: json(syncWorkspaceResultSchema) }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false, idempotent: true }
  ),
  createWorkspace: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/projects/{projectId}/workspaces`, tags: ['workspaces'], summary: '新建临时或长期工作空间',
      description:
        '为项目建一个工作空间：temporary 要 taskId（可选 mode=isolated 新开 worktree，默认 isolated）；long_lived 要 mode=create|link（link 时给 path）。\n' +
        '参数：projectId；body 见 createWorkspaceRequest。\n' +
        '返回：workspace。\n' +
        '下一步：开会话时把 workspaceId 传回去；非 git 项目只能建普通目录。\n' +
        '错误：400 参数不对 / 403 权限不够 / 404 项目或任务不存在 / 409 机器上已有同名目录。',
      request: { params: projectId, ...body(createWorkspaceRequest) },
      responses: { 201: json(workspaceSchema, '已创建') }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false }
  ),
  removeWorkspace: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/workspaces/{workspaceId}/remove`, tags: ['workspaces'], summary: '移除工作空间（可连目录一起删）',
      description:
        '移除登记；deleteDirectory=true 时连目录一起删（平台建的才行），force=true 跳过未提交改动保护。\n' +
        '参数：workspaceId；body `{deleteDirectory?: boolean, force?: boolean}`。\n' +
        '返回：workspace（state=removed）。\n' +
        '错误：400 目录有未提交改动又不 force / 403 / 404。',
      request: { params: workspaceId, ...body(removeWorkspaceRequest) },
      responses: { 200: json(workspaceSchema) }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false, idempotent: true }
  ),
  retryWorkspaceSetup: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/workspaces/{workspaceId}/setup/retry`, tags: ['workspaces'], summary: '重跑准备命令',
      description:
        '只对 setup.state=failed 的工作空间有效；项目没配准备命令则 409。\n' +
        '参数：workspaceId。\n' +
        '返回：workspace（setup 里是新的状态与输出）。\n' +
        '错误：403 / 404 / 409 不需要重试或没配命令。',
      request: { params: workspaceId },
      responses: { 200: json(workspaceSchema) }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false, idempotent: true }
  ),
  workspaceGroupCreate: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/projects/{projectId}/workspace-groups`, tags: ['workspaces'], summary: '新建组合工作空间',
      description:
        '为多仓项目建一个组合组：必须先指定主仓库。cwd 是主仓库 `<groupRoot>/<primary>/`，附加仓在 `../repos/<name>/`。可只选子集（主仓库一定在内）。\n' +
        '参数：projectId；body.taskId、workerId（MCP 必须给已登记的远程机器，本机不可用）、repoIds?（子集）、fromGroupId? / branches?（在目标机器上按已有分支再建一组，用于验证交接）、sessionId?。\n' +
        '返回：组（id、root、members[].workspaceId/name/state、primaryRepoId）。准备命令只在主仓库跑。\n' +
        '下一步：session_start 时把 groupId 传回去；用 workspace_group_add_member 追加仓库。\n' +
        '错误：400 没指定主仓库或参数不合法 / 403 无 projects:write 或本机不可用 / 404 / 409 机器不支持组合工作空间。',
      request: { params: projectId, ...body(createWorkspaceGroupRequest) },
      responses: { 201: json(workspaceGroupSchema, '已创建') }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false, expose: 'workspace_group_create', idempotent: true }
  ),
  workspaceGroupGet: route('projects:read', {
    method: 'get', path: `${V1}/workspace-groups/{groupId}`, tags: ['workspaces'], summary: '看一个组合工作空间',
    description: '返回组的成员、路径、状态和错误。参数：groupId。错误：404 / 403。',
    request: { params: groupId },
    responses: { 200: json(workspaceGroupSchema) }
  }),
  workspaceGroupAddMember: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/workspace-groups/{groupId}/members`, tags: ['workspaces'], summary: '往组合组追加一个仓库',
      description:
        '在已有组合组里添加一个项目仓库（附加仓路径 `../repos/<name>`）。下一轮 session_reply 会注入更新后的成员清单，不必重启会话。\n' +
        '参数：groupId；body.repoId。\n' +
        '错误：400 仓库已在组里或不属于该项目 / 403 / 404 / 409。',
      request: { params: groupId, ...body(addWorkspaceGroupMemberRequest) },
      responses: { 201: json(workspaceGroupSchema) }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false, expose: 'workspace_group_add_member', idempotent: true }
  ),
  workspaceGroupRetry: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/workspace-groups/{groupId}/retry`, tags: ['workspaces'], summary: '重试失败的组合组成员',
      description: '只重试 state=failed 的成员，已就绪的不动。参数：groupId。返回更新后的组。错误：403 / 404 / 409 组已经准备好了。',
      request: { params: groupId },
      responses: { 200: json(workspaceGroupSchema) }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false, expose: 'workspace_group_retry', idempotent: true }
  ),
  sessionGitState: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/git/state`, tags: ['sessions'], summary: '按仓看 git 状态和未提交改动',
    description:
      '返回当前分支、未提交文件、ahead、能不能推送/开 PR，以及任务上已关联的 PR。\n' +
      '参数：sessionId；组合会话必须给 member（仓库名、repoId 或 workspaceId）。\n' +
      '错误：400 没选仓库（会列出可选成员）/ 403 无 sessions:read 或 files:read / 404。',
    request: { params: sessionId, query: z.object({ member: z.string().min(1).max(120).optional() }) },
    responses: { 200: json(sessionGitStateSchema) }
  }, { module: 'sessions', need: 'session.read', expose: 'session_git_state' }),
  sessionGitRun: route(
    'sessions:write',
    {
      method: 'post', path: `${V1}/sessions/{sessionId}/git/run`, tags: ['sessions'], summary: '按仓提交、推送或开 PR',
      description:
        '在指定成员仓库上执行 git：commit 只提交，push 有改动时先提交再推送，pr 再开 PR 并关联到任务。\n' +
        '参数：sessionId；body.action、message（commit/push 有改动时必填）、title?、body?、member?（组合会话必填，仓库名或 workspaceId）。\n' +
        '返回：sha、committed、pushed、branch、pullRequest（已关联任务）、compareUrl、notes。\n' +
        '权限：提交要 session.prompt；推送/PR 要 git.push（已包含在 sessions:write）。本机 Worker 不可用。\n' +
        '错误：400 没选仓库或默认分支上不能开 PR / 403 / 404 / 409。',
      request: { params: sessionId, ...body(sessionGitRunRequest) },
      responses: { 200: json(sessionGitRunResultSchema) }
    },
    { module: 'sessions', need: 'session.prompt', readOnly: false, expose: 'session_git_run', idempotent: true }
  ),
  taskPullRequests: route('sessions:read', {
    method: 'get', path: `${V1}/tasks/{taskId}/pull-requests`, tags: ['tasks'], summary: '同步并列出任务上的 PR',
    description:
      '列出该任务关联的各仓 PR。默认对开着的 PR 有 1 分钟节流；refresh=1 立刻再拉（合并后可据此收起会话）。\n' +
      '参数：taskId；query.refresh。\n' +
      '返回：{ pullRequests }。错误：403 / 404。',
    request: { params: taskId, query: z.object({ refresh: z.enum(['1', 'true']).optional() }) },
    responses: { 200: json(z.object({ pullRequests: z.array(pullRequestLinkSchema) })) }
  }, { module: 'tasks', need: 'task.read', expose: 'task_pull_requests' }),
  sessionSettle: route(
    'sessions:write',
    {
      method: 'post', path: `${V1}/sessions/{sessionId}/settle`, tags: ['sessions'], summary: '收起或恢复会话',
      description:
        'settled=true 把会话移出活跃列表（对话保留）；工作区干净时拆 worktree，有未提交/未跟踪/未推送改动则留下并记原因。settled=false 按原分支恢复 worktree。\n' +
        '还在跑的会话要先 session_cancel。PR 合并后也可先调 task_pull_requests?refresh=1，平台会尝试自动收起。\n' +
        '参数：sessionId；body.{ settled: boolean }。返回：会话对象。错误：403 无 session.settle（sessions:write 已包含）/ 409 还在跑 / 404。',
      request: { params: sessionId, ...body(settleSessionRequest) },
      responses: { 200: json(sessionSchema) }
    },
    { module: 'sessions', need: 'session.settle', readOnly: false, expose: 'session_settle', idempotent: true }
  ),
  workspaceSweep: route(
    'projects:write',
    {
      method: 'post', path: `${V1}/projects/{projectId}/cleanup/sweep`, tags: ['workspaces'], summary: '按项目规则清理临时工作空间',
      description:
        '跑一轮两段清理：先收起已满足条件的会话，下一轮才拆干净的 worktree。组合组原子处理。脏工作区整组留下，items[].reason / action=kept 写明原因。\n' +
        '参数：projectId。返回：removed/kept/skipped/failed、runId、items（含 reason）。\n' +
        '下一步：用 workspace_sweep_records 核对记录和孤儿目录。错误：403 无 projects:write / 404。',
      request: { params: projectId },
      responses: { 200: json(sweepReportSchema) }
    },
    { module: 'workspaces', need: 'project.update', readOnly: false, expose: 'workspace_sweep', idempotent: true }
  ),
  workspaceSweepRecords: route('projects:read', {
    method: 'get', path: `${V1}/projects/{projectId}/cleanup/records`, tags: ['workspaces'], summary: '查看项目的清理记录',
    description:
      '返回最近的清理记录（含 kept 原因）以及登记对不上的孤儿目录。参数：projectId。错误：403 / 404。',
    request: { params: projectId },
    responses: { 200: json(cleanupRecordsSchema) }
  }, { module: 'workspaces', need: 'project.read', expose: 'workspace_sweep_records' }),

  providerList: route('providers:read', {
    method: 'get', path: `${V1}/providers`, tags: ['providers'], summary: '列出模型提供商、模型和机器路由',
    description:
      '返回当前令牌能看见的提供商（含模型、用量、是否可管理）以及机器级路由覆盖。响应和日志里永远不含 API 密钥。\n' +
      '权限：`providers:read` / `providers:use` / `providers:manage` 均可（都带 provider.read）。\n' +
      '错误：403 无 providers:read。',
    responses: { 200: json(providerListSchema) }
  }, { module: 'providers', need: 'provider.read', expose: 'provider_list' }),
  providerCreate: route(
    'providers:manage',
    {
      method: 'post', path: `${V1}/providers`, tags: ['providers'], summary: '新建模型提供商',
      description:
        '新建个人 / 团队 / 全站提供商。apiKey 只写不回；不传则 hasKey=false，稍后用 provider_set_key。\n' +
        '全站（scope=hub）和团队提供商还要账号本身是集群管理员 / 团队管理员。密钥不会出现在响应、日志或审计里。\n' +
        '参数：slug、name、protocol、baseUrl、models、routing、enabled?、scope?、apiKey?。\n' +
        '错误：400 / 403 无 providers:manage，或只限项目的令牌 / 409 标识占用。',
      request: body(providerCreateRequest),
      responses: { 201: json(providerViewSchema) }
    },
    { module: 'providers', need: 'provider.manage', readOnly: false, destructive: false, expose: 'provider_create', idempotent: true }
  ),
  providerUpdate: route(
    'providers:manage',
    {
      method: 'put', path: `${V1}/providers/{providerId}`, tags: ['providers'], summary: '更新模型提供商',
      description:
        '改名称、地址、模型、路由或启停。不能用这个接口改密钥（用 provider_set_key）。响应不含密钥。\n' +
        '参数：providerId；body 同新建（无 scope / apiKey）。错误：400 / 403 / 404 / 409。',
      request: { params: providerId, ...body(providerUpdateRequest) },
      responses: { 200: json(providerViewSchema) }
    },
    { module: 'providers', need: 'provider.manage', readOnly: false, destructive: false, expose: 'provider_update', idempotent: true }
  ),
  providerSetKey: route(
    'providers:manage',
    {
      method: 'put', path: `${V1}/providers/{providerId}/key`, tags: ['providers'], summary: '设置或轮换提供商密钥',
      description:
        '写入新的 API 密钥。密钥只写不回，审计只记「已更新」。\n' +
        '参数：providerId；body.apiKey。返回 { ok: true }。错误：400 空密钥 / 403 / 404。',
      request: { params: providerId, ...body(providerKeyRequest) },
      responses: { 200: json(okSchema) }
    },
    { module: 'providers', need: 'provider.manage', readOnly: false, destructive: false, expose: 'provider_set_key', idempotent: true }
  ),
  providerProbe: route(
    'providers:manage',
    {
      method: 'post', path: `${V1}/providers/probe`, tags: ['providers'], summary: '探测上游模型列表',
      description:
        '给 providerId 就用已存密钥（要能管理它）；否则传临时 baseUrl / apiKey（明文只用于这次探测，不会回显、不会入库，除非随后新建）。\n' +
        '指定在线 worker 时从那台机器发起；否则 hub 直连。上游 4xx/5xx 也返回 200 + ok:false。\n' +
        '参数：providerId?、protocol?、baseUrl?、apiKey?、workerId?。错误：400 / 403 / 404。',
      request: body(providerProbeRequest),
      responses: { 200: json(providerProbeResultSchema) }
    },
    { module: 'providers', need: 'provider.manage', readOnly: false, destructive: false, expose: 'provider_probe' }
  ),
  providerTest: route(
    'providers:manage',
    {
      method: 'post', path: `${V1}/providers/{providerId}/test`, tags: ['providers'], summary: '从机器测试提供商连通',
      description:
        '选一台 worker，按生效路由实测：直连是 worker→提供商，经 hub 是 worker→hub→提供商。真密钥不返回。\n' +
        '参数：providerId；body.workerId。返回 ok、message、via、models。错误：400 没选机器或没密钥 / 403 / 404。',
      request: { params: providerId, ...body(providerTestRequest) },
      responses: { 200: json(providerProbeResultSchema) }
    },
    { module: 'providers', need: 'provider.manage', readOnly: false, destructive: false, expose: 'provider_test' }
  ),
  providerDelete: route(
    'providers:manage',
    {
      method: 'delete', path: `${V1}/providers/{providerId}`, tags: ['providers'], summary: '删除模型提供商',
      description:
        '破坏性操作：不带 confirm=true 时不删除，只返回将受影响的模型和会话用量。确认后再删。\n' +
        '参数：providerId；body.confirm。错误：403 / 404。',
      request: { params: providerId, ...body(providerConfirmRequest) },
      responses: { 200: json(providerImpactSchema) }
    },
    { module: 'providers', need: 'provider.manage', readOnly: false, destructive: true, expose: 'provider_delete', idempotent: true }
  ),
  providerRoutingSet: route(
    'providers:manage',
    {
      method: 'put', path: `${V1}/providers/routing/{workerId}`, tags: ['providers'], summary: '设置机器的提供商路由',
      description:
        '给一台机器覆盖路由（direct / hub），或 routing=null 取消覆盖、跟随提供商。只有集群管理员的管理令牌能改。\n' +
        '破坏性操作：不带 confirm=true 时只返回影响说明。已有会话保持当前路径，直到重启。\n' +
        '参数：workerId；body.routing、confirm?。错误：403 / 404。',
      request: { params: workerIdParam, ...body(providerRoutingRequest) },
      responses: { 200: json(providerImpactSchema) }
    },
    { module: 'providers', need: 'provider.manage', readOnly: false, destructive: true, expose: 'provider_routing_set', idempotent: true }
  )

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
