import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { Scalar } from '@scalar/hono-api-reference';
import type { ApiTokenDeps, Deps, JournalEntry, LogAuthor, Principal, TaskStatus } from '@agent-hub/domain';
import {
  ATTACHMENT_LIMITS,
  appendWorkLogUseCase,
  asProjectId,
  asSessionId,
  asTaskId,
  authenticateApiToken,
  authorizeProject,
  can,
  changeSessionOption,
  createProjectUseCase,
  createTaskUseCase,
  deleteProjectUseCase,
  deriveSessionUseCase,
  editWorkLogUseCase,
  forbidden,
  forkSessionUseCase,
  interruptSessionUseCase,
  invalid,
  isServiceAccount,
  listProjects,
  listWorkers,
  notFound,
  projectReader,
  promptSessionUseCase,
  setProjectDescriptionUseCase,
  setProjectRepoUseCase,
  setTaskStatusUseCase,
  setTaskSummaryUseCase,
  sweepTemporaryWorkspacesUseCase,
  workerReader,
  workspaceChangesUseCase
} from '@agent-hub/domain';
import type { DeleteProjectDeps } from '@agent-hub/domain';
import type { z } from 'zod';
import type { createProjectRequest, createTaskRequest, deriveSessionRequest, forkSessionRequest, setProjectDescriptionRequest, setProjectRepoRequest } from '@agent-hub/contract';
import { installAccess } from '../access.ts';
import { fail } from '../http-error.ts';
import { createRateLimiter } from '../rate-limit.ts';
import { recordSessionAction, refreshAuthors, sessionActivity } from '../session-activity.ts';
import type { SessionActivityOptions } from '../session-activity.ts';
import type { StreamHub } from '../stream-hub.ts';
import type { ProviderWiringApi } from '../providers.ts';
import { V1, routes } from './routes.ts';
import { handleMcp, INTERNAL } from './mcp.ts';

export interface OpenApiOptions {
  readonly tokens: Pick<ApiTokenDeps, 'apiTokens' | 'users' | 'tokens' | 'now'>;
  /** 每个令牌每分钟最多多少次请求 / 多少次 prompt；e2e 调小来验 429。 */
  readonly rate?: { readonly general?: number; readonly prompt?: number; readonly streams?: number };
}

interface V1Context {
  readonly deps: Deps;
  readonly hub: StreamHub;
  readonly activity?: SessionActivityOptions;
  readonly providers?: ProviderWiringApi;
  readonly projectDeletion?: Pick<DeleteProjectDeps, 'toolGrants' | 'audit'>;
  readonly waitOptions?: (sessionId: string) => Promise<void>;
}

type Env = { Variables: { principal: Principal }; Bindings: Record<string | symbol, unknown> };

const unauthorized = (c: Context) => {
  c.header('WWW-Authenticate', 'Bearer realm="agent-hub"');
  return c.json({ error: { code: 'unauthorized', message: '缺少或无效的 API 令牌（Authorization: Bearer ahp_…）' } }, 401);
};

/**
 * 开放 API v1（ADR 0014）：/openapi/v1/*，只认 API 令牌（不认 cookie，所以没有 CSRF 这回事）。
 * 授权与网页同一套：installAccess（换前缀）+ 领域 can()，令牌的权限范围在 can() 里与账号权限取交集。
 */
