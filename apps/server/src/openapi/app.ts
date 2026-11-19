import { OpenAPIHono } from '@hono/zod-openapi';
import { applyStartExtras, checkStartExtras } from '../session-start-extras.ts';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { homedir } from 'node:os';
import { streamSSE } from 'hono/streaming';
import { Scalar } from '@scalar/hono-api-reference';
import type { ApiTokenDeps, Deps, GitWorkflowService, JournalEntry, LogAuthor, Principal, TaskStatus, WorkspaceFilesService } from '@agent-hub/domain';
import {
  ATTACHMENT_LIMITS,
  appendWorkLogUseCase,
  asProjectId,
  asSessionId,
  asTaskId,
  asWorkspaceId,
  authenticateApiToken,
  authorizeProject,
  authorizeSession,
  authorizeWorkspace,
  authorizeWorker,
  can,
  changeSessionOption,
  switchSessionModel,
  projectOfSession,
  conflict,
  createProjectUseCase,
  createTaskUseCase,
  deleteProjectUseCase,
  submitAssetRevision,
  defaultWorkspaceFor,
  deriveSessionUseCase,
  editWorkLogUseCase,
  forbidden,
  forkSessionUseCase,
  importGitAsset,
  interruptSessionUseCase,
  invalid,
  isServiceAccount,
  listProjects,
  assetRevisions,
  pinAssetRevision,
  recordAssetAudit,
  setAssetInstalled,
  uploadAsset,
  listWorkers,
  notFound,
  authorizeAssetProject,
  authorizeAssetPublish,
  projectReader,
  promptSessionUseCase,
  setProjectChecksUseCase,
  setProjectDescriptionUseCase,
  setProjectDefaultAgentUseCase,
  setTaskDefaultAgentUseCase,
  resolveDefaultAgent,
  viewAgentDefaults,
  setAgentDefaults,
  newId,
  updateProjectReposUseCase,
  setProjectRepoUseCase,
  setTaskStatusUseCase,
  setTaskSummaryUseCase,
  sweepTemporaryWorkspacesUseCase,
  syncWorkspaceReposUseCase,
  deleteWorkspaceUseCase,
  retryWorkspaceSetupUseCase,
  addWorkspaceGroupMemberUseCase,
  buildWorkspaceGroupUseCase,
  retryWorkspaceGroupUseCase,
  settleSessionUseCase,
  sweepProjectUseCase,
  cleanupRecordsUseCase,
  asWorkspaceGroupId,
  unavailable,
  prepareTemporaryWorkspaceUseCase,
  prepareLongLivedWorkspaceUseCase,
  workerReader,
  redactInventory,
  workspaceChangesUseCase,
  assetViewOf,
  scopedTokenCreateDenied,
  listProviders,
  createProvider,
  listApiTokens,
  createApiToken,
  rotateApiToken,
  revokeApiToken,
  setWorkerProviderRouting,
  hubModelId,
  canManageProvider,
  canSeeProvider,
  providerActor
} from '@agent-hub/domain';

import type { AssetReviewDeps, DeleteProjectDeps, MessageBus, MessageStore } from '@agent-hub/domain';
import { linkSessionsUseCase, unlinkSessionsUseCase, messageView } from '@agent-hub/domain';
import type { z } from 'zod';
import { assetSchema, sessionSchema, workspaceSchema } from '@agent-hub/contract';
import { createIdempotency } from './idempotency.ts';
import type { createProjectRequest, createTaskRequest, deriveSessionRequest, forkSessionRequest, setProjectDescriptionRequest, setProjectRepoRequest, setProjectReposRequest } from '@agent-hub/contract';
import { installAccess } from '../access.ts';
import { fail } from '../http-error.ts';
import { createRateLimiter } from '../rate-limit.ts';
import { noteProvenance, recordSessionAction, refreshAuthors, sessionActivity } from '../session-activity.ts';
import type { SessionActivityOptions } from '../session-activity.ts';
import type { StreamHub } from '../stream-hub.ts';
import { publicProvider, type ProviderWiringApi } from '../providers.ts';
import { V1, routes } from './routes.ts';
import { workbenchSkillManifest, workbenchSkillZip } from '../workbench-skill.ts';
import { createAssetVisibility } from '../asset-visibility.ts';
import { effectiveWrites, handleMcp, INTERNAL } from './mcp.ts';
import { workspaceForApiStart } from '../session-workspace.ts';
import { projectDto } from '../project-dto.ts';
import { isProjectableEntry, lastJournalSeq, projectEvents } from './projection.ts';
import { attachHubModelsToWorker, collectSessionModels } from './session-models.ts';

export interface OpenApiOptions {
  readonly tokens: Pick<ApiTokenDeps, 'apiTokens' | 'users' | 'tokens' | 'now'> & Partial<Pick<ApiTokenDeps, 'projects'>>;
  /** 每个令牌每分钟最多多少次请求 / 多少次 prompt；e2e 调小来验 429。 */
  readonly rate?: { readonly general?: number; readonly prompt?: number; readonly streams?: number };
  /** 对外 MCP 写工具的幂等回放（E4b）；不给就只有只读工具（写工具默认仍按令牌权限暴露）。 */
  readonly replays?: import('@agent-hub/domain').McpReplayStore;
  /** hub 设置：外部接入页的写工具开关（mcpWrites）从这里读。 */
  readonly settings?: { get(): Promise<import('@agent-hub/domain').HubSettings>; save(next: import('@agent-hub/domain').HubSettings): Promise<void> };
  /** MCP 调用记录（mcp.call）写到这里。 */
  readonly audit?: Pick<import('@agent-hub/domain').AuditLog, 'append'>;
  /** 团队目录：读/写团队运行时默认模型要用。不给则这两条路由 503。 */
  readonly teams?: import('@agent-hub/domain').TeamRepository;
}

interface V1Context {
  readonly deps: Deps;
  readonly hub: StreamHub;
  readonly activity?: SessionActivityOptions;
  readonly providers?: ProviderWiringApi;
  readonly projectDeletion?: Pick<DeleteProjectDeps, 'toolGrants' | 'audit'>;
  readonly waitOptions?: (sessionId: string) => Promise<void>;
  // 资产审核（ADR 0016）：令牌默认只能交新版本（assets:submit）；显式给 assets:publish 才能发布 / 分配。
  readonly assetReview?: AssetReviewDeps;
  readonly git?: GitWorkflowService;
  /** 开放 API 的两个只读工具（workspace_diff / workspace_read_file）走工作空间文件服务；不给 = 503。 */
  readonly files?: WorkspaceFilesService;
  /** 会话通信 P1d：外部 agent 经消息总线发 send / ask、收回复。不给 = 这几条路由 501。 */
  readonly messaging?: { readonly bus: MessageBus; readonly messages?: MessageStore };
}

type Env = { Variables: { principal: Principal }; Bindings: Record<string | symbol, unknown> };

const unauthorized = (c: Context) => {
  c.header('WWW-Authenticate', 'Bearer realm="agent-hub"');
  return c.json({ error: { code: 'unauthorized', message: '缺少或无效的 API 令牌（Authorization: Bearer ahp_…）' } }, 401);
};

