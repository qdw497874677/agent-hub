import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { sameSecret } from './request-guard.ts';
import type { RequestGuard } from './request-guard.ts';
import {
  changeOptionRequest,
  createProjectRequest,
  directoryListingSchema,
  makeDirectoryRequest,
  setProjectRepoRequest,
  setProjectDescriptionRequest,
  homeSchema,
  searchResponseSchema,
  createTaskRequest,
  deriveSessionRequest,
  createWorkspaceRequest,
  removeWorkspaceRequest,
  workspaceChangesSchema,
  workspaceSchema,
  workspaceViewSchema,
  forkSessionRequest,
  continueElsewhereRequest,
  projectFilesSchema,
  promptRequest,
  saveLayoutRequest,
  setTaskStatusRequest,
  setTaskSummaryRequest,
  appendLogRequest,
  editLogRequest,
  workLogPage,
  workerInfoSchema
} from '@agent-hub/contract';
import type { Deps, LogAuthor, Principal, TaskStatus } from '@agent-hub/domain';
import {
  authorizeProject,
  can,
  forbidden,
  projectOfRef,
  projectReader,
  workerReader,
  ATTACHMENT_LIMITS,
  asProjectId,
  asSessionId,
  asTaskId,
  appendWorkLogUseCase,
  editWorkLogUseCase,
  changeSessionOption,
  browseDirectories,
  createDirectory,
  createProjectUseCase,
  setProjectRepoUseCase,
  setProjectDescriptionUseCase,
  createTaskUseCase,
  deriveSessionUseCase,
  prepareLongLivedWorkspaceUseCase,
  prepareTemporaryWorkspaceUseCase,
  removeWorkspaceUseCase,
  sweepTemporaryWorkspacesUseCase,
  workspaceChangesUseCase,
  workspaceViewsUseCase,
  forkSessionUseCase,
  continueElsewhereUseCase,
  interruptSessionUseCase,
  listProjectFiles,
  listProjects,
  listWorkers,
  probeWorker,
  loadCanvas,
  loadHome,
  invalid,
  promptSessionUseCase,
  readSessionAttachment,
  saveLayoutUseCase,
  searchUseCase,
  setTaskStatusUseCase,
  setTaskSummaryUseCase
} from '@agent-hub/domain';
import type { StreamHub } from './stream-hub.ts';
import { installAuth, SSE_PATH } from './auth.ts';
import { installAdmin } from './admin.ts';
import { installTeam } from './team.ts';
import { installAssetRoutes, type AssetRouteOptions } from './assets.ts';
import { RELAY_PATH, type ProviderWiringApi } from './providers.ts';
import { installEnrollment } from './enrollment.ts';
import { installRuntimeInstall } from './runtime-install.ts';
import type { RuntimeInstallDeps } from '@agent-hub/domain';
import { installProjectDeletion } from './project-delete.ts';
import { installAccess } from './access.ts';
import type { DeleteProjectDeps } from '@agent-hub/domain';
import type { EnrollmentOptions } from './enrollment.ts';
import type { AdminOptions } from './admin.ts';
import { fail } from './http-error.ts';
import { recordSessionAction, refreshAuthors, refreshPreviewAuthors, sessionActivity } from './session-activity.ts';
import type { SessionActivityOptions } from './session-activity.ts';
import type { AuthOptions } from './auth.ts';

export interface AppOptions {
  readonly deps: Deps;
  readonly hub: StreamHub;
  readonly token: string | null;
  /** 账号体系；给了就用登录态守 /api/*，不给退回只认共享 token（单测、旧部署）。 */
  readonly auth?: AuthOptions;
  /** 运营后台；只在有账号体系时装（要靠登录态认出主人）。 */
  readonly admin?: AdminOptions;
  /** 资产中心（/api/admin/assets/*，主人专用）；要有 admin 才装。 */
  readonly assets?: AssetRouteOptions;
  /** 模型提供商（ADR 0013）：/api/providers 与经 hub 中转的 /provider-relay。 */
  readonly providers?: ProviderWiringApi;
  /** 单台机器接入（接入码、专属凭据、吊销、引导脚本）；同样只在有账号体系时装。 */
  readonly enrollment?: EnrollmentOptions;
  /** 在机器上装 / 卸 agent 运行时（ADR 0010）；只在有账号体系时装。 */
  readonly runtimeInstall?: RuntimeInstallDeps;
  /** 删除项目（要登录态记审计，所以同样只在有账号体系时装）。 */
  readonly projectDeletion?: Pick<DeleteProjectDeps, 'toolGrants' | 'audit'>;
  /** Host / Origin 检查；不给就不查（单测里直接打 app.request）。 */
  readonly guard?: RequestGuard;
  /** 会话里「谁做的」：操作审计 + 作者名刷新；只在有账号体系时装。 */
  readonly activity?: SessionActivityOptions;
  /**
   * 等 agent 回报它改完之后的可调项。
   *
   * 换模型会连带改变别的项，所以「改成功了」这句话只有 agent 有资格说；
   * 这里等它的全量回报，而不是把用户选的值直接当成结果显示出去。
   */
  readonly waitOptions?: (sessionId: string) => Promise<void>;
}

