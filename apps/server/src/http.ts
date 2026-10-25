import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { streamSSE } from 'hono/streaming';
import {
  changeOptionRequest,
  createProjectRequest,
  directoryListingSchema,
  homeSchema,
  searchResponseSchema,
  createTaskRequest,
  deriveSessionRequest,
  forkSessionRequest,
  promptRequest,
  saveLayoutRequest,
  setTaskStatusRequest,
  workerInfoSchema
} from '@agent-hub/contract';
import type { Deps, DomainError, TaskStatus } from '@agent-hub/domain';
import {
  asSessionId,
  asTaskId,
  changeSessionOption,
  createProjectUseCase,
  createTaskUseCase,
  deriveSessionUseCase,
  forkSessionUseCase,
  interruptSessionUseCase,
  listProjects,
  listWorkers,
  loadCanvas,
  loadHome,
  notFound,
  promptSessionUseCase,
  saveLayoutUseCase,
  searchUseCase,
  setTaskStatusUseCase
} from '@agent-hub/domain';
import type { StreamHub } from './stream-hub.ts';

export interface AppOptions {
  readonly deps: Deps;
  readonly hub: StreamHub;
  readonly token: string | null;
  /**
   * 等 agent 回报它改完之后的可调项。
   *
   * 换模型会连带改变别的项，所以「改成功了」这句话只有 agent 有资格说；
   * 这里等它的全量回报，而不是把用户选的值直接当成结果显示出去。
   */
  readonly waitOptions?: (sessionId: string) => Promise<void>;
}

const STATUS_OF: Record<DomainError['code'], ContentfulStatusCode> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  not_implemented: 501
};

/** 所有错误响应都长一个样：{ error: { code, message } }。 */
function fail(c: Context, error: DomainError): Response {
  return c.json({ error: { code: error.code, message: error.message } }, STATUS_OF[error.code]);
}

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };
/** 契约里的 zod schema 只用到这一点点形状；server 不必直接依赖 zod。 */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** 读请求体并按契约校验；不合法时直接给出统一的 400。 */
async function body<T>(c: Context, schema: Schema<T>): Promise<Parsed<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, response: fail(c, { code: 'invalid', message: '请求体不合法' }) };
}

export function createApp(options: AppOptions): Hono {
  const { deps, hub } = options;
  const app = new Hono();

  // token 只在绑非 loopback 时才是必需的；main.ts 保证那种情况下一旦没配就不启动。
  app.use('/api/*', async (c, next) => {
    if (options.token === null) return next();
    // header 优先；SSE（EventSource）设不了请求头，所以也接受查询串。
    const offered = (c.req.header('authorization') ?? '') === `Bearer ${options.token}`
      ? options.token
      : (c.req.query('token') ?? '');
    if (offered !== options.token) {
      return c.json({ error: { code: 'unauthorized', message: '缺少或错误的 token' } }, 401); // 不是领域错误，所以不走 fail()
    }
    return next();
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/home', async (c) => c.json(homeSchema.parse(await loadHome(deps))));

  // 目录选择器（S2.1）：让人从真实目录里挑，而不是手打一个可能会错的路径。
  app.get('/api/fs/directories', async (c) => {
    const requested = c.req.query('path') ?? '';
    const path = requested === '' ? homedir() : resolve(requested);
    if (!(await deps.fs.directoryExists(path))) return fail(c, notFound(`没有这个目录：${path}`));
    const entries = await deps.fs.listDirectories(path);
    const parent = dirname(path);
    return c.json(directoryListingSchema.parse({ path, parent: parent === path ? null : parent, entries }));
  });

  app.get('/api/workers', async (c) => c.json(workerInfoSchema.array().parse(await listWorkers(deps))));

  app.get('/api/projects', async (c) => {
    const result = await listProjects(deps);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.post('/api/projects', async (c) => {
    const input = await body(c, createProjectRequest);
    if (!input.ok) return input.response;
    const result = await createProjectUseCase(deps, input.value);
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  app.get('/api/projects/:projectId/canvas', async (c) => {
    const result = await loadCanvas(deps, c.req.param('projectId'));
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.put('/api/projects/:projectId/layout', async (c) => {
    const input = await body(c, saveLayoutRequest);
    if (!input.ok) return input.response;
    return c.json(await saveLayoutUseCase(deps, c.req.param('projectId'), input.value.positions));
  });

  /** 列表视图与 Cmd+K 的同一个后端：按任务标题/目标 + 会话里说过的话搜。 */
  app.get('/api/search', async (c) => {
    const result = await searchUseCase(deps, {
      projectId: c.req.query('projectId') ?? '',
      query: c.req.query('q') ?? ''
    });
    return result.ok ? c.json(searchResponseSchema.parse({ hits: result.value })) : fail(c, result.error);
  });

  app.post('/api/tasks', async (c) => {
    const input = await body(c, createTaskRequest);
    if (!input.ok) return input.response;
    const result = await createTaskUseCase(deps, input.value);
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  app.patch('/api/tasks/:taskId/status', async (c) => {
    const input = await body(c, setTaskStatusRequest);
    if (!input.ok) return input.response;
    const status: TaskStatus = input.value.status;
    const result = await setTaskStatusUseCase(deps, asTaskId(c.req.param('taskId')), status);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.post('/api/sessions/derive', async (c) => {
    const input = await body(c, deriveSessionRequest);
    if (!input.ok) return input.response;
    const result = await deriveSessionUseCase(deps, input.value);
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  app.post('/api/sessions/fork', async (c) => {
    const input = await body(c, forkSessionRequest);
    if (!input.ok) return input.response;
    const result = await forkSessionUseCase(deps, input.value);
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  app.post('/api/sessions/:sessionId/prompt', async (c) => {
    const input = await body(c, promptRequest);
    if (!input.ok) return input.response;
    const result = await promptSessionUseCase(deps, { sessionId: c.req.param('sessionId'), text: input.value.text });
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  });

  /**
   * 改一项可调项（模型、思考强度……）。
   * 选项清单来自 agent，所以这里不校验 id 是否眼熟——只校验形状，
   * 真正认不认由 agent 说了算，它不认就会报错，然后我们什么都不写。
   */
  app.post('/api/sessions/:sessionId/options', async (c) => {
    const input = await body(c, changeOptionRequest);
    if (!input.ok) return input.response;
    const sessionId = c.req.param('sessionId');
    const changed = await changeSessionOption(deps, {
      sessionId,
      id: input.value.optionId,
      value: input.value.value
    });
    if (!changed.ok) return fail(c, changed.error);
    await options.waitOptions?.(sessionId);
    return c.json((await deps.sessions.byId(asSessionId(sessionId))) ?? changed.value);
  });

  app.post('/api/sessions/:sessionId/interrupt', async (c) => {
    const result = await interruptSessionUseCase(deps, c.req.param('sessionId'));
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  });

  app.get('/api/sessions/:sessionId/events', async (c) => {
    const after = Number(c.req.query('after') ?? 0);
    const sessionId = asSessionId(c.req.param('sessionId'));
    return c.json(await deps.sessions.eventsAfter(sessionId, Number.isFinite(after) ? after : 0));
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