/**
 * 开放 API v1（ADR 0015）：/openapi/v1/*，只认 API 令牌（不认 cookie，所以没有 CSRF 这回事）。
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
  /** 审计里标出「经哪个令牌做的」：自动化发布 / 分配要能追到令牌。 */
  const viaNote = (actor: Principal): string => (actor.via ? `（经令牌 ${actor.via.name} / ${actor.via.tokenId}）` : '');
  const projectLimited = (actor: Principal): boolean => (actor.via?.projectIds?.length ?? 0) > 0;
  const auditDefaultAgent = async (
    actor: Principal,
    target: string,
    agent: { readonly runtime: string; readonly model: string } | null
  ): Promise<void> => {
    if (!options.audit) return;
    const detail = agent === null ? '清空默认 Agent' : `默认 Agent：${agent.runtime} · ${agent.model === '' ? '运行时默认模型' : agent.model}`;
    await options.audit.append({
      id: newId(),
      actorId: actor.user.id,
      actorEmail: actor.user.email,
      action: 'project.worktree',
      target,
      detail: `${detail}${viaNote(actor)}`,
      at: now(),
      ip: null,
      teamId: actor.user.teamId ?? null
    });
  };
  const teamDefaultsDeps = () => {
    if (!options.teams || !deps.agentDefaults) return null;
    return { teams: options.teams, agentDefaults: deps.agentDefaults };
  };

  const general = createRateLimiter({ max: options.rate?.general ?? 120, windowMs: 60_000, now });
  const prompts = createRateLimiter({ max: options.rate?.prompt ?? 20, windowMs: 60_000, now });
  const maxStreams = options.rate?.streams ?? 5;
  const openStreams = new Map<string, number>();
  const tooMany = (c: Context, retry: number, message: string) => {
    c.header('Retry-After', String(retry));
    return c.json({ error: { code: 'rate_limited', message } }, 429);
  };

  const PUBLIC = new Set([`${V1}/openapi.json`, `${V1}/docs`, `${V1}/health`, `${V1}/skills/agent-hub-workbench`]);
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
  // 写请求的幂等重试：MCP 的 clientRequestId 与 REST 的 Idempotency-Key 走同一张表（24h）。
  v1.use(`${V1}/*`, createIdempotency({ store: options.replays }).handle);
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
  on(routes.workbenchSkill, (c) => {
    if (c.req.query('format') === 'json') return c.json(workbenchSkillManifest());
    const zip = workbenchSkillZip();
    return new Response(Buffer.from(zip), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="agent-hub-workbench.zip"'
      }
    });
  });
  on(routes.listAssets, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'asset.read')) return fail(c, forbidden('令牌没有 assets:read'));
    if (!ctx.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
    const kind = c.req.query('kind');
    const readable = createAssetVisibility({ access: deps.access, projects: deps.projects }, actor);
    const all = await ctx.assetReview.assets.list();
    const visible = [];
    for (const asset of all) {
      if (kind !== undefined && asset.kind !== kind) continue;
      if (await readable(asset)) visible.push(asset);
    }
    return c.json(visible);
  });
  on(routes.getAsset, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'asset.read')) return fail(c, forbidden('令牌没有 assets:read'));
    if (!ctx.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
    const asset = await ctx.assetReview.assets.get(c.req.param('assetId') ?? '');
    if (!asset) return fail(c, notFound('资产不存在'));
    const readable = createAssetVisibility({ access: deps.access, projects: deps.projects }, actor);
    if (!(await readable(asset))) return fail(c, notFound('资产不存在'));
    const revisions = await assetRevisions(ctx.assetReview, asset.id);
    if (!revisions.ok) return fail(c, revisions.error);
    return c.json({ asset, revisions: revisions.value });
  });
  on(routes.createAsset, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'asset.submit') || !can(actor, 'asset.read')) return fail(c, forbidden('令牌没有 assets:write'));
    if (!ctx.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
    const input = valid<{
      kind: 'skill' | 'instruction' | 'mcp';
      name?: string | null;
      scope: 'personal' | 'team' | 'project';
      projectId?: string | null;
      publish: boolean;
      files: { path: string; data: string }[];
    }>(c, 'json');
    // 直接发布是 assets:publish 的事：只有它映射了 asset.review，其余 scope 都发不了
    if (input.publish && !can(actor, 'asset.review')) return fail(c, forbidden('直接发布资产要 assets:publish 范围'));
    const scopedDenied = scopedTokenCreateDenied(actor, input.scope);
    if (scopedDenied) return fail(c, forbidden(scopedDenied));
    if (input.scope === 'project') {
      const allowed = await authorizeAssetProject(ctx.assetReview, actor, input.projectId ?? null);
      if (!allowed.ok) return fail(c, allowed.error);
    }
    const files = input.files.map((file) => ({ path: file.path, data: new Uint8Array(Buffer.from(file.data, 'base64')) }));
    const made = await uploadAsset(ctx.assetReview, {
      kind: input.kind,
      name: input.name ?? null,
      projectId: input.scope === 'project' ? input.projectId ?? null : null,
      files,
      scope: input.scope,
      ownerId: actor.user.id,
      teamId: actor.user.teamId ?? null,
      publish: input.publish
    });
    return made.ok ? c.json(made.value, 201) : fail(c, made.error);
  });
  on(routes.importAsset, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'asset.submit') || !can(actor, 'asset.read')) return fail(c, forbidden('令牌没有 assets:write'));
    if (!ctx.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
    const input = valid<{
      kind: 'skill' | 'instruction' | 'mcp';
      url: string;
      ref?: string | null;
      path?: string;
      name?: string | null;
      scope: 'personal' | 'team' | 'project';
      projectId?: string | null;
      publish: boolean;
      policy?: 'track' | 'locked';
      credential?: string;
    }>(c, 'json');
    if (input.publish && !can(actor, 'asset.review')) return fail(c, forbidden('直接发布资产要 assets:publish 范围'));
    // 空路径对 skill 会变成「整个仓库」：显式拒绝，别让人把整仓拖进来
    const path = (input.path ?? '').trim();
    if (path === '') return fail(c, invalid('要给出仓库里的路径：技能目录（如 skills/foo）、指令文件（如 AGENTS.md）或 mcp 文件'));
    const scopedDenied = scopedTokenCreateDenied(actor, input.scope);
    if (scopedDenied) return fail(c, forbidden(scopedDenied));
    if (input.scope === 'project') {
      const allowed = await authorizeAssetProject(ctx.assetReview, actor, input.projectId ?? null);
      if (!allowed.ok) return fail(c, allowed.error);
    }
    const made = await importGitAsset(ctx.assetReview, {
      kind: input.kind,
      url: input.url,
      ref: input.ref ?? null,
      policy: input.policy,
      credential: input.credential ?? null,
      path,
      name: input.name ?? null,
      projectId: input.scope === 'project' ? input.projectId ?? null : null,
      scope: input.scope,
      ownerId: actor.user.id,
      teamId: actor.user.teamId ?? null,
      publish: input.publish
    });
    if (!made.ok) return fail(c, made.error);
    await recordAssetAudit(ctx.assetReview, actor, 'asset.create', made.value.name, `${made.value.kind} 从 ${input.url}@${path} 导入${made.value.pinned === '' ? '（待审核）' : '并发布'}${viaNote(actor)}`);
    // 对外用列表同款视图（`workerIds`/`files`/`bytes`）；`tokenSecret` 是内部指针，不在契约里，parse 时被 strip。
    return c.json(assetSchema.parse(await assetViewOf(ctx.assetReview, made.value)), 201);
  });
  on(routes.publishAsset, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'asset.review')) return fail(c, forbidden('令牌没有 assets:publish：不能发布资产'));
    if (!ctx.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
    const asset = await ctx.assetReview.assets.get(c.req.param('assetId') ?? '');
    if (!asset) return fail(c, notFound('资产不存在'));
    // 项目级资产（#230）：同团队但不是项目成员的令牌不能借 assets:publish 发布别人的项目资产。
    // 这一步放在可见性之前：项目成员才有 project.read，非成员在可见性那层只会得到 404；
    // 跨团队的仍按 404，别泄露资产存在。成员走下面的正常可见性 / 版本校验。
    if (asset.scope === 'project') {
      const allowed = await authorizeAssetPublish(ctx.assetReview, actor, asset);
      if (!allowed.ok) return fail(c, allowed.error);
    }
    const readable = createAssetVisibility({ access: deps.access, projects: deps.projects }, actor);
    if (!(await readable(asset))) return fail(c, notFound('资产不存在'));
    if (asset.scope === 'global' && !actor.user.clusterAdmin) return fail(c, forbidden('只有集群管理员能发布全局资产'));
    if (asset.latest === '' || asset.latest === asset.pinned) return fail(c, conflict('没有待发布的新版本：latest 已经是线上版本'));
    const published = await pinAssetRevision(ctx.assetReview, asset.id, asset.latest);
    if (!published.ok) return fail(c, published.error);
    const next = published.value;
    await recordAssetAudit(ctx.assetReview, actor, 'asset.publish', next.name, `${next.kind} ${next.scope} 发布 ${next.pinned.slice(0, 12)}${viaNote(actor)}`);
    return c.json(assetSchema.parse(await assetViewOf(ctx.assetReview, next)));
  });
  on(routes.assignAsset, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'asset.assign')) return fail(c, forbidden('令牌没有 assets:publish：不能分配资产'));
    if (!ctx.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
    const asset = await ctx.assetReview.assets.get(c.req.param('assetId') ?? '');
    if (!asset) return fail(c, notFound('资产不存在'));
    const readable = createAssetVisibility({ access: deps.access, projects: deps.projects }, actor);
    if (!(await readable(asset))) return fail(c, notFound('资产不存在'));
    const input = valid<{ workerId: string; installed: boolean }>(c, 'json');
    const done = await setAssetInstalled(ctx.assetReview, { workerId: input.workerId, assetId: asset.id, installed: input.installed }, { actor, policy: ctx.assetReview.policy });
    if (!done.ok) return fail(c, done.error);
    await recordAssetAudit(
      ctx.assetReview,
      actor,
      input.installed ? 'asset.install' : 'asset.uninstall',
      asset.name,
      `${asset.kind} ${input.installed ? '装到' : '从'}机器 ${input.workerId}${input.installed ? ' 上' : ' 卸下'}${viaNote(actor)}`
    );
    return c.json({ assetId: asset.id, workerId: input.workerId, installed: input.installed });
  });
  on(routes.submitAssetRevision, async (c) => {
    if (!ctx.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
    const body = valid<{ files: { path: string; data: string }[] }>(c, 'json');
    const files = body.files.map((file) => ({ path: file.path, data: new Uint8Array(Buffer.from(file.data, 'base64')) }));
    const result = await submitAssetRevision(ctx.assetReview, principal(c), c.req.param('assetId') ?? '', files);
    if (!result.ok) return fail(c, result.error);
    const { asset, submission } = result.value;
    return c.json({ assetId: asset.id, latest: asset.latest, submissionId: submission?.id ?? null, status: submission?.status ?? null });
  });
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
    const collected = await collectSessionModels({
      actor,
      workers: await listWorkers(deps),
      readable,
      providers: ctx.providers?.deps
    });
    // 开放 API 是集成面：不出套件清单、外部组件的包名 / 来源串（ADR 0021 §7），只留能力
    for (const worker of collected.workers) workers.push(redactInventory(attachHubModelsToWorker(worker, collected.hub)));
    return c.json(workers);
  });

  on(routes.listModels, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'worker.read')) return fail(c, forbidden('令牌没有 workers:read'));
    const readable = await workerReader(deps.access, actor);
    const query = valid<{ workerId?: string; agentId?: string }>(c, 'query');
    const collected = await collectSessionModels({
      actor,
      workers: await listWorkers(deps),
      readable,
      providers: ctx.providers?.deps,
      workerId: query.workerId,
      agentId: query.agentId
    });
    return c.json({ models: collected.models });
  });

  on(routes.listProjects, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.read')) return fail(c, forbidden('令牌没有 projects:read'));
    const result = await listProjects(deps);
    const readable = await projectReader(deps.access, actor);
    // 同一套投影：仓库只给 hasToken，令牌名 / 明文不出 server
    return result.ok ? c.json(result.value.filter(readable).map(projectDto)) : fail(c, result.error);
  });
  on(routes.getProject, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.read')) return fail(c, forbidden('令牌没有 projects:read'));
    const project = await deps.projects.byId(asProjectId(c.req.param('projectId') ?? ''));
    if (!project) return fail(c, notFound('项目不存在'));
    const readable = await projectReader(deps.access, actor);
    if (!readable(project)) return fail(c, notFound('项目不存在'));
    return c.json(projectDto(project));
  });
  on(routes.createProject, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.create')) return fail(c, forbidden('令牌不能新建项目（要 projects:write，且账号有建项目的权限）'));
    const result = await createProjectUseCase(deps, { ...valid<z.output<typeof createProjectRequest>>(c, 'json'), actor });
    return result.ok ? c.json(projectDto(result.value), 201) : fail(c, result.error);
  });
  on(routes.updateProject, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const project = await deps.projects.byId(asProjectId(c.req.param('projectId') ?? ''));
    if (!project) return fail(c, notFound('项目不存在'));
    const readable = await projectReader(deps.access, actor);
    if (!readable(project)) return fail(c, notFound('项目不存在'));
    const input = valid<{ description?: string | null; checks?: string[]; defaultAgent?: unknown }>(c, 'json');
    let next = project;
    if (input.description !== undefined) {
      const result = await setProjectDescriptionUseCase(deps, { projectId: next.id, description: input.description });
      if (!result.ok) return fail(c, result.error);
      next = result.value;
    }
    if (input.checks !== undefined) {
      const result = await setProjectChecksUseCase(deps, { projectId: next.id, checks: input.checks });
      if (!result.ok) return fail(c, result.error);
      next = result.value;
    }
    if (input.defaultAgent !== undefined) {
      const result = await setProjectDefaultAgentUseCase(deps, { projectId: next.id, defaultAgent: input.defaultAgent });
      if (!result.ok) return fail(c, result.error);
      next = result.value;
      await auditDefaultAgent(actor, next.id, next.defaultAgent ?? null);
    }
    return c.json(projectDto(next));
  });
  on(routes.resolveDefaultAgent, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.read')) return fail(c, forbidden('令牌没有 projects:read'));
    const query = valid<{ projectId: string; taskId?: string; runtime?: string; model?: string }>(c, 'query');
    const project = await deps.projects.byId(asProjectId(query.projectId));
    if (!project) return fail(c, notFound('项目不存在'));
    const readable = await projectReader(deps.access, actor);
    if (!readable(project)) return fail(c, notFound('项目不存在'));
    let task = null;
    if (query.taskId) {
      task = await deps.tasks.byId(asTaskId(query.taskId));
      if (!task || task.projectId !== project.id) return fail(c, notFound('任务不存在'));
    }
    const resolved = await resolveDefaultAgent(deps, {
      project,
      task,
      explicit: { runtime: query.runtime ?? '', model: query.model ?? '', options: {} }
    });
    return c.json(resolved);
  });
  on(routes.getTeamAgentDefaults, async (c) => {
    const actor = principal(c);
    const wired = teamDefaultsDeps();
    if (!wired) return fail(c, unavailable('这个 hub 还没装配默认模型'));
    const result = await viewAgentDefaults(wired, actor);
    return result.ok ? c.json({ defaults: result.value }) : fail(c, result.error);
  });
  on(routes.setTeamAgentDefaults, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    if (projectLimited(actor)) return fail(c, forbidden('项目限定令牌不能改团队默认模型'));
    const teamId = actor.user.teamId;
    const account = { ...actor, via: undefined };
    if (!teamId || !can(account, 'team.manage', { teamId })) {
      return fail(c, forbidden('只有团队 owner / admin 能改默认模型'));
    }
    const wired = teamDefaultsDeps();
    if (!wired) return fail(c, unavailable('这个 hub 还没装配默认模型'));
    const input = valid<{ defaults: Record<string, string> }>(c, 'json');
    const result = await setAgentDefaults(wired, account, { defaults: input.defaults });
    return result.ok ? c.json({ defaults: result.value }) : fail(c, result.error);
  });
  on(routes.setProjectRepos, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const projectId = c.req.param('projectId') ?? '';
    const project = await deps.projects.byId(asProjectId(projectId));
    const allowed = await authorizeProject(deps.access, actor, project, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);
    const input = valid<z.output<typeof setProjectReposRequest>>(c, 'json');
    const result = await updateProjectReposUseCase(deps, { projectId, repos: input.repos, primaryRepoId: input.primaryRepoId });
    if (!result.ok) return fail(c, result.error);
    // 令牌名不出去：projectDto 只给 hasToken。
    return c.json(projectDto(result.value));
  });
  on(routes.setProjectRepo, async (c) => {
    const result = await setProjectRepoUseCase(deps, { projectId: c.req.param('projectId') ?? '', ...valid<z.output<typeof setProjectRepoRequest>>(c, 'json') });
    return result.ok ? c.json(projectDto(result.value)) : fail(c, result.error);
  });
  on(routes.setProjectDescription, async (c) => {
    const result = await setProjectDescriptionUseCase(deps, { projectId: c.req.param('projectId') ?? '', ...valid<z.output<typeof setProjectDescriptionRequest>>(c, 'json') });
    return result.ok ? c.json(projectDto(result.value)) : fail(c, result.error);
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
    const actor = principal(c);
    const workspaceId = c.req.param('workspaceId') ?? '';
    if (deps.access) {
      const workspace = await deps.workspaces.byId(asWorkspaceId(workspaceId));
      const allowed = await authorizeWorkspace(deps, actor, workspace, 'project.read');
      if (!allowed.ok) return fail(c, allowed.error);
    }
    const result = await workspaceChangesUseCase(deps, workspaceId);
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
    if (!can(actor, 'task.create')) return fail(c, forbidden('令牌没有 projects:write'));
    const result = await createTaskUseCase(deps, { ...valid<z.output<typeof createTaskRequest>>(c, 'json'), ownerId: actor.user.id });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.getTask, async (c) => {
    const task = await deps.tasks.byId(asTaskId(c.req.param('taskId') ?? ''));
    if (!task) return fail(c, notFound('任务不存在'));
    return c.json({ ...task, sessions: await deps.sessions.listByTask(task.id) });
  });
  on(routes.setTaskDefaultAgent, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const taskId = asTaskId(c.req.param('taskId') ?? '');
    const task = await deps.tasks.byId(taskId);
    if (!task) return fail(c, notFound('任务不存在'));
    const project = await deps.projects.byId(task.projectId);
    if (!project) return fail(c, notFound('项目不存在'));
    const readable = await projectReader(deps.access, actor);
    if (!readable(project)) return fail(c, notFound('任务不存在'));
    const allowed = await authorizeProject(deps.access, actor, project, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);
    const input = valid<{ defaultAgent: unknown }>(c, 'json');
    const result = await setTaskDefaultAgentUseCase(deps, taskId, input.defaultAgent);
    if (result.ok) await auditDefaultAgent(actor, taskId, result.value.defaultAgent ?? null);
    return result.ok ? c.json(result.value) : fail(c, result.error);
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

  /** repoId 只用来挑工作目录，不往 derive 里传。 */
  const withoutRepo = <T extends { repoId?: string }>(value: T): Omit<T, 'repoId'> => {
    const { repoId: _repoId, ...rest } = value;
    return rest;
  };
  on(routes.startSession, async (c) => {
    const actor = principal(c);
    const { handle, linkWith, ...input } = valid<z.output<typeof deriveSessionRequest>>(c, 'json');
    if (!can(actor, 'session.create')) return fail(c, forbidden('令牌没有 sessions:write'));
    const extras = { handle, linkWith };
    const linkIds = await checkStartExtras(deps, ctx.messaging?.messages, input.taskId, extras, actor);
    if (!linkIds.ok) return fail(c, linkIds.error);
    const placed = await workspaceForApiStart(
      deps,
      { ...input, ...(input.workspaceMode === undefined ? {} : { mode: input.workspaceMode }) },
      actor
    );
    if (!placed.ok) return fail(c, placed.error);
    // model 省略或空串：按默认 Agent 层级解析（任务默认 > 项目默认 > 团队运行时默认）；
    // 显式传的 model 不动。没有可解析的默认就明确 400，不写死某个模型名。
    let model = input.model ?? '';
    if (!model) {
      const task = await deps.tasks.byId(asTaskId(input.taskId));
      if (!task) return fail(c, notFound('任务不存在'));
      const project = await deps.projects.byId(task.projectId);
      if (!project) return fail(c, notFound('项目不存在'));
      const resolved = await resolveDefaultAgent(deps, { project, task, explicit: { runtime: input.agentId } });
      model = resolved.effective.model;
      if (!model) {
        // 令牌打本机这类授权拒绝要盖过「没有默认模型」（与 deriveSessionUseCase 里的 authorizeWorker 同一条规则）。
        const workers = await deps.gateway.status();
        const chosen = placed.value ? await deps.workspaces.byId(asWorkspaceId(placed.value)) : await defaultWorkspaceFor(deps, project.id);
        if (chosen) {
          const homeWorker = chosen.workerId ?? workers.find((worker) => worker.origin === 'local')?.workerId ?? null;
          if (homeWorker !== null) {
            const early = await authorizeWorker(deps.access, actor, homeWorker);
            if (!early.ok) return fail(c, early.error);
          }
        }
        return fail(c, invalid('没有可解析的默认模型：先在任务或项目里设置默认 Agent，或显式传 model'));
      }
    }
    const allowed = await ctx.providers?.checkModel(actor, model, input.taskId);
    if (allowed && !allowed.ok) return fail(c, allowed.error);
    const result = await deriveSessionUseCase(deps, {
      ...withoutRepo(input),
      model,
      ...(placed.value ? { workspaceId: placed.value } : {}),
      actor,
      ...(allowed?.ok && allowed.value ? { hubProtocol: allowed.value } : {})
    });
    if (result.ok) {
      await recordSessionAction(deps, ctx.activity, c, actor, 'session.start', result.value.id, '');
      await noteProvenance(deps, ctx.activity, c, actor, result.value, 'api');
      await applyStartExtras(deps, ctx.messaging?.bus, result.value, extras, linkIds.value, actor.user.id);
    }
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.syncWorkspace, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const result = await syncWorkspaceReposUseCase(deps, { workspaceId: c.req.param('workspaceId') ?? '', actor });
    if (!result.ok) return fail(c, result.error);
    return c.json({
      workspace: workspaceSchema.parse(result.value.workspace),
      added: result.value.added,
      present: result.value.present,
      skipped: result.value.skipped,
      failed: result.value.failed
    });
  });
  on(routes.createWorkspace, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const projectId = c.req.param('projectId') ?? '';
    const project = await deps.projects.byId(asProjectId(projectId));
    if (!project) return fail(c, notFound('项目不存在'));
    const allowed = await authorizeProject(deps.access, actor, project, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);
    const input = valid<{ kind: 'long_lived' | 'temporary'; mode?: string; taskId?: string; workerId?: string | null; path?: string }>(c, 'json');
    const result =
      input.kind === 'temporary'
        ? await prepareTemporaryWorkspaceUseCase(deps, {
            projectId,
            taskId: input.taskId ?? '',
            workerId: input.workerId ?? null,
            home: homedir(),
            mode: input.mode === 'shared' ? 'shared' : 'isolated',
            actor
          })
        : await prepareLongLivedWorkspaceUseCase(deps, {
            projectId,
            workerId: input.workerId ?? null,
            plan: input.mode === 'link' ? { mode: 'link', path: input.path ?? '' } : { mode: 'create' },
            home: homedir(),
            actor
          });
    if (!result.ok) return fail(c, result.error);
    return c.json(workspaceSchema.parse(result.value), 201);
  });
  on(routes.removeWorkspace, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const input = valid<{ deleteDirectory?: boolean; force?: boolean }>(c, 'json');
    const workspaceId = c.req.param('workspaceId') ?? '';
    const result = await deleteWorkspaceUseCase(deps, {
      workspaceId,
      deleteDirectory: input.deleteDirectory === true,
      force: input.force === true,
      actor
    });
    if (!result.ok) return fail(c, result.error);
    return c.json(workspaceSchema.parse(result.value));
  });
  on(routes.retryWorkspaceSetup, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const workspaceId = c.req.param('workspaceId') ?? '';
    const result = await retryWorkspaceSetupUseCase(deps, { workspaceId, actor });
    if (!result.ok) return fail(c, result.error);
    return c.json(workspaceSchema.parse(result.value));
  });

  const needGit = () => ctx.git ?? null;
  on(routes.workspaceGroupCreate, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const projectId = c.req.param('projectId') ?? '';
    const project = await deps.projects.byId(asProjectId(projectId));
    if (!project) return fail(c, notFound('项目不存在'));
    const allowed = await authorizeProject(deps.access, actor, project, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);
    const input = valid<{
      taskId: string;
      workerId?: string;
      repoIds?: string[];
      fromGroupId?: string;
      branches?: { repoId: string; branch: string }[];
      sessionId?: string;
    }>(c, 'json');
    const result = await buildWorkspaceGroupUseCase(deps, {
      projectId,
      taskId: input.taskId,
      workerId: input.workerId ?? null,
      home: homedir(),
      actor,
      repoIds: input.repoIds,
      fromGroupId: input.fromGroupId,
      branches: input.branches,
      sessionId: input.sessionId
    });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.workspaceGroupGet, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.read')) return fail(c, forbidden('令牌没有 projects:read'));
    const group = await deps.workspaceGroups?.byId(asWorkspaceGroupId(c.req.param('groupId') ?? ''));
    if (!group) return fail(c, notFound('组合工作空间不存在'));
    const project = await deps.projects.byId(asProjectId(group.projectId));
    const allowed = await authorizeProject(deps.access, actor, project, 'project.read');
    if (!allowed.ok) return fail(c, allowed.error);
    return c.json(group);
  });
  on(routes.workspaceGroupAddMember, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const groupId = c.req.param('groupId') ?? '';
    const group = await deps.workspaceGroups?.byId(asWorkspaceGroupId(groupId));
    if (!group) return fail(c, notFound('组合工作空间不存在'));
    const project = await deps.projects.byId(asProjectId(group.projectId));
    const allowed = await authorizeProject(deps.access, actor, project, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);
    const input = valid<{ repoId: string }>(c, 'json');
    const result = await addWorkspaceGroupMemberUseCase(deps, { groupId, repoId: input.repoId, home: homedir(), actor });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.workspaceGroupRetry, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const groupId = c.req.param('groupId') ?? '';
    const group = await deps.workspaceGroups?.byId(asWorkspaceGroupId(groupId));
    if (!group) return fail(c, notFound('组合工作空间不存在'));
    const project = await deps.projects.byId(asProjectId(group.projectId));
    const allowed = await authorizeProject(deps.access, actor, project, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);
    const result = await retryWorkspaceGroupUseCase(deps, { groupId, home: homedir(), actor });
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.sessionGitState, async (c) => {
    const git = needGit();
    if (!git) return fail(c, unavailable('Git 工作流未就绪'));
    const actor = principal(c);
    if (!can(actor, 'session.read')) return fail(c, forbidden('令牌没有 sessions:read'));
    const member = c.req.query('member') || undefined;
    const result = await git.state(actor, c.req.param('sessionId') ?? '', member);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.workspaceDiff, async (c) => {
    const files = ctx.files;
    if (!files) return fail(c, unavailable('工作空间文件服务未就绪'));
    const actor = principal(c);
    if (!can(actor, 'session.read')) return fail(c, forbidden('令牌没有 sessions:read'));
    const query = valid<{ member?: string; maxBytes?: number }>(c, 'query');
    const result = await files.worktreeDiff(actor, c.req.param('sessionId') ?? '', {
      ...(query.member ? { member: query.member } : {}),
      ...(query.maxBytes !== undefined ? { maxBytes: query.maxBytes } : {})
    });
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.workspaceReadFile, async (c) => {
    const files = ctx.files;
    if (!files) return fail(c, unavailable('工作空间文件服务未就绪'));
    const actor = principal(c);
    if (!can(actor, 'session.read')) return fail(c, forbidden('令牌没有 sessions:read'));
    const query = valid<{ path: string; member?: string; confirmed?: '1' | 'true' }>(c, 'query');
    const result = await files.readWorktreeFile(actor, c.req.param('sessionId') ?? '', query.path, {
      confirmed: query.confirmed === '1' || query.confirmed === 'true',
      ...(query.member ? { member: query.member } : {})
    });
    if (!result.ok) return fail(c, result.error);
    const file = result.value;
    return c.json({ path: file.path, size: file.size, modifiedAt: file.modifiedAt, binary: file.binary, content: file.binary ? '' : new TextDecoder().decode(file.bytes) });
  });
  on(routes.sessionGitRun, async (c) => {
    const git = needGit();
    if (!git) return fail(c, unavailable('Git 工作流未就绪'));
    const actor = principal(c);
    if (!can(actor, 'session.prompt')) return fail(c, forbidden('令牌没有 sessions:write'));
    const input = valid<{ action: 'commit' | 'push' | 'pr'; message?: string; title?: string; body?: string; member?: string }>(c, 'json');
    const member = input.member || c.req.query('member') || undefined;
    const result = await git.run(
      actor,
      c.req.param('sessionId') ?? '',
      { action: input.action, message: input.message ?? '', ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { body: input.body } : {}) },
      member
    );
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.taskPullRequests, async (c) => {
    const git = needGit();
    if (!git) return fail(c, unavailable('Git 工作流未就绪'));
    const actor = principal(c);
    if (!can(actor, 'task.read')) return fail(c, forbidden('令牌没有 sessions:read 或 projects:read'));
    const refresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
    const result = await git.syncTask(actor, c.req.param('taskId') ?? '', refresh ? { refresh: true } : undefined);
    return result.ok ? c.json({ pullRequests: result.value }) : fail(c, result.error);
  });
  on(routes.sessionSettle, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'session.settle')) return fail(c, forbidden('令牌没有收起会话的权限（sessions:write 已包含 session.settle）'));
    const input = valid<{ settled: boolean }>(c, 'json');
    const result = await settleSessionUseCase(deps, {
      sessionId: asSessionId(c.req.param('sessionId') ?? ''),
      settled: input.settled,
      actor,
      now: deps.now()
    });
    if (!result.ok) return fail(c, result.error);
    const { cleanup, ...session } = result.value;
    return c.json({ ...sessionSchema.parse(session), cleanup: cleanup ?? { items: [] } });
  });
  on(routes.workspaceSweep, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.update')) return fail(c, forbidden('令牌没有 projects:write'));
    const projectId = c.req.param('projectId') ?? '';
    const result = await sweepProjectUseCase(deps, actor, projectId);
    if (!result.ok) return fail(c, result.error);
    const records = await cleanupRecordsUseCase(deps, actor, projectId);
    const items = records.ok ? records.value.items.filter((item) => !result.value.runId || item.runId === result.value.runId) : [];
    return c.json({ ...result.value, items });
  });
  on(routes.workspaceSweepRecords, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'project.read')) return fail(c, forbidden('令牌没有 projects:read'));
    const result = await cleanupRecordsUseCase(deps, actor, c.req.param('projectId') ?? '');
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  on(routes.forkSession, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'session.create')) return fail(c, forbidden('令牌没有 sessions:write'));
    const input = valid<z.output<typeof forkSessionRequest>>(c, 'json');
    const result = await forkSessionUseCase(deps, { ...input, actor });
    if (result.ok) {
      await recordSessionAction(deps, ctx.activity, c, actor, 'session.fork', result.value.id, `从 ${input.sessionId} 分叉`);
      await recordSessionAction(deps, ctx.activity, c, actor, 'session.fork', input.sessionId, `分叉出 ${result.value.id}`);
      await noteProvenance(deps, ctx.activity, c, actor, result.value, 'fork');
    }
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  /** 在途长轮询按令牌计数（LOW5）：上限与 SSE 的事件流一致。 */
  const openPolls = new Map<string, number>();
  /** 长轮询（P1d）：每 500ms 看一次，满足条件或到点就返回；客户端断开（signal.abort）立刻停。 */
  const waitUntil = async (c: Context, seconds: number | undefined, done: () => Promise<boolean>): Promise<Response | null> => {
    if (!seconds) return null;
    const token = principal(c).via!.tokenId;
    const open = openPolls.get(token) ?? 0;
    if (open >= maxStreams) return tooMany(c, 5, `每个令牌最多同时挂起 ${maxStreams} 条长轮询`);
    openPolls.set(token, open + 1);
    try {
      const until = Date.now() + Math.min(seconds, 50) * 1000;
      while (Date.now() < until && !c.req.raw.signal.aborted && !(await done())) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      const left = (openPolls.get(token) ?? 1) - 1;
      if (left <= 0) openPolls.delete(token);
      else openPolls.set(token, left);
    }
    return null;
  };
  on(routes.getSession, async (c) => {
    const id = asSessionId(c.req.param('sessionId') ?? '');
    const session = await deps.sessions.byId(id);
    if (!session) return fail(c, notFound('会话不存在'));
    const query = valid<{ waitSec?: number }>(c, 'query');
    if (session.status === 'running') {
      const limited = await waitUntil(c, query.waitSec, async () => (await deps.sessions.byId(id))?.status !== 'running');
      if (limited) return limited;
    }
    return c.json((await deps.sessions.byId(id)) ?? session);
  });
  on(routes.prompt, async (c) => {
    const actor = principal(c);
    const input = valid<{ text: string; attachments?: never; clientMessageId?: string }>(c, 'json');
    const result = await promptSessionUseCase(deps, {
      sessionId: c.req.param('sessionId') ?? '',
      text: input.text,
      attachments: input.attachments,
      ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
      author: { id: actor.user.id, name: actor.user.displayName, via: actor.via?.name }
    });
    return result.ok
      ? c.json({ ok: true, ...result.value }, 202)
      : fail(c, result.error);
  });
  on(routes.setSessionModel, async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const input = valid<{ model: string }>(c, 'json');
    const current = await deps.sessions.byId(asSessionId(sessionId));
    if (!current) return fail(c, notFound('会话不存在'));
    // 与界面同一条路：跨提供商要停进程重起（switchSessionModel），同提供商只改选项。
    if (ctx.providers?.crossesProviders(current.model, input.model) === true) {
      const teamId = (await projectOfSession(deps, current))?.teamId ?? null;
      const allowed = await ctx.providers.modelSwitchable(principal(c), input.model, teamId);
      if (!allowed.ok) return fail(c, allowed.error);
      const switched = await switchSessionModel(deps, { sessionId, model: input.model });
      if (!switched.ok) return fail(c, switched.error);
      await ctx.waitOptions?.(sessionId);
      return c.json(switched.value);
    }
    if (ctx.providers) {
      const allowed = ctx.providers.optionAllowed(current.model, 'model', input.model);
      if (!allowed.ok) return fail(c, allowed.error);
    }
    const changed = await changeSessionOption(deps, { sessionId, id: 'model', value: input.model });
    if (!changed.ok) return fail(c, changed.error);
    await ctx.waitOptions?.(sessionId);
    return c.json((await deps.sessions.byId(asSessionId(sessionId))) ?? changed.value);
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
    const current = await deps.sessions.byId(asSessionId(sessionId));
    if (
      current !== null &&
      input.optionId === 'model' &&
      ctx.providers?.crossesProviders(current.model, input.value) === true
    ) {
      const teamId = (await projectOfSession(deps, current))?.teamId ?? null;
      const allowed = await ctx.providers.modelSwitchable(principal(c), input.value, teamId);
      if (!allowed.ok) return fail(c, allowed.error);
      const switched = await switchSessionModel(deps, { sessionId, model: input.value });
      if (!switched.ok) return fail(c, switched.error);
      await ctx.waitOptions?.(sessionId);
      return c.json(switched.value);
    }
    if (ctx.providers) {
      const allowed = ctx.providers.optionAllowed(current?.model ?? '', input.optionId, input.value);
      if (!allowed.ok) return fail(c, allowed.error);
    }
    const changed = await changeSessionOption(deps, { sessionId, id: input.optionId, value: input.value });
    if (!changed.ok) return fail(c, changed.error);
    await ctx.waitOptions?.(sessionId);
    return c.json((await deps.sessions.byId(asSessionId(sessionId))) ?? changed.value);
  });
  const keepEvents = (entries: Awaited<ReturnType<typeof deps.sessions.eventsAfter>>, sinceTurn: number | undefined) =>
    sinceTurn === undefined ? entries : entries.filter((entry) => entry.turn !== undefined && entry.turn >= sinceTurn);
  on(routes.events, async (c) => {
    const actor = principal(c);
    const sessionId = asSessionId(c.req.param('sessionId') ?? '');
    const target = await deps.sessions.byId(sessionId);
    if (!target) return fail(c, notFound('会话不存在'));
    // #243：容器会话没有任务，installAccess 的 projectOfRef 会放行；这里按归属反推项目再判 project.read。
    const project = await projectOfSession(deps, target);
    const allowed = await authorizeProject(deps.access, actor, project, 'session.read');
    if (!allowed.ok) return fail(c, allowed.error);
    const query = valid<{ after?: number; sinceTurn?: number; waitSec?: number }>(c, 'query');
    const after = query.after ?? 0;
    let scanned = await deps.sessions.eventsAfter(sessionId, after);
    let entries = keepEvents(scanned, query.sinceTurn);
    // 长轮询等「可投影」的事件：prompt/thinking 等不会被投影的条目不能结束等待，也不能把 nextAfter 卡住。
    if (!entries.some(isProjectableEntry) && query.waitSec) {
      const limited = await waitUntil(c, query.waitSec, async () => {
        scanned = await deps.sessions.eventsAfter(sessionId, after);
        return keepEvents(scanned, query.sinceTurn).some(isProjectableEntry);
      });
      if (limited) return limited;
      // LOW5：客户端已断开就不再打库收尾——连接都关了，这次扫描没人读。
      if (!c.req.raw.signal.aborted) {
        scanned = await deps.sessions.eventsAfter(sessionId, after);
        entries = keepEvents(scanned, query.sinceTurn);
      }
    }
    const kept = await refreshAuthors(ctx.activity, entries);
    const payload = projectEvents(kept, after, lastJournalSeq(scanned, after));
    return c.json(payload);
  });
  // ── 会话通信 P1d：连线、同伴、外部消息、收件箱 ──
  const noMessaging = (c: Context) => fail(c, { code: 'not_implemented', message: '这台 hub 没装消息总线' });
  /** 另一条会话也要能 session.prompt（路径上那条由 installAccess 查过）。 */
  const otherSession = async (actor: Principal, otherId: string, projectId: string): Promise<{ ok: true; id: string } | { ok: false; error: import('@agent-hub/domain').DomainError }> => {
    const other = await deps.sessions.byId(asSessionId(otherId));
    const project = other ? await projectOfSession(deps, other) : null;
    if (!other || !project || project.id !== projectId) return { ok: false, error: notFound('两条会话不在同一个项目里') };
    if (deps.access) {
      const allowed = await authorizeSession(deps.access, actor, project, other, 'session.prompt');
      if (!allowed.ok) return { ok: false, error: allowed.error };
    }
    return { ok: true, id: other.id };
  };
  const pathSession = async (c: Context) => {
    const session = await deps.sessions.byId(asSessionId(c.req.param('sessionId') ?? ''));
    const project = session ? await projectOfSession(deps, session) : null;
    return session && project ? { session, project } : null;
  };
  on(routes.linkSession, async (c) => {
    const actor = principal(c);
    const here = await pathSession(c);
    if (!here) return fail(c, notFound('会话不存在'));
    const input = valid<{ otherSessionId: string }>(c, 'json');
    const checked = await otherSession(actor, input.otherSessionId, here.project.id);
    if (!checked.ok) return fail(c, checked.error);
    const linked = await linkSessionsUseCase(deps, here.project.id, here.session.id, checked.id, actor.user.id);
    return linked.ok ? c.json(linked.value, 201) : fail(c, linked.error);
  });
  on(routes.unlinkSession, async (c) => {
    const actor = principal(c);
    const here = await pathSession(c);
    if (!here) return fail(c, notFound('会话不存在'));
    const input = valid<{ otherSessionId: string }>(c, 'json');
    const checked = await otherSession(actor, input.otherSessionId, here.project.id);
    if (!checked.ok) return fail(c, checked.error);
    const removed = await unlinkSessionsUseCase(deps, here.project.id, here.session.id, checked.id);
    return removed.ok ? c.json({ ok: true }) : fail(c, removed.error);
  });
  on(routes.sessionPeers, async (c) => {
    if (!ctx.messaging) return noMessaging(c);
    const actor = principal(c);
    const target = await deps.sessions.byId(asSessionId(c.req.param('sessionId') ?? ''));
    if (!target) return fail(c, notFound('会话不存在'));
    // #243：容器会话按归属反推项目，再过 project.read（installAccess 对无任务会话放行）。
    const project = await projectOfSession(deps, target);
    const allowed = await authorizeProject(deps.access, actor, project, 'session.read');
    if (!allowed.ok) return fail(c, allowed.error);
    const peers = await ctx.messaging.bus.peers(target.id);
    return peers.ok ? c.json({ peers: peers.value }) : fail(c, peers.error);
  });
  on(routes.sessionMessage, async (c) => {
    if (!ctx.messaging) return noMessaging(c);
    const actor = principal(c);
    const target = await deps.sessions.byId(asSessionId(c.req.param('sessionId') ?? ''));
    if (!target) return fail(c, notFound('会话不存在'));
    // #243：容器会话没有任务，installAccess 会放行；先按归属反推项目、按 session.prompt 判（和普通会话一致），再查机器。
    const project = await projectOfSession(deps, target);
    const allowed = await authorizeSession(deps.access, actor, project, target, 'session.prompt');
    if (!allowed.ok) return fail(c, allowed.error);
    // 消息会让目标会话开新一轮：和 session_reply 一样，所在机器要过 authorizeWorker（本机 Worker 永远不对令牌开放）。
    const worker = await authorizeWorker(deps.access, actor, target.workerId);
    if (!worker.ok) return fail(c, worker.error);
    const input = valid<{ kind: 'send' | 'ask'; body: string; parts?: unknown[]; wake?: boolean; timeoutSec?: number }>(c, 'json');
    const accepted = await ctx.messaging.bus.acceptExternal({
      inboxId: actor.via!.tokenId,
      label: `外部 · ${actor.via!.name}`,
      onBehalfOf: actor.user.id,
      targetSessionId: asSessionId(c.req.param('sessionId') ?? ''),
      kind: input.kind,
      body: input.body,
      ...(input.parts !== undefined ? { parts: input.parts } : {}),
      ...(input.wake !== undefined ? { wake: input.wake } : {}),
      ...(input.timeoutSec !== undefined ? { timeoutSec: input.timeoutSec } : {})
    });
    return accepted.ok ? c.json(accepted.value, 201) : fail(c, accepted.error);
  });
  on(routes.getMessage, async (c) => {
    if (!ctx.messaging) return noMessaging(c);
    const bus = ctx.messaging.bus;
    const inboxId = principal(c).via!.tokenId;
    const messageId = c.req.param('messageId') ?? '';
    const first = await bus.externalMessage(inboxId, messageId);
    if (!first.ok) return fail(c, first.error);
    const settled = (got: { message: { kind: string; status: string }; reply: unknown }) =>
      got.reply !== null || got.message.kind === 'reply' || (got.message.kind === 'send' && got.message.status !== 'queued' && got.message.status !== 'held');
    if (!settled(first.value)) {
      const limited = await waitUntil(c, valid<{ waitSec?: number }>(c, 'query').waitSec, async () => {
        const again = await bus.externalMessage(inboxId, messageId);
        return again.ok && settled(again.value);
      });
      if (limited) return limited;
    }
    const got = await bus.externalMessage(inboxId, messageId);
    if (!got.ok) return fail(c, got.error);
    return c.json({ message: messageView(got.value.message), reply: got.value.reply ? messageView(got.value.reply) : null });
  });
  on(routes.messageInbox, async (c) => {
    if (!ctx.messaging) return noMessaging(c);
    const query = valid<{ after?: number; limit?: number }>(c, 'query');
    const after = query.after ?? 0;
    const list = await ctx.messaging.bus.externalInbox(principal(c).via!.tokenId, after, query.limit ?? 50);
    return c.json({ messages: list.map(messageView), next: list.at(-1)?.createdAt ?? after });
  });


  const noProviders = (c: Context) => fail(c, { code: 'not_implemented', message: '这台 hub 没装模型提供商' });
  const providerImpact = async (providerId: string) => {
    const api = ctx.providers;
    if (!api) return null;
    const provider = await api.deps.providers.byId(providerId);
    if (!provider) return null;
    const usage = await api.deps.providers.usage(provider.id);
    const models = provider.models.map((model) => hubModelId(provider.slug, model.id));
    return {
      action: 'delete',
      provider: publicProvider({
        id: provider.id,
        slug: provider.slug,
        name: provider.name,
        scope: provider.scope,
        hasKey: provider.hasKey,
        enabled: provider.enabled
      }),
      models,
      usage: { sessions: usage.sessions, requests: usage.requests, lastUsedAt: usage.lastUsedAt },
      message:
        usage.sessions > 0
          ? `删除后 ${models.length} 个模型将不可用，有 ${usage.sessions} 个会话用过这个提供商。`
          : `删除后 ${models.length} 个模型将不可用。`
    };
  };
  /** LOW6：机器维度的路由覆盖只给能看见这台机器的令牌——按 worker.read 逐台过滤；没有 workers:read 就整个字段省略。 */
  const visibleWorkerRouting = async (
    deps: Deps,
    actor: Principal,
    providers: { workerRouting: () => Promise<Record<string, unknown>> }
  ): Promise<Record<string, unknown> | undefined> => {
    if (!can(actor, 'worker.read')) return undefined;
    const readable = await workerReader(deps.access, actor);
    const visible: Record<string, unknown> = {};
    for (const [workerId, routing] of Object.entries(await providers.workerRouting())) {
      if (await readable(workerId)) visible[workerId] = routing;
    }
    return visible;
  };
  on(routes.providerList, async (c) => {
    if (!ctx.providers) return noProviders(c);
    const actor = principal(c);
    if (!can(actor, 'provider.read')) return fail(c, forbidden('令牌没有 providers:read'));
    const listed = await listProviders(ctx.providers.deps, actor);
    // LOW6：workerRouting 只含调用方能看见的机器；没有 workers:read 的令牌整个字段省略。
    const workerRouting = await visibleWorkerRouting(deps, actor, ctx.providers.deps.providers);
    return workerRouting === undefined ? c.json({ providers: listed.map(publicProvider) }) : c.json({ providers: listed.map(publicProvider), workerRouting });
  });
  on(routes.providerCreate, async (c) => {
    if (!ctx.providers) return noProviders(c);
    const actor = principal(c);
    if (!can(actor, 'provider.manage')) return fail(c, forbidden('令牌没有 providers:manage'));
    const input = valid<{
      slug: string;
      name: string;
      protocol: 'openai-chat' | 'openai-responses' | 'anthropic';
      baseUrl: string;
      models: unknown[];
      routing: 'direct' | 'hub';
      enabled?: boolean;
      scope?: 'personal' | 'team' | 'hub';
      apiKey?: string;
    }>(c, 'json');
    const result = await createProvider(ctx.providers.deps, actor, {
      ...ctx.providers.asInput(input as unknown as Record<string, unknown>),
      scope: input.scope ?? 'personal',
      ...(input.apiKey ? { apiKey: input.apiKey } : {})
    });
    return result.ok ? c.json(publicProvider(result.value), 201) : fail(c, result.error);
  });
  on(routes.providerUpdate, async (c) => {
    if (!ctx.providers) return noProviders(c);
    const actor = principal(c);
    if (!can(actor, 'provider.manage')) return fail(c, forbidden('令牌没有 providers:manage'));
    const input = valid<Record<string, unknown>>(c, 'json');
    const result = await ctx.providers.updateManaged(actor, c.req.param('providerId') ?? '', ctx.providers.asInput(input));
    return result.ok ? c.json(publicProvider(result.value)) : fail(c, result.error);
  });
  on(routes.providerSetKey, async (c) => {
    if (!ctx.providers) return noProviders(c);
    const actor = principal(c);
    if (!can(actor, 'provider.manage')) return fail(c, forbidden('令牌没有 providers:manage'));
    const input = valid<{ apiKey: string }>(c, 'json');
    const result = await ctx.providers.setKeyManaged(actor, c.req.param('providerId') ?? '', input.apiKey);
    return result.ok ? c.json({ ok: true as const }) : fail(c, result.error);
  });
  on(routes.providerProbe, async (c) => {
    if (!ctx.providers) return noProviders(c);
    const actor = principal(c);
    if (!can(actor, 'provider.manage')) return fail(c, forbidden('令牌没有 providers:manage'));
    const input = valid<Record<string, unknown>>(c, 'json');
    const result = await ctx.providers.probe(actor, input);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.providerTest, async (c) => {
    if (!ctx.providers) return noProviders(c);
    const actor = principal(c);
    if (!can(actor, 'provider.manage')) return fail(c, forbidden('令牌没有 providers:manage'));
    const input = valid<{ workerId: string }>(c, 'json');
    const result = await ctx.providers.testProvider(actor, c.req.param('providerId') ?? '', input.workerId);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.providerDelete, async (c) => {
    if (!ctx.providers) return noProviders(c);
    const actor = principal(c);
    if (!can(actor, 'provider.manage')) return fail(c, forbidden('令牌没有 providers:manage'));
    const providerId = c.req.param('providerId') ?? '';
    const confirm = valid<{ confirm?: boolean }>(c, 'json').confirm === true;
    const current = await ctx.providers.deps.providers.byId(providerId);
    const view = providerActor(actor);
    if (!current || !canSeeProvider(view, current)) return fail(c, notFound('没有这个模型提供商'));
    if (!canManageProvider(view, current)) return fail(c, forbidden('无权管理这个模型提供商'));
    const impact = await providerImpact(providerId);
    if (!impact) return fail(c, notFound('没有这个模型提供商'));
    if (!confirm) return c.json({ confirmRequired: true, ...impact });
    const result = await ctx.providers.removeProvider(actor, providerId);
    return result.ok ? c.json({ confirmed: true, ...impact }) : fail(c, result.error);
  });
  on(routes.providerRoutingSet, async (c) => {
    if (!ctx.providers) return noProviders(c);
    const actor = principal(c);
    if (!can(actor, 'provider.manage')) return fail(c, forbidden('令牌没有 providers:manage'));
    const workerId = c.req.param('workerId') ?? '';
    const input = valid<{ routing: 'direct' | 'hub' | null; confirm?: boolean }>(c, 'json');
    const routing = input.routing;
    const message =
      routing === null
        ? `将清除机器 ${workerId} 的路由覆盖，之后跟随提供商设置。已有会话保持当前路径，直到重启。`
        : `将把机器 ${workerId} 的路由改为${routing === 'hub' ? '经 hub 中转' : '直连'}。已有会话保持当前路径，直到重启。`;
    const impact = { action: 'routing_set', workerId, routing, message };
    if (input.confirm !== true) return c.json({ confirmRequired: true, ...impact });
    const result = await setWorkerProviderRouting(ctx.providers.deps, actor, workerId, routing);
    return result.ok ? c.json({ confirmed: true, ...impact }) : fail(c, result.error);
  });

  const tokenManageDeps = {
    apiTokens: options.tokens.apiTokens,
    users: options.tokens.users,
    tokens: options.tokens.tokens,
    now: options.tokens.now,
    projects: options.tokens.projects ?? deps.projects,
    // OpenApiOptions.audit 只保证 append；创建/轮换/吊销只用 append。
    audit: options.audit as import('@agent-hub/domain').ApiTokenDeps['audit']
  };
  on(routes.tokenList, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'token.manage')) return fail(c, forbidden('令牌没有 tokens:manage'));
    return c.json({ tokens: await listApiTokens(tokenManageDeps, actor) });
  });
  on(routes.tokenCreate, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'token.manage')) return fail(c, forbidden('令牌没有 tokens:manage'));
    const input = valid<{ name: string; scopes: import('@agent-hub/domain').ApiScope[]; expiresAt: number; projectIds?: string[] | null }>(c, 'json');
    const result = await createApiToken(tokenManageDeps, actor, {
      name: input.name,
      kind: 'personal',
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      projectIds: input.projectIds
    });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });
  on(routes.tokenRotate, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'token.manage')) return fail(c, forbidden('令牌没有 tokens:manage'));
    const result = await rotateApiToken(tokenManageDeps, actor, c.req.param('tokenId') ?? '');
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  on(routes.tokenRevoke, async (c) => {
    const actor = principal(c);
    if (!can(actor, 'token.manage')) return fail(c, forbidden('令牌没有 tokens:manage'));
    const result = await revokeApiToken(tokenManageDeps, actor, c.req.param('tokenId') ?? '');
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  on(routes.activity, async (c) => {
    const actor = principal(c);
    const sessionId = asSessionId(c.req.param('sessionId') ?? '');
    const session = await deps.sessions.byId(sessionId);
    if (!session) return fail(c, notFound('会话不存在'));
    if (deps.access) {
      const allowed = await authorizeSession(deps.access, actor, await projectOfSession(deps, session), session, 'session.read');
      if (!allowed.ok) return fail(c, allowed.error);
    }
    return c.json(ctx.activity ? await sessionActivity(ctx.activity, sessionId) : []);
  });

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
  v1.post(`${V1}/mcp`, async (c) =>
    handleMcp(c, v1 as unknown as Hono, {
      ...(options.replays === undefined ? {} : { replays: options.replays }),
      ...(options.audit === undefined ? {} : { audit: options.audit }),
      writes: effectiveWrites(await options.settings?.get().catch(() => null)).writes,
      now: options.tokens.now
    })
  );
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
      '给内部 / 外部 agent 和脚本用的稳定接口（ADR 0015）。\n\n' +
      '- 认证：`Authorization: Bearer ahp_…`，令牌在「设置 → API 令牌」里创建，只显示一次。\n' +
      '- 权限 = 令牌的权限范围 ∩ 账号在团队里的权限；hub 本机的机器永远用不了。\n' +
      '- 限流：每个令牌每分钟 120 次请求、20 次 prompt，超了 429 + Retry-After。\n' +
      '- MCP：同一个令牌 POST `/openapi/v1/mcp`（streamable HTTP）。对外只暴露显式登记的工具（项目、任务、工作日志、会话事件；写工具要 `MCP_WRITE=1`，且必须带 `clientRequestId`）。\n' +
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
