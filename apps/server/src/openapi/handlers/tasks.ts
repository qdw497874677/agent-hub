// tasks 能力的处理函数（从 app.ts 原样搬出；鉴权/限流/审计仍在 app.ts 的前导里）。
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { V1Runtime } from '../context.ts';
import { openapiOn, valid } from '../context.ts';
import type { Env } from '../context.ts';
import type {
  Context
} from 'hono';
import type {
  LogAuthor,
  TaskStatus
} from '@agent-hub/domain';
import {
  appendWorkLogUseCase,
  asProjectId,
  asSessionId,
  asTaskId,
  authorizeProject,
  can,
  createTaskUseCase,
  editWorkLogUseCase,
  forbidden,
  notFound,
  projectReader,
  setTaskDefaultAgentUseCase,
  setTaskStatusUseCase,
  setTaskSummaryUseCase,
  sweepTemporaryWorkspacesUseCase,
  unavailable
} from '@agent-hub/domain';
import type { z } from 'zod';
import type {
  createTaskRequest
} from '@agent-hub/contract';
import { fail } from '../../http-error.ts';
import {
  routes
} from '.././routes.ts';

/** installTasks：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installTasks(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  on(routes.listTasks, async (c) => {
    const actor = rt.principal(c);
    const { projectId } = valid<{ projectId: string }>(c, 'query');
    const project = await rt.deps.projects.byId(asProjectId(projectId));
    if (!project) return fail(c, notFound('项目不存在'));
    if (rt.deps.access) {
      const allowed = await authorizeProject(rt.deps.access, actor, project, 'task.read');
      if (!allowed.ok) return fail(c, allowed.error);
    } else if (!can(actor, 'task.read')) return fail(c, forbidden('令牌没有 projects:read'));
    return c.json(await rt.deps.tasks.listByProject(project.id));
  });
  on(routes.createTask, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'task.create')) return fail(c, forbidden('令牌没有 projects:write'));
    const result = await createTaskUseCase(rt.deps, { ...valid<z.output<typeof createTaskRequest>>(c, 'json'), ownerId: actor.user.id });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.getTask, async (c) => {
    const task = await rt.deps.tasks.byId(asTaskId(c.req.param('taskId') ?? ''));
    if (!task) return fail(c, notFound('任务不存在'));
    return c.json({ ...task, sessions: await rt.deps.sessions.listByTask(task.id) });
  });
  on(routes.setTaskDefaultAgent, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const taskId = asTaskId(c.req.param('taskId') ?? '');
    const task = await rt.deps.tasks.byId(taskId);
    if (!task) return fail(c, notFound('任务不存在'));
    const project = await rt.deps.projects.byId(task.projectId);
    if (!project) return fail(c, notFound('项目不存在'));
    const readable = await projectReader(rt.deps.access, actor);
    if (!readable(project)) return fail(c, notFound('任务不存在'));
    const allowed = await authorizeProject(rt.deps.access, actor, project, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);
    const input = valid<{ defaultAgent: unknown }>(c, 'json');
    const result = await setTaskDefaultAgentUseCase(rt.deps, taskId, input.defaultAgent);
    if (result.ok) await rt.auditDefaultAgent(actor, taskId, result.value.defaultAgent ?? null);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.setTaskStatus, async (c) => {
    const input = valid<{ status: TaskStatus; note?: string }>(c, 'json');
    const actor = rt.principal(c);
    const result = await setTaskStatusUseCase(rt.deps, asTaskId(c.req.param('taskId') ?? ''), input.status, 'user', input.note, {
      label: `${actor.user.displayName}（via ${actor.via?.name ?? '令牌'}）`
    });
    if (result.ok && (input.status === 'done' || input.status === 'abandoned')) {
      void sweepTemporaryWorkspacesUseCase(rt.deps, { taskId: result.value.id }).catch(() => undefined);
    }
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.setTaskSummary, async (c) => {
    const result = await setTaskSummaryUseCase(rt.deps, asTaskId(c.req.param('taskId') ?? ''), valid<{ summary: string }>(c, 'json').summary);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  const author = (c: Context): LogAuthor => {
    const actor = rt.principal(c);
    return { kind: 'user', userId: actor.user.id, name: `${actor.user.displayName}（via ${actor.via?.name ?? '令牌'}）` };
  };
  on(routes.listTaskLog, async (c) => {
    const taskId = asTaskId(c.req.param('taskId') ?? '');
    if (!(await rt.deps.tasks.byId(taskId))) return fail(c, notFound('任务不存在'));
    const query = valid<{ limit?: number; beforeSeq?: number }>(c, 'query');
    const limit = query.limit ?? 50;
    const entries = await rt.deps.workLog.list(taskId, { limit, beforeSeq: query.beforeSeq });
    const last = entries.at(-1);
    return c.json({ entries, nextBeforeSeq: entries.length === limit && last ? last.seq : null });
  });
  on(routes.appendTaskLog, async (c) => {
    const input = valid<{ body: string; links?: never; sessionId?: string | null }>(c, 'json');
    const result = await appendWorkLogUseCase(rt.deps, {
      taskId: asTaskId(c.req.param('taskId') ?? ''),
      author: author(c),
      body: input.body,
      links: input.links,
      sessionId: input.sessionId ? asSessionId(input.sessionId) : null
    });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.editTaskLog, async (c) => {
    const result = await editWorkLogUseCase(rt.deps, { entryId: c.req.param('entryId') ?? '', body: valid<{ body: string }>(c, 'json').body, author: author(c) });
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
}

/** installTaskPulls：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installTaskPulls(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  on(routes.taskPullRequests, async (c) => {
    const git = rt.needGit();
    if (!git) return fail(c, unavailable('Git 工作流未就绪'));
    const actor = rt.principal(c);
    if (!can(actor, 'task.read')) return fail(c, forbidden('令牌没有 sessions:read 或 projects:read'));
    const refresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
    const result = await git.syncTask(actor, c.req.param('taskId') ?? '', refresh ? { refresh: true } : undefined);
    return result.ok ? c.json({ pullRequests: result.value }) : fail(c, result.error);
  });
}
