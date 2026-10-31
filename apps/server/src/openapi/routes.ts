import { createRoute, z } from '@hono/zod-openapi';
import {
  appendLogRequest,
  changeOptionRequest,
  createProjectRequest,
  createTaskRequest,
  deleteProjectRequest,
  deriveSessionRequest,
  editLogRequest,
  forkSessionRequest,
  journalEntrySchema,
  projectSchema,
  promptRequest,
  sessionSchema,
  setProjectDescriptionRequest,
  setProjectRepoRequest,
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

const projectId = z.object({ projectId: z.string().openapi({ param: { name: 'projectId', in: 'path' } }) });
const taskId = z.object({ taskId: z.string().openapi({ param: { name: 'taskId', in: 'path' } }) });
const sessionId = z.object({ sessionId: z.string().openapi({ param: { name: 'sessionId', in: 'path' } }) });

/** 每条路由要的权限范围（文档里写清楚；真正的判断在 can()）。 */
export type ScopeNote = 'projects:read' | 'projects:write' | 'sessions:read' | 'sessions:write' | 'workers:read' | 'assets:submit' | null;

const route = <R extends Parameters<typeof createRoute>[0]>(scope: ScopeNote, config: R) =>
  createRoute({
    ...config,
    security: scope ? [{ bearer: [scope] }] : [],
    description: `${config.description ?? ''}${scope ? `\n\n权限范围：\`${scope}\`` : ''}`.trim(),
    responses: { ...errors, ...config.responses }
  });

export const routes = {
  health: route(null, {
    method: 'get', path: `${V1}/health`, tags: ['meta'], summary: '健康检查',
    responses: { 200: json(z.object({ ok: z.boolean() })) }
  }),
  me: route(null, {
    method: 'get', path: `${V1}/me`, tags: ['meta'], summary: '当前令牌是谁',
    description: '返回令牌所属的账号与令牌的权限范围。任何有效令牌都能调。',
    responses: { 200: json(z.object({ user: z.object({ id: z.string(), name: z.string(), service: z.boolean() }), token: z.object({ id: z.string(), name: z.string(), kind: z.enum(['personal', 'service']) }) })) }
  }),
  listWorkers: route('workers:read', {
    method: 'get', path: `${V1}/workers`, tags: ['workers'], summary: '能用的机器',
    responses: { 200: json(z.array(workerInfoSchema)) }
  }),

  listProjects: route('projects:read', {
    method: 'get', path: `${V1}/projects`, tags: ['projects'], summary: '项目列表',
    responses: { 200: json(z.array(projectSchema)) }
  }),
  createProject: route('projects:write', {
    method: 'post', path: `${V1}/projects`, tags: ['projects'], summary: '新建项目',
    request: body(createProjectRequest),
    responses: { 201: json(projectSchema, '已创建') }
  }),
  setProjectRepo: route('projects:write', {
    method: 'put', path: `${V1}/projects/{projectId}/repo`, tags: ['projects'], summary: '绑定 / 解除项目仓库',
    request: { params: projectId, ...body(setProjectRepoRequest) },
    responses: { 200: json(projectSchema) }
  }),
  setProjectDescription: route('projects:write', {
    method: 'put', path: `${V1}/projects/{projectId}/description`, tags: ['projects'], summary: '改项目说明',
    request: { params: projectId, ...body(setProjectDescriptionRequest) },
    responses: { 200: json(projectSchema) }
  }),
  deleteProject: route('projects:write', {
    method: 'delete', path: `${V1}/projects/{projectId}`, tags: ['projects'], summary: '把项目放进回收站',
    description: '要输项目名确认；只有团队主人或建项目的人能删。磁盘目录保留。',
    request: { params: projectId, ...body(deleteProjectRequest) },
    responses: { 200: json(z.object({ id: z.string(), deleted: z.literal(true) })) }
  }),
  workspaceChanges: route('projects:read', {
    method: 'get', path: `${V1}/workspaces/{workspaceId}/changes`, tags: ['projects'], summary: '工作空间里未提交的改动',
    request: { params: z.object({ workspaceId: z.string().openapi({ param: { name: 'workspaceId', in: 'path' } }) }) },
    responses: { 200: json(workspaceChangesSchema) }
  }),

  listTasks: route('projects:read', {
    method: 'get', path: `${V1}/tasks`, tags: ['tasks'], summary: '项目下的任务',
    request: { query: z.object({ projectId: z.string().min(1) }) },
    responses: { 200: json(z.array(taskSchema)) }
  }),
  createTask: route('projects:write', {
    method: 'post', path: `${V1}/tasks`, tags: ['tasks'], summary: '新建任务',
    request: body(createTaskRequest),
    responses: { 201: json(taskSchema, '已创建') }
  }),
  getTask: route('projects:read', {
    method: 'get', path: `${V1}/tasks/{taskId}`, tags: ['tasks'], summary: '任务详情（带会话列表）',
    request: { params: taskId },
    responses: { 200: json(taskSchema.extend({ sessions: z.array(sessionSchema) })) }
  }),
  setTaskStatus: route('projects:write', {
    method: 'patch', path: `${V1}/tasks/{taskId}/status`, tags: ['tasks'], summary: '改任务状态',
    request: { params: taskId, ...body(setTaskStatusRequest) },
    responses: { 200: json(taskSchema) }
  }),
  setTaskSummary: route('projects:write', {
    method: 'patch', path: `${V1}/tasks/{taskId}/summary`, tags: ['tasks'], summary: '改任务摘要',
    request: { params: taskId, ...body(setTaskSummaryRequest) },
    responses: { 200: json(taskSchema) }
  }),
  listTaskLog: route('projects:read', {
    method: 'get', path: `${V1}/tasks/{taskId}/log`, tags: ['tasks'], summary: '工作日志（倒序分页）',
    request: { params: taskId, query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), beforeSeq: z.coerce.number().int().optional() }) },
    responses: { 200: json(workLogPage) }
  }),
  appendTaskLog: route('projects:write', {
    method: 'post', path: `${V1}/tasks/{taskId}/log`, tags: ['tasks'], summary: '写一条工作日志',
    request: { params: taskId, ...body(appendLogRequest) },
    responses: { 201: json(workLogEntrySchema, '已写入') }
  }),
  editTaskLog: route('projects:write', {
    method: 'patch', path: `${V1}/tasks/{taskId}/log/{entryId}`, tags: ['tasks'], summary: '改自己写的日志',
    request: { params: taskId.extend({ entryId: z.string().openapi({ param: { name: 'entryId', in: 'path' } }) }), ...body(editLogRequest) },
    responses: { 200: json(workLogEntrySchema) }
  }),

  startSession: route('sessions:write', {
    method: 'post', path: `${V1}/sessions`, tags: ['sessions'], summary: '在任务下开一条会话',
    description: '派到指定机器（workerId）上跑；本机（hub 同机）的机器开放 API 永远用不了。',
    request: body(deriveSessionRequest),
    responses: { 201: json(sessionSchema, '已开始') }
  }),
  forkSession: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/fork`, tags: ['sessions'], summary: '从某条消息分叉',
    request: body(forkSessionRequest),
    responses: { 201: json(sessionSchema, '已分叉') }
  }),
  getSession: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}`, tags: ['sessions'], summary: '会话详情',
    request: { params: sessionId },
    responses: { 200: json(sessionSchema) }
  }),
  prompt: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/prompt`, tags: ['sessions'], summary: '对会话说话',
    description: '立即返回；回复从 /events 拉或 /stream 订阅。',
    request: { params: sessionId, ...body(promptRequest) },
    responses: { 202: json(okSchema, '已发出') }
  }),
  interrupt: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/interrupt`, tags: ['sessions'], summary: '打断正在跑的会话',
    request: { params: sessionId },
    responses: { 200: json(okSchema) }
  }),
  changeOption: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/options`, tags: ['sessions'], summary: '改可调项（模型、思考强度…）',
    request: { params: sessionId, ...body(changeOptionRequest) },
    responses: { 200: json(sessionSchema) }
  }),
  events: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/events`, tags: ['sessions'], summary: '会话事件（after 之后的）',
    request: { params: sessionId, query: z.object({ after: z.coerce.number().int().min(0).optional() }) },
    responses: { 200: json(z.array(journalEntrySchema)) }
  }),
  stream: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/stream`, tags: ['sessions'], summary: '会话事件流（SSE）',
    description:
      '先补发 `after`（或 `Last-Event-ID`）之后的事件，再实时推。\n\n' +
      '- `event: event`，`id` = 事件序号，`data` = `{ seq, event, at }`（同 /events 的一项）\n' +
      '- `event: status`，`data` = `{ status }`：只有状态变了\n' +
      '- 每 15 秒一条 `: ping` 注释保活。每个令牌最多同时开 5 条。',
    request: { params: sessionId, query: z.object({ after: z.coerce.number().int().min(0).optional() }) },
    responses: { 200: { content: { 'text/event-stream': { schema: z.string() } }, description: 'SSE 流' } }
  }),
  activity: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/activity`, tags: ['sessions'], summary: '谁对这条会话做了什么',
    request: { params: sessionId },
    responses: { 200: json(z.array(z.object({ action: z.string(), actor: z.object({ id: z.string(), name: z.string() }), detail: z.string(), at: z.number() }))) }
  })
} as const;
