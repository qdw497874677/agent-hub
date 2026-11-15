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
  updateProjectRequest,
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
  }),
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
    description:
      '把项目放进回收站（磁盘目录保留，可恢复）。\n' +
      '参数：projectId（路径）、confirmName（必须等于项目名，防误删）。\n' +
      '返回：{ id, deleted: true }。\n' +
      '下一步：任务与会话不再出现在列表里；恢复要回工作台。\n' +
      '错误：400 名字对不上；403 不是团队主人或建项目的人；404 项目不存在。',
    request: { params: projectId, ...body(deleteProjectRequest) },
    responses: { 200: json(z.object({ id: z.string(), deleted: z.literal(true) })) }
  }),
  workspaceChanges: route('projects:read', {
    method: 'get', path: `${V1}/workspaces/{workspaceId}/changes`, tags: ['projects'], summary: '工作空间里未提交的改动',
    request: { params: z.object({ workspaceId: z.string().openapi({ param: { name: 'workspaceId', in: 'path' } }) }) },
    responses: { 200: json(workspaceChangesSchema) }
  }),

  submitAssetRevision: route('assets:submit', {
    method: 'post', path: `${V1}/assets/{assetId}/revisions`, tags: ['assets'], summary: '给资产交一个新版本（进审核）',
    description: '只有作者（或团队负责人）能交；新版本进待审队列，审核通过才上线。令牌不能审核、发布、装机或下架。文件内容 base64。',
    request: {
      params: z.object({ assetId: z.string().openapi({ param: { name: 'assetId', in: 'path' } }) }),
      ...body(z.object({ files: z.array(z.object({ path: z.string().min(1).max(512), data: z.string() })).min(1).max(200) }))
    },
    responses: {
      200: json(z.object({ assetId: z.string(), latest: z.string(), submissionId: z.string().nullable(), status: z.string().nullable() }))
    }
  }),

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
  }),
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
  }),
  setTaskSummary: route('projects:write', {
    method: 'patch', path: `${V1}/tasks/{taskId}/summary`, tags: ['tasks'], summary: '改任务摘要',
    request: { params: taskId, ...body(setTaskSummaryRequest) },
    responses: { 200: json(taskSchema) }
  }),
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
  }),
  editTaskLog: route('projects:write', {
    method: 'patch', path: `${V1}/tasks/{taskId}/log/{entryId}`, tags: ['tasks'], summary: '改自己写的日志',
    request: { params: taskId.extend({ entryId: z.string().openapi({ param: { name: 'entryId', in: 'path' } }) }), ...body(editLogRequest) },
    responses: { 200: json(workLogEntrySchema) }
  }),

  startSession: route('sessions:write', {
    method: 'post', path: `${V1}/sessions`, tags: ['sessions'], summary: '在任务下开一条会话',
    description:
      '在任务下开一条会话，派到指定机器（workerId）上跑。本机（hub 同机）的机器开放 API 永远用不了。\n' +
      '参数：taskId、agentId、model（空串=运行时默认）、workerId（建议显式给在线机器）、workspaceId（可选）。\n' +
      '返回：会话对象（id、status、model、workspaceId）。\n' +
      '下一步：用 session_reply 发第一句；用 events 或 list_task_log 跟进展。\n' +
      '错误：400 参数不合法；403 无 sessions:write；409 机器不可用或没装该 runtime。\n' +
      '重试：MCP 调用要给 clientRequestId，同一值重试不会开第二条会话。',
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
    description:
      '取一条会话的状态与配置。\n' +
      '参数：sessionId。\n' +
      '返回：会话对象（status、model、workspaceId、taskId…；taskId 可能为 null，表示常驻容器会话）。\n' +
      '下一步：用 events 读它的时间线。\n' +
      '错误：404 会话不存在或属于看不见的项目。',
    request: { params: sessionId },
    responses: { 200: json(sessionSchema) }
  }),
  prompt: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/prompt`, tags: ['sessions'], summary: '对会话说话',
    description:
      '给会话发一条消息，立即返回（202）；回合在后台跑。\n' +
      '参数：text、clientMessageId（可选，同一条消息重试用同一个值，送达队列据此去重）。\n' +
      '返回：{ ok: true }。\n' +
      '下一步：轮询 events（传 after=最后一条 seq）或 list_task_log 看进展与结论。\n' +
      '错误：404 会话不存在或看不见；409 会话不在运行（先 session_start）；429 太频繁。',
    request: { params: sessionId, ...body(promptRequest) },
    responses: { 202: json(okSchema, '已发出') }
  }),
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
  }),
  changeOption: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/options`, tags: ['sessions'], summary: '改可调项（模型、思考强度…）',
    request: { params: sessionId, ...body(changeOptionRequest) },
    responses: { 200: json(sessionSchema) }
  }),
  events: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/events`, tags: ['sessions'], summary: '会话事件（after 之后的）',
    description:
      '读会话时间线（对外已投影）：只有文本、工具名与成败、结束原因、诊断占位。\n' +
      '参数：sessionId；after（只取 seq > after 的事件，便于轮询）。\n' +
      '返回：[{ seq, at, event }]，event.kind ∈ text | tool | tool_result | ended | diagnostic。\n' +
      '下一步：把 after 设为最后一条 seq 继续轮；工具细节与思考过程不对开放 API 暴露。\n' +
      '错误：404 会话不存在或看不见。',
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
