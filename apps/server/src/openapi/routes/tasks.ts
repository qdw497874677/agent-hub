// tasks 能力段的路由定义（从 routes.ts 原样搬出；顺序即注册顺序）。
import { z } from '@hono/zod-openapi';
import {
  appendLogRequest,
  createTaskRequest,
  editLogRequest,
  sessionSchema,
  setTaskStatusRequest,
  setTaskSummaryRequest,
  setDefaultAgentRequest,
  taskSchema,
  workLogEntrySchema,
  workLogPage
} from '@agent-hub/contract';
import { V1, json, body, route } from './base.ts';
import {
  taskId,
  pullRequestLinkSchema
} from './schemas.ts';

export const tasks = {
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
  setTaskDefaultAgent: route('projects:write', {
    method: 'patch', path: `${V1}/tasks/{taskId}/default-agent`, tags: ['tasks'], summary: '设置或清空任务默认 Agent',
    description:
      '改这条任务的默认 Agent（覆盖项目默认）；会话里显式选的仍然优先。body.defaultAgent 为 null = 清掉。\n' +
      '参数：taskId（路径）；body.defaultAgent 为 { runtime, model?, options? } 或 null。\n' +
      '返回：更新后的任务对象（含 defaultAgent）。\n' +
      '权限：projects:write，且是该任务所属项目的管理员。项目限定令牌只能改它范围内的项目。\n' +
      '下一步：用 get_task 或 resolve_default_agent（带 taskId）复核；session_start 省略 model 就会用它。\n' +
      '错误：400 参数不合法；403 无 projects:write 或不是项目管理员；404 任务不存在或你看不见。',
    request: { params: taskId, ...body(setDefaultAgentRequest) },
    responses: { 200: json(taskSchema) }
  }, { module: 'tasks', need: 'project.update', readOnly: false, expose: 'task_default_agent', idempotent: true }),
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
} as const;

export const taskPulls = {
  taskPullRequests: route('sessions:read', {
    method: 'get', path: `${V1}/tasks/{taskId}/pull-requests`, tags: ['tasks'], summary: '同步并列出任务上的 PR',
    description:
      '列出该任务关联的各仓 PR。默认对开着的 PR 有 1 分钟节流；refresh=1 立刻再拉（合并后可据此收起会话）。\n' +
      '参数：taskId；query.refresh。\n' +
      '返回：{ pullRequests }。错误：403 / 404。',
    request: { params: taskId, query: z.object({ refresh: z.enum(['1', 'true']).optional() }) },
    responses: { 200: json(z.object({ pullRequests: z.array(pullRequestLinkSchema) })) }
  }, { module: 'tasks', need: 'task.read', expose: 'task_pull_requests' }),
} as const;
