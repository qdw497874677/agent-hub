import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { streamSSE } from 'hono/streaming';
import {
  createProjectRequest,
  searchResponseSchema,
  createTaskRequest,
  deriveSessionRequest,
  forkSessionRequest,
  promptRequest,
  saveLayoutRequest,
  setTaskStatusRequest,
  workerInfoSchema
} from '@agent-hub/contract';
import type { Deps, DomainError, SessionId, TaskStatus, WorkerStatus } from '@agent-hub/domain';
import {
  asSessionId,
  searchUseCase,
  createProjectUseCase,
  createTaskUseCase,
  deriveSessionUseCase,
  emptyLayout,
  forkSessionUseCase,
  loadCanvas,
  listProjects,
  place,
  setTaskStatusUseCase
} from '@agent-hub/domain';
import type { StreamHub } from './stream-hub.ts';

export interface LiveSessions {
  has(sessionId: SessionId): boolean;
  add(sessionId: SessionId): void;
  drop(sessionId: SessionId): void;
}

export interface AppOptions {
  readonly deps: Deps;
  readonly hub: StreamHub;
  readonly workers: () => WorkerStatus[];
  readonly live: LiveSessions;
  readonly token: string | null;
}

const STATUS_OF: Record<DomainError['code'], ContentfulStatusCode> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  not_implemented: 501
};

function fail(c: Context, error: DomainError): Response {
  return c.json({ error: { code: error.code, message: error.message } }, STATUS_OF[error.code]);
}

function badRequest(c: Context): Response {
  return c.json({ error: { code: 'invalid', message: '请求体不合法' } }, 400);
}

export function createApp(options: AppOptions): Hono {
  const { deps, hub, live } = options;
  const app = new Hono();

  // token 只在绑非 loopback 时才是必需的；main.ts 保证那种情况下一旦没配就不启动。
  app.use('/api/*', async (c, next) => {
    if (options.token === null) return next();
    if ((c.req.header('authorization') ?? '') !== `Bearer ${options.token}`) {
      return c.json({ error: { code: 'unauthorized', message: '缺少或错误的 token' } }, 401);
    }
    return next();
  });

  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/workers', (c) => c.json(workerInfoSchema.array().parse(options.workers())));

  app.get('/api/projects', async (c) => {
    const result = await listProjects(deps);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.post('/api/projects', async (c) => {
    const parsed = createProjectRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c);
    const result = await createProjectUseCase(deps, parsed.data);
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  app.get('/api/projects/:projectId/canvas', async (c) => {
    const result = await loadCanvas(deps, c.req.param('projectId'));
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  /** 列表视图与 Cmd+K 的同一个后端：按任务标题/目标 + 会话里说过的话搜。 */
  app.get('/api/search', async (c) => {
    const result = await searchUseCase(deps, {
      projectId: c.req.query('projectId') ?? '',
      query: c.req.query('q') ?? ''
    });
    if (!result.ok) return fail(c, result.error);
    return c.json(searchResponseSchema.parse({ hits: result.value }));
  });

  app.post('/api/tasks', async (c) => {
    const parsed = createTaskRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c);
    const result = await createTaskUseCase(deps, parsed.data);
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  app.patch('/api/tasks/:taskId/status', async (c) => {
    const parsed = setTaskStatusRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c);
    const result = await setTaskStatusUseCase(
      deps,
      c.req.param('taskId') as never,
      parsed.data.status as TaskStatus
    );
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.post('/api/sessions/derive', async (c) => {
    const parsed = deriveSessionRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c);
    const result = await deriveSessionUseCase(deps, parsed.data);
    if (!result.ok) return fail(c, result.error);
    live.add(result.value.id);
    return c.json(result.value, 201);
  });

  app.post('/api/sessions/fork', async (c) => {
    const parsed = forkSessionRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c);
    const result = await forkSessionUseCase(deps, parsed.data);
    if (!result.ok) return fail(c, result.error);
    live.add(result.value.id);
    return c.json(result.value, 201);
  });

  /**
   * 发消息。会话不在 worker 手上时（server 重启过、worker 崩过）先补一次
   * start_session + resume，再发消息——这就是 S7.1「重开浏览器还能接着干活」。
   */
  app.post('/api/sessions/:sessionId/prompt', async (c) => {
    const parsed = promptRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c);

    const sessionId = asSessionId(c.req.param('sessionId'));
    const session = await deps.sessions.byId(sessionId);
    if (!session) return c.json({ error: { code: 'not_found', message: '会话不存在' } }, 404);

    if (!live.has(sessionId)) {
      const task = await deps.tasks.byId(session.taskId);
      const project = task ? await deps.projects.byId(task.projectId) : null;
      if (!task || !project) {
        return c.json({ error: { code: 'not_found', message: '会话所属任务或项目不存在' } }, 404);
      }
      const resumed = await deps.gateway.dispatch({
        kind: 'start_session',
        sessionId,
        taskId: session.taskId,
        agentId: session.agentId,
        model: session.model,
        workspaceRoot: project.rootPath,
        origin: session.origin,
        resume: { agentSessionRef: session.agentSessionRef, cursor: session.lastSeq }
      });
      if (!resumed.ok) return fail(c, resumed.error);
      live.add(sessionId);
    }

    const sent = await deps.gateway.dispatch({ kind: 'prompt', sessionId, text: parsed.data.text });
    return sent.ok ? c.json({ ok: true }) : fail(c, sent.error);
  });

  app.post('/api/sessions/:sessionId/interrupt', async (c) => {
    const sessionId = asSessionId(c.req.param('sessionId'));
    const result = await deps.gateway.dispatch({ kind: 'interrupt', sessionId });
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  });

  app.get('/api/sessions/:sessionId/events', async (c) => {
    const sessionId = asSessionId(c.req.param('sessionId'));
    return c.json(await deps.sessions.eventsAfter(sessionId, 0));
  });

  app.put('/api/projects/:projectId/layout', async (c) => {
    const parsed = saveLayoutRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c);
    const projectId = c.req.param('projectId') as never;
    const current = (await deps.layout.load(projectId)) ?? emptyLayout(projectId, deps.now());
    let next = current;
    for (const [nodeId, point] of Object.entries(parsed.data.positions)) {
      next = place(next, nodeId, point, deps.now());
    }
    await deps.layout.save(next);
    return c.json(next);
  });

  /** SSE：一条连接推所有会话的事件，前端按 sessionId 分流。 */
  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = hub.subscribe((frame) => {
        void stream.writeSSE({ event: 'frame', data: JSON.stringify(frame) });
      });
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => resolve());
      });
      unsubscribe();
    })
  );

  return app;
}