export function installOpenApi(app: Hono, options: OpenApiOptions, ctx: V1Context): void {
  const { deps, hub } = ctx;
  const now = options.tokens.now;
  const v1 = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) return fail(c, invalid(`请求不合法：${result.error.issues.map((i) => `${i.path.join('.') || '(body)'} ${i.message}`).join('；')}`));
    }
  });
  const principal = (c: Context): Principal => c.get('principal') as Principal;

  const general = createRateLimiter({ max: options.rate?.general ?? 120, windowMs: 60_000, now });
  const prompts = createRateLimiter({ max: options.rate?.prompt ?? 20, windowMs: 60_000, now });
  const maxStreams = options.rate?.streams ?? 5;
  const openStreams = new Map<string, number>();
  const tooMany = (c: Context, retry: number, message: string) => {
    c.header('Retry-After', String(retry));
    return c.json({ error: { code: 'rate_limited', message } }, 429);
  };

  const PUBLIC = new Set([`${V1}/openapi.json`, `${V1}/docs`, `${V1}/health`]);
  v1.use(`${V1}/*`, async (c, next) => {
    if (PUBLIC.has(c.req.path) && c.req.method === 'GET') return next();
    const header = c.req.header('authorization') ?? '';
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const actor = raw ? await authenticateApiToken(options.tokens, raw) : null;
    if (!actor || !actor.via) return unauthorized(c);
    c.set('principal', actor);
    // MCP 工具内部转调的请求已经在 /mcp 那一次计过数了
    if (c.env?.[INTERNAL] !== true) {
      const key = actor.via.tokenId;
      if (!general.hit(key)) return tooMany(c, general.retryAfter(key), '请求太频繁了，稍后再试');
    }
    if (/\/sessions\/[^/]+\/prompt$/.test(c.req.path) && c.req.method === 'POST') {
      const key = actor.via.tokenId;
      if (!prompts.hit(key)) return tooMany(c, prompts.retryAfter(key), '发得太频繁了，稍后再试');
    }
    return next();
  });
  installAccess(v1 as unknown as Hono, deps, (c) => (c.get('principal') as Principal | undefined) ?? null, V1);
  v1.use(
    `${V1}/sessions/:sessionId/prompt`,
    bodyLimit({ maxSize: Math.ceil((ATTACHMENT_LIMITS.totalBytes * 4) / 3) + 256 * 1024, onError: (c) => fail(c, invalid('附件合计太大')) as never })
  );

  v1.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
    description: '在「设置 → API 令牌」里创建；形如 `ahp_…`。'
  });

  // 处理函数只拿 Context；类型由路由表里的 schema 约束请求，响应由契约测试比对。
  const on = (r: (typeof routes)[keyof typeof routes], handler: (c: Context<Env>) => Promise<Response> | Response) =>
    v1.openapi(r as never, handler as never);
  const valid = <T>(c: Context, target: 'json' | 'query'): T => (c.req as unknown as { valid(t: string): T }).valid(target);

  on(routes.health, (c) => c.json({ ok: true }));
  on(routes.me, (c) => {
    const actor = principal(c);
    return c.json({
      user: { id: actor.user.id, name: actor.user.displayName, service: isServiceAccount(actor.user) },
      token: { id: actor.via!.tokenId, name: actor.via!.name, kind: actor.via!.kind }
    });
  });
  on(routes.listWorkers, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'worker.read')) return fail(c, forbidden('令牌没有 workers:read'));
    const readable = await workerReader(deps.access, actor);
    const workers = [];
    for (const worker of await listWorkers(deps)) if (await readable(worker.workerId)) workers.push(worker);
    return c.json(workers);
  });

  on(routes.listProjects, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.read')) return fail(c, forbidden('令牌没有 projects:read'));
    const result = await listProjects(deps);
    const readable = await projectReader(deps.access, actor);
    return result.ok ? c.json(result.value.filter(readable)) : fail(c, result.error);
  });
  on(routes.createProject, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.create')) return fail(c, forbidden('令牌不能新建项目（要 projects:write，且账号有建项目的权限）'));
    const result = await createProjectUseCase(deps, { ...valid<z.output<typeof createProjectRequest>>(c, 'json'), actor });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.setProjectRepo, async (c) => {
    const result = await setProjectRepoUseCase(deps, { projectId: c.req.param('projectId') ?? '', ...valid<z.output<typeof setProjectRepoRequest>>(c, 'json') });
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.setProjectDescription, async (c) => {
    const result = await setProjectDescriptionUseCase(deps, { projectId: c.req.param('projectId') ?? '', ...valid<z.output<typeof setProjectDescriptionRequest>>(c, 'json') });
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.deleteProject, async (c) => {
    if (!ctx.projectDeletion) return fail(c, { code: 'not_implemented', message: '没装删除项目' });
    const actor = principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const result = await deleteProjectUseCase({ ...deps, ...ctx.projectDeletion }, actor, {
      projectId: asProjectId(c.req.param('projectId') ?? ''),
      confirmName: valid<{ confirmName: string }>(c, 'json').confirmName
    });
    return result.ok ? c.json({ id: result.value.id, deleted: true }) : fail(c, result.error);
  });
  on(routes.workspaceChanges, async (c) => {
    const result = await workspaceChangesUseCase(deps, c.req.param('workspaceId') ?? '');
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  on(routes.listTasks, async (c) => {
    const actor = principal(c);
    const { projectId } = valid<{ projectId: string }>(c, 'query');
    const project = await deps.projects.byId(asProjectId(projectId));
    if (!project) return fail(c, notFound('项目不存在'));
    if (deps.access) {
      const allowed = await authorizeProject(deps.access, actor, project, 'task.read');
      if (!allowed.ok) return fail(c, allowed.error);
    } else if (!can(actor, 'task.read')) return fail(c, forbidden('令牌没有 projects:read'));
    return c.json(await deps.tasks.listByProject(project.id));
  });
  on(routes.createTask, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'task.write')) return fail(c, forbidden('令牌没有 projects:write'));
    const result = await createTaskUseCase(deps, { ...valid<z.output<typeof createTaskRequest>>(c, 'json'), ownerId: actor.user.id });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.getTask, async (c) => {
    const task = await deps.tasks.byId(asTaskId(c.req.param('taskId') ?? ''));
    if (!task) return fail(c, notFound('任务不存在'));
    return c.json({ ...task, sessions: await deps.sessions.listByTask(task.id) });
  });
  on(routes.setTaskStatus, async (c) => {
    const input = valid<{ status: TaskStatus; note?: string }>(c, 'json');
    const actor = principal(c);
    const result = await setTaskStatusUseCase(deps, asTaskId(c.req.param('taskId') ?? ''), input.status, 'user', input.note, {
      label: `${actor.user.displayName}（via ${actor.via?.name ?? '令牌'}）`
    });
    if (result.ok && (input.status === 'done' || input.status === 'abandoned')) {
      void sweepTemporaryWorkspacesUseCase(deps, { taskId: result.value.id }).catch(() => undefined);
    }
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.setTaskSummary, async (c) => {
    const result = await setTaskSummaryUseCase(deps, asTaskId(c.req.param('taskId') ?? ''), valid<{ summary: string }>(c, 'json').summary);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  const author = (c: Context): LogAuthor => {
    const actor = principal(c);
    return { kind: 'user', userId: actor.user.id, name: `${actor.user.displayName}（via ${actor.via?.name ?? '令牌'}）` };
  };
  on(routes.listTaskLog, async (c) => {
    const taskId = asTaskId(c.req.param('taskId') ?? '');
    if (!(await deps.tasks.byId(taskId))) return fail(c, notFound('任务不存在'));
    const query = valid<{ limit?: number; beforeSeq?: number }>(c, 'query');
    const limit = query.limit ?? 50;
    const entries = await deps.workLog.list(taskId, { limit, beforeSeq: query.beforeSeq });
    const last = entries.at(-1);
    return c.json({ entries, nextBeforeSeq: entries.length === limit && last ? last.seq : null });
  });
  on(routes.appendTaskLog, async (c) => {
    const input = valid<{ body: string; links?: never; sessionId?: string | null }>(c, 'json');
    const result = await appendWorkLogUseCase(deps, {
      taskId: asTaskId(c.req.param('taskId') ?? ''),
      author: author(c),
      body: input.body,
      links: input.links,
      sessionId: input.sessionId ? asSessionId(input.sessionId) : null
    });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.editTaskLog, async (c) => {
    const result = await editWorkLogUseCase(deps, { entryId: c.req.param('entryId') ?? '', body: valid<{ body: string }>(c, 'json').body, author: author(c) });
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  on(routes.startSession, async (c) => {
    const actor = principal(c);
    const input = valid<z.output<typeof deriveSessionRequest>>(c, 'json');
    if (!can(actor, 'session.create')) return fail(c, forbidden('令牌没有 sessions:write'));
    const allowed = await ctx.providers?.checkModel(actor, input.model, input.taskId);
    if (allowed && !allowed.ok) return fail(c, allowed.error);
    const result = await deriveSessionUseCase(deps, { ...input, actor });
    if (result.ok) await recordSessionAction(deps, ctx.activity, c, actor, 'session.start', result.value.id, '');
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.forkSession, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'session.create')) return fail(c, forbidden('令牌没有 sessions:write'));
    const input = valid<z.output<typeof forkSessionRequest>>(c, 'json');
    const result = await forkSessionUseCase(deps, { ...input, actor });
    if (result.ok) {
      await recordSessionAction(deps, ctx.activity, c, actor, 'session.fork', result.value.id, `从 ${input.sessionId} 分叉`);
      await recordSessionAction(deps, ctx.activity, c, actor, 'session.fork', input.sessionId, `分叉出 ${result.value.id}`);
    }
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.getSession, async (c) => {
    const session = await deps.sessions.byId(asSessionId(c.req.param('sessionId') ?? ''));
    return session ? c.json(session) : fail(c, notFound('会话不存在'));
  });
  on(routes.prompt, async (c) => {
    const actor = principal(c);
    const input = valid<{ text: string; attachments?: never }>(c, 'json');
    const result = await promptSessionUseCase(deps, {
      sessionId: c.req.param('sessionId') ?? '',
      text: input.text,
      attachments: input.attachments,
      author: { id: actor.user.id, name: actor.user.displayName, via: actor.via?.name }
    });
    return result.ok ? c.json({ ok: true }, 202) : fail(c, result.error);
  });
  on(routes.interrupt, async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const result = await interruptSessionUseCase(deps, sessionId);
    if (result.ok) await recordSessionAction(deps, ctx.activity, c, principal(c), 'session.interrupt', sessionId, '');
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  });
  on(routes.changeOption, async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const input = valid<{ optionId: string; value: string }>(c, 'json');
    if (ctx.providers) {
      const current = await deps.sessions.byId(asSessionId(sessionId));
      const allowed = ctx.providers.optionAllowed(current?.model ?? '', input.optionId, input.value);
      if (!allowed.ok) return fail(c, allowed.error);
    }
    const changed = await changeSessionOption(deps, { sessionId, id: input.optionId, value: input.value });
    if (!changed.ok) return fail(c, changed.error);
    await ctx.waitOptions?.(sessionId);
    return c.json((await deps.sessions.byId(asSessionId(sessionId))) ?? changed.value);
  });
  on(routes.events, async (c) => {
    const sessionId = asSessionId(c.req.param('sessionId') ?? '');
    if (!(await deps.sessions.byId(sessionId))) return fail(c, notFound('会话不存在'));
    return c.json(await refreshAuthors(ctx.activity, await deps.sessions.eventsAfter(sessionId, valid<{ after?: number }>(c, 'query').after ?? 0)));
  });
  on(routes.activity, async (c) => c.json(ctx.activity ? await sessionActivity(ctx.activity, c.req.param('sessionId') ?? '') : []));

  on(routes.stream, async (c) => {
    const actor = principal(c);
    const sessionId = asSessionId(c.req.param('sessionId') ?? '');
    if (!(await deps.sessions.byId(sessionId))) return fail(c, notFound('会话不存在'));
    const key = actor.via!.tokenId;
    const open = openStreams.get(key) ?? 0;
    if (open >= maxStreams) return tooMany(c, 5, `每个令牌最多同时开 ${maxStreams} 条事件流`);
    openStreams.set(key, open + 1);
    const fromHeader = Number(c.req.header('last-event-id') ?? NaN);
    const after = Number.isFinite(fromHeader) ? fromHeader : (valid<{ after?: number }>(c, 'query').after ?? 0);
    return streamSSE(
      c,
      async (stream) => {
        // 先订阅再补发，补发完再放出缓冲里更新的：不漏也不重。
        let sent = after;
        let replaying = true;
        const buffered: JournalEntry[] = [];
        const send = async (entry: JournalEntry) => {
          if (entry.seq <= sent) return;
          sent = entry.seq;
          await stream.writeSSE({ event: 'event', id: String(entry.seq), data: JSON.stringify(entry) });
        };
        const unsubscribe = hub.subscribe((frame) => {
          if (frame.sessionId !== sessionId) return;
          if (frame.event === null) {
            void stream.writeSSE({ event: 'status', data: JSON.stringify({ status: frame.status }) });
            return;
          }
          const entry: JournalEntry = { seq: frame.seq, event: frame.event, at: now() } as JournalEntry;
          if (replaying) buffered.push(entry);
          else void send(entry);
        });
        const ping = setInterval(() => void stream.write(': ping\n\n'), 15_000);
        try {
          for (const entry of await refreshAuthors(ctx.activity, await deps.sessions.eventsAfter(sessionId, after))) await send(entry);
          replaying = false;
          for (const entry of buffered.splice(0)) await send(entry);
          await new Promise<void>((resolve) => {
            if (c.req.raw.signal.aborted) resolve();
            c.req.raw.signal.addEventListener('abort', () => resolve());
            stream.onAbort(() => resolve());
          });
        } finally {
          clearInterval(ping);
          unsubscribe();
          openStreams.set(key, Math.max(0, (openStreams.get(key) ?? 1) - 1));
        }
      },
      async () => undefined
    );
  });

  // MCP（streamable HTTP，无状态）：工具 = 上面这些路由；同一个令牌、同一套权限。
  v1.post(`${V1}/mcp`, (c) => handleMcp(c, v1 as unknown as Hono));
  v1.on(['GET', 'DELETE'], `${V1}/mcp`, (c) => c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed（无状态，只收 POST）' }, id: null }, 405));

  v1.doc31(`${V1}/openapi.json`, openApiInfo);
  v1.get(`${V1}/docs`, Scalar({ url: `${V1}/openapi.json`, pageTitle: 'Agent Hub 开放 API', theme: 'default' }));

  app.route('/', v1 as unknown as Hono);
}

export const openApiInfo = {
  openapi: '3.1.0',
  info: {
    title: 'Agent Hub 开放 API',
    version: '1.0.0',
    description:
      '给内部 / 外部 agent 和脚本用的稳定接口（ADR 0014）。\n\n' +
      '- 认证：`Authorization: Bearer ahp_…`，令牌在「设置 → API 令牌」里创建，只显示一次。\n' +
      '- 权限 = 令牌的权限范围 ∩ 账号在团队里的权限；hub 本机的机器永远用不了。\n' +
      '- 限流：每个令牌每分钟 120 次请求、20 次 prompt，超了 429 + Retry-After。\n' +
      '- MCP：同一个令牌 POST `/openapi/v1/mcp`（streamable HTTP），工具与这里的接口一一对应。\n' +
      '- 错误统一为 `{ error: { code, message } }`。'
  },
  servers: [{ url: '/' }]
};

/** 给契约快照用：不起服务，直接生成规范。 */
export function buildSpecApp(): OpenAPIHono<Env> {
  const v1 = new OpenAPIHono<Env>();
  v1.openAPIRegistry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer', description: '在「设置 → API 令牌」里创建；形如 `ahp_…`。' });
  for (const r of Object.values(routes)) v1.openapi(r as never, (() => new Response()) as never);
  return v1;
}