/** prompt 路由里 bodyLimit 之前认出的发送人。 */
const senders = new WeakMap<Context, Principal | null>();

const authorOf = (actor: Principal | null) =>
  actor ? { author: { id: actor.user.id, name: actor.user.displayName } } : {};

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

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
};

/** 附件只按扩展名认图片，其余一律当下载：不让上传的 html 在本站源下被渲染。 */
function mimeOf(path: string): string {
  return MIME_BY_EXT[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
}

export function createApp(options: AppOptions): Hono {
  const { deps, hub } = options;
  const app = new Hono();

  // 先于一切路由（包括静态页）：DNS 重绑定来的页面连 index.html 都不该拿到。
  // 只读请求不查 Origin（<img> 等跨站嵌入无害），会改东西的请求必须同站。
  app.use('*', async (c, next) => {
    const guard = options.guard;
    if (!guard) return next();
    const host = c.req.header('host');
    if (!guard.hostAllowed(host)) return c.text('Host 不在允许列表里（见 HUB_ALLOWED_HOSTS）', 403);
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !guard.originAllowed(c.req.header('origin'), host)) {
      return c.json({ error: { code: 'forbidden', message: '跨站请求被拒绝' } }, 403);
    }
    return next();
  });

  // 经 hub 中转的模型请求：不在 /api 下，凭句柄 + 令牌认（worker 发的请求不带 Origin）。
  if (options.providers) {
    const providers = options.providers;
    app.all(`${RELAY_PATH}/:handle/*`, (c) => providers.relay(c));
  }

  // token 只在绑非 loopback 时才是必需的；main.ts 保证那种情况下一旦没配就不启动。
  let principalOf: (c: Context) => Principal | null = () => null;
  if (options.auth) {
    principalOf = installAuth(app, options.auth);
    // 授权中间件要先于下面所有路由注册（Hono 按注册顺序走）。
    installAccess(app, deps, principalOf);
    if (options.admin) installAdmin(app, options.admin, principalOf);
    if (options.auth.team) installTeam(app, options.auth.team, principalOf);
    if (options.admin && options.assets) installAssetRoutes(app, options.assets, principalOf);
    if (options.enrollment) installEnrollment(app, options.enrollment, principalOf);
    if (options.runtimeInstall) installRuntimeInstall(app, options.runtimeInstall, principalOf);
    if (options.projectDeletion) installProjectDeletion(app, { ...deps, ...options.projectDeletion }, principalOf);
  }
  app.use('/api/*', async (c, next) => {
    if (options.auth || options.token === null) return next();
    // header 优先；SSE（EventSource）设不了请求头，所以也接受查询串。
    const offered = (c.req.header('authorization') ?? '') === `Bearer ${options.token}`
      ? options.token
      : c.req.path === SSE_PATH
        ? (c.req.query('token') ?? '')
        : '';
    if (!sameSecret(offered, options.token)) {
      return c.json({ error: { code: 'unauthorized', message: '缺少或错误的 token' } }, 401); // 不是领域错误，所以不走 fail()
    }
    return next();
  });

  app.get('/api/health', (c) => c.json({ ok: true }));
  options.providers?.install(app, principalOf);

  app.get('/api/home', async (c) =>
    c.json(homeSchema.parse(await loadHome(deps, undefined, await projectReader(deps.access, principalOf(c)))))
  );

  // 目录选择器（S2.1）：让人从真实目录里挑，而不是手打一个可能会错的路径。
  // 多机：带 workerId 就去那台 Worker 上浏览（经 WebSocket 问它），不带就是 Server 本机。
  app.get('/api/fs/directories', async (c) => {
    const requested = c.req.query('path') ?? '';
    const workerId = c.req.query('workerId') ?? '';
    const result = await browseDirectories(deps, {
      workerId: workerId === '' ? null : workerId,
      path: requested === '' ? '' : requested.startsWith('/') ? requested : resolve(requested),
      home: homedir(),
      project: c.req.query('project') ?? ''
    });
    return result.ok ? c.json(directoryListingSchema.parse(result.value)) : fail(c, result.error);
  });

  // 目录选择器里的「新建文件夹」：只建一层，只能建在那台机器的 roots 里（realpath 校验，软链接逃逸算外面）。
  app.post('/api/fs/directories', async (c) => {
    const input = await body(c, makeDirectoryRequest);
    if (!input.ok) return input.response;
    const result = await createDirectory(deps, { ...input.value, home: homedir() });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  // `@` 引用选择器：项目里的文件，按名字模糊匹配。
  app.get('/api/projects/:projectId/files', async (c) => {
    const sessionId = c.req.query('sessionId');
    const result = await listProjectFiles(
      deps,
      asProjectId(c.req.param('projectId')),
      c.req.query('q') ?? '',
      sessionId ? asSessionId(sessionId) : undefined
    );
    return result.ok ? c.json(projectFilesSchema.parse(result.value)) : fail(c, result.error);
  });

  app.get('/api/workers', async (c) => {
    const readable = await workerReader(deps.access, principalOf(c));
    const workers = [];
    for (const worker of await listWorkers(deps)) if (await readable(worker.workerId)) workers.push(worker);
    return c.json(workerInfoSchema.array().parse(workers));
  });
  // 「重新检测」：只发指令，结果经 Worker 的 agent 清单异步回来，界面过一会儿再拉 /api/workers。
  app.post('/api/workers/:id/probe', async (c) => {
    const result = await probeWorker(deps, c.req.param('id'));
    return result.ok ? c.json({ ok: true }, 202) : fail(c, result.error);
  });

  app.get('/api/projects', async (c) => {
    const result = await listProjects(deps);
    const readable = await projectReader(deps.access, principalOf(c));
    return result.ok ? c.json(result.value.filter(readable)) : fail(c, result.error);
  });

  app.post('/api/projects', async (c) => {
    const input = await body(c, createProjectRequest);
    if (!input.ok) return input.response;
    const actor = principalOf(c);
    if (actor && !can(actor, 'project.create')) return fail(c, forbidden('你没有权限新建项目'));
    const result = await createProjectUseCase(deps, { ...input.value, actor });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  // 绑定 / 改 / 解除项目仓库：只影响以后新建的工作空间。
  app.put('/api/projects/:projectId/repo', async (c) => {
    const input = await body(c, setProjectRepoRequest);
    if (!input.ok) return input.response;
    const result = await setProjectRepoUseCase(deps, { projectId: c.req.param('projectId'), ...input.value });
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  // 改项目说明（项目设置）
  app.put('/api/projects/:projectId/description', async (c) => {
    const input = await body(c, setProjectDescriptionRequest);
    if (!input.ok) return input.response;
    const result = await setProjectDescriptionUseCase(deps, { projectId: c.req.param('projectId'), ...input.value });
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  // 运行面板：项目名下的工作空间 + 谁正在里面跑（并发警告）。
  app.get('/api/projects/:projectId/workspaces', async (c) => {
    const result = await workspaceViewsUseCase(deps, c.req.param('projectId'));
    return result.ok ? c.json(workspaceViewSchema.array().parse(result.value)) : fail(c, result.error);
  });

  // 新建持久工作空间：新建托管目录（create）或关联已有目录（link）。
  app.post('/api/projects/:projectId/workspaces', async (c) => {
    const input = await body(c, createWorkspaceRequest);
    if (!input.ok) return input.response;
    const request = input.value;
    const result =
      request.kind === 'temporary'
        ? await prepareTemporaryWorkspaceUseCase(deps, {
            projectId: c.req.param('projectId'),
            taskId: request.taskId,
            workerId: request.workerId,
            home: homedir(),
            actor: principalOf(c)
          })
        : await prepareLongLivedWorkspaceUseCase(deps, {
            projectId: c.req.param('projectId'),
            workerId: request.workerId,
            plan: request.mode === 'link' ? { mode: 'link', path: request.path ?? '' } : request.path?.trim() ? { mode: 'create', path: request.path } : { mode: 'create' },
            home: homedir(),
            actor: principalOf(c)
          });
    return result.ok ? c.json(workspaceSchema.parse(result.value), 201) : fail(c, result.error);
  });

  // 删之前看看会丢什么（强制删除的二次确认里列出来）
  app.get('/api/workspaces/:workspaceId/changes', async (c) => {
    const result = await workspaceChangesUseCase(deps, c.req.param('workspaceId'));
    return result.ok ? c.json(workspaceChangesSchema.parse(result.value)) : fail(c, result.error);
  });

  // 移除工作空间：只移除登记 / 连目录一起删（平台建的才行）/ 强制删除
  app.post('/api/workspaces/:workspaceId/remove', async (c) => {
    const input = await body(c, removeWorkspaceRequest);
    if (!input.ok) return input.response;
    const result = await removeWorkspaceUseCase(deps, { workspaceId: c.req.param('workspaceId'), ...input.value });
    return result.ok ? c.json(workspaceSchema.parse(result.value)) : fail(c, result.error);
  });

  // 立刻清理一次（项目设置里「重新检查」）
  app.post('/api/workspaces/sweep', async (c) => c.json(await sweepTemporaryWorkspacesUseCase(deps)));

  app.get('/api/projects/:projectId/canvas', async (c) => {
    const result = await loadCanvas(deps, c.req.param('projectId'));
    if (!result.ok) return fail(c, result.error);
    return c.json({ ...result.value, previews: await refreshPreviewAuthors(options.activity, result.value.previews) });
  });

  app.put('/api/projects/:projectId/layout', async (c) => {
    const input = await body(c, saveLayoutRequest);
    if (!input.ok) return input.response;
    return c.json(await saveLayoutUseCase(deps, c.req.param('projectId'), input.value));
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
    const result = await createTaskUseCase(deps, { ...input.value, ownerId: principalOf(c)?.user.id ?? null });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  // 工作日志：倒序分页；人写的 author 由服务端按登录身份填，客户端不能冒名。
  const userAuthor = (c: Context): LogAuthor => {
    const principal = principalOf(c);
    return { kind: 'user', userId: principal?.user.id ?? null, name: principal?.user.displayName ?? null };
  };

  app.get('/api/tasks/:taskId/log', async (c) => {
    const taskId = asTaskId(c.req.param('taskId'));
    if (!(await deps.tasks.byId(taskId))) return fail(c, { code: 'not_found', message: '任务不存在' });
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
    const before = c.req.query('beforeSeq');
    const entries = await deps.workLog.list(taskId, {
      limit,
      beforeSeq: before ? Number(before) : undefined,
      includeSuperseded: c.req.query('history') === '1'
    });
    const last = entries.at(-1);
    return c.json(workLogPage.parse({ entries, nextBeforeSeq: entries.length === limit && last ? last.seq : null }));
  });

  app.post('/api/tasks/:taskId/log', async (c) => {
    const input = await body(c, appendLogRequest);
    if (!input.ok) return input.response;
    const result = await appendWorkLogUseCase(deps, {
      taskId: asTaskId(c.req.param('taskId')),
      author: userAuthor(c),
      body: input.value.body,
      links: input.value.links,
      sessionId: input.value.sessionId ? asSessionId(input.value.sessionId) : null
    });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  app.patch('/api/tasks/:taskId/log/:entryId', async (c) => {
    const input = await body(c, editLogRequest);
    if (!input.ok) return input.response;
    const result = await editWorkLogUseCase(deps, { entryId: c.req.param('entryId'), body: input.value.body, author: userAuthor(c) });
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.patch('/api/tasks/:taskId/summary', async (c) => {
    const input = await body(c, setTaskSummaryRequest);
    if (!input.ok) return input.response;
    const result = await setTaskSummaryUseCase(deps, asTaskId(c.req.param('taskId')), input.value.summary);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.patch('/api/tasks/:taskId/status', async (c) => {
    const input = await body(c, setTaskStatusRequest);
    if (!input.ok) return input.response;
    const status: TaskStatus = input.value.status;
    const result = await setTaskStatusUseCase(deps, asTaskId(c.req.param('taskId')), status, 'user', input.value.note, {
      label: principalOf(c)?.user.displayName ?? ''
    });
    // 任务结束：顺手清理它的临时工作空间（不等结果；有改动的会标「已保留」）
    if (result.ok && (status === 'done' || status === 'abandoned')) {
      void sweepTemporaryWorkspacesUseCase(deps, { taskId: result.value.id }).catch(() => undefined);
    }
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.post('/api/sessions/derive', async (c) => {
    const input = await body(c, deriveSessionRequest);
    if (!input.ok) return input.response;
    const actor = principalOf(c);
    const allowed = await options.providers?.checkModel(actor, input.value.model, input.value.taskId);
    if (allowed && !allowed.ok) return fail(c, allowed.error);
    const result = await deriveSessionUseCase(deps, { ...input.value, actor });
    if (result.ok) await recordSessionAction(deps, options.activity, c, actor, 'session.start', result.value.id, '');
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  app.post('/api/sessions/fork', async (c) => {
    const input = await body(c, forkSessionRequest);
    if (!input.ok) return input.response;
    const actor = principalOf(c);
    const result = await forkSessionUseCase(deps, { ...input.value, actor });
    if (result.ok) {
      const origin = result.value.origin;
      const at = origin.kind === 'fork' ? ` #${origin.atSeq}` : '';
      await recordSessionAction(deps, options.activity, c, actor, 'session.fork', result.value.id, `从 ${input.value.sessionId}${at} 分叉`);
      await recordSessionAction(deps, options.activity, c, actor, 'session.fork', input.value.sessionId, `分叉出 ${result.value.id}`);
    }
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  // 换台机器继续：在目标 Worker 上开一条带交接摘要的分叉会话
  app.post('/api/sessions/:sessionId/continue', async (c) => {
    const input = await body(c, continueElsewhereRequest);
    if (!input.ok) return input.response;
    const actor = principalOf(c);
    const from = c.req.param('sessionId');
    const result = await continueElsewhereUseCase(deps, { sessionId: from, ...input.value, home: homedir(), actor });
    if (result.ok) {
      await recordSessionAction(deps, options.activity, c, actor, 'session.continue', result.value.id, `接着 ${from} 换机继续`);
      await recordSessionAction(deps, options.activity, c, actor, 'session.continue', from, `换到 ${result.value.id} 继续`);
    }
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  app.post(
    '/api/sessions/:sessionId/prompt',
    // 登录态按原始 Request 记着；bodyLimit 会换掉 c.req.raw，所以先把发送人拿出来
    async (c, next) => {
      senders.set(c, principalOf(c));
      await next();
    },
    // base64 比原始字节大三分之一，再留一点给 JSON 外壳。真正的逐项校验在 domain。
    bodyLimit({
      maxSize: Math.ceil((ATTACHMENT_LIMITS.totalBytes * 4) / 3) + 256 * 1024,
      onError: (c) => fail(c, invalid('附件合计太大')) as never
    }),
    async (c) => {
    const input = await body(c, promptRequest);
    if (!input.ok) return input.response;
    const result = await promptSessionUseCase(deps, {
      sessionId: c.req.param('sessionId'),
      text: input.value.text,
      attachments: input.value.attachments,
      ...authorOf(senders.get(c) ?? null)
    });
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  }
  );

  // 专注对话里的附件缩略图：只放行这条会话自己的附件目录。
  app.get('/api/sessions/:sessionId/attachment', async (c) => {
    const path = c.req.query('path') ?? '';
    const result = await readSessionAttachment(deps, asSessionId(c.req.param('sessionId')), path);
    if (!result.ok) return fail(c, result.error);
    return new Response(result.value, {
      headers: {
        'content-type': mimeOf(path),
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"
      }
    });
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
    if (options.providers) {
      const current = await deps.sessions.byId(asSessionId(sessionId));
      const allowed = options.providers.optionAllowed(current?.model ?? '', input.value.optionId, input.value.value);
      if (!allowed.ok) return fail(c, allowed.error);
    }
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
    if (result.ok) await recordSessionAction(deps, options.activity, c, principalOf(c), 'session.interrupt', c.req.param('sessionId'), '');
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  });

  app.get('/api/sessions/:sessionId/events', async (c) => {
    const after = Number(c.req.query('after') ?? 0);
    const sessionId = asSessionId(c.req.param('sessionId'));
    return c.json(await refreshAuthors(options.activity, await deps.sessions.eventsAfter(sessionId, Number.isFinite(after) ? after : 0)));
  });

  // 会话详情里的「谁做了什么」：开、分叉、停、换机继续
  app.get('/api/sessions/:sessionId/activity', async (c) =>
    c.json(options.activity ? await sessionActivity(options.activity, c.req.param('sessionId')) : [])
  );

  /** SSE：一条连接推所有会话的事件，前端按 sessionId 分流。 */
  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      // 只推这个人看得见的会话（ADR 0011）。每条会话判一次就记住；看不见的帧直接丢。
      const actor = principalOf(c);
      const seen = new Map<string, Promise<boolean>>();
      const visibleSession = (sessionId: string): Promise<boolean> => {
        if (!deps.access || actor === null) return Promise.resolve(true);
        let known = seen.get(sessionId);
        if (!known) {
          known = projectOfRef(deps, { kind: 'session', id: sessionId }).then(async ({ project }) =>
            (await authorizeProject(deps.access, actor, project, 'session.read')).ok
          );
          seen.set(sessionId, known);
        }
        return known;
      };
      const unsubscribe = hub.subscribe((frame) => {
        void visibleSession(frame.sessionId).then((ok) => {
          if (ok) void stream.writeSSE({ event: 'frame', data: JSON.stringify(frame) });
        });
      });
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => resolve());
      });
      unsubscribe();
    })
  );

  return app;
}
