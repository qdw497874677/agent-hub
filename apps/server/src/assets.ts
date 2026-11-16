import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  assetDiffSchema,
  assetInstallRequest,
  assetPinRequest,
  assetRevisionSchema,
  assetRevisionUploadRequest,
  assetSetInput,
  assetSetSchema,
  assetUploadRequest,
  assetsOverviewSchema,
  gitImportRequest,
  gitScanRequest,
  gitScanSchema,
  projectAssetPlanSchema,
  projectAssetRequest,
  projectAssetsSchema,
  secretPutRequest,
  secretsOverviewSchema
} from '@agent-hub/contract';
import type { AssetReviewDeps, AssetSet, AssetSetDeps, AssetSetRepository, AuditLog, EnvironmentPlanner, IncomingFile, Principal, Session, SessionAssetEntry, SessionRepository } from '@agent-hub/domain';
import {
  ASSET_KIND_LABEL,
  ASSET_LIMITS,
  assetFileText,
  assetRevisions,
  assetsOverview,
  asSessionId,
  checkGitForReview,
  conflict,
  createAssetSetUseCase,
  listAssetSetsUseCase,
  notFound,
  recordAdminPublish,
  removeAssetSetUseCase,
  submitAssetRevision,
  updateAssetSetUseCase,
  deleteAsset,
  deleteSecret,
  listSecrets,
  setSecret,
  diffAssetRevisions,
  importGitAsset,
  invalid,
  parseGitSourceUrl,
  pinAssetRevision,
  projectAssets,
  setProjectAsset,
  recordAssetAudit,
  scanGitSource,
  setAssetInstalled,
  unavailable,
  uploadAsset
} from '@agent-hub/domain';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 资产中心的 HTTP 外壳（docs/design/asset-hub.md）：/api/admin/assets/*，主人专用
 * （/api/admin/* 的守门中间件在 admin.ts）。规则全在 domain，这里只做解析、审计、DTO。
 */
export interface AssetRouteOptions {
  readonly deps: AssetReviewDeps;
  readonly audit: AuditLog;
  /** 资产组合仓库：组合 CRUD 与项目绑定用（不属于资产中心本身）。 */
  readonly assetSets?: AssetSetRepository;
  /** #226 P2：升级会话资产快照要读会话与重新解析环境（server 组装时注入）。 */
  readonly sessions?: Pick<SessionRepository, 'byId'>;
  readonly environment?: EnvironmentPlanner;
  /**
   * 派生前预览：这个项目在这台机器上实际会带哪些资产（#226 会话级资产选择）。
   * 返回 'forbidden' 表示调用方看不见该项目（路由转 404，不泄露存在）。
   */
  readonly planOf?: (projectId: string, workerId: string, principal: Principal) => Promise<readonly SessionAssetEntry[] | 'forbidden'>;
}

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

async function parse<T>(c: Context, schema: Schema<T>): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, response: fail(c, invalid('请求体不合法')) };
}

const decodeFiles = (files: readonly { path: string; data: string }[]): IncomingFile[] =>
  files.map((file) => ({ path: file.path, data: new Uint8Array(Buffer.from(file.data, 'base64')) }));

/** 上传的 JSON 外壳：base64 膨胀 4/3，再留点给路径和字段。 */
const uploadLimit = bodyLimit({
  maxSize: Math.ceil((ASSET_LIMITS.maxTotalBytes * 4) / 3) + 512 * 1024,
  onError: (c) => fail(c, invalid('文件合计超过 4 MB')) as never
});

export function installAssetRoutes(app: Hono, options: AssetRouteOptions, principalOf: PrincipalOf): void {
  const { deps } = options;
  // 登录态按 c.req.raw 记；bodyLimit 会换掉 raw，所以先按 Context 记下操作者（/api/admin/* 已确认是主人）
  const actors = new WeakMap<Context, Principal>();
  app.use('/api/admin/assets/*', async (c, next) => {
    const principal = principalOf(c);
    if (principal) actors.set(c, principal);
    return next();
  });
  const actor = (c: Context): Principal => actors.get(c) ?? (principalOf(c) as Principal);
  const adminOwnership = (c: Context, projectId: string | null) => {
    const who = actor(c);
    return { scope: projectId ? ('project' as const) : ('global' as const), ownerId: who.user.id, teamId: who.user.teamId, publish: true };
  };
  const audit = (c: Context, action: Parameters<typeof recordAssetAudit>[2], target: string, detail: string) =>
    recordAssetAudit({ audit: options.audit, now: deps.now }, actor(c), action, target, detail);

  // 资产组合（团队级）：登录即可读，写操作由用例判权限。
  for (const path of ['/api/asset-sets', '/api/asset-sets/*']) {
    app.use(path, async (c, next) => {
      const principal = principalOf(c);
      if (!principal) return c.json({ error: { code: 'unauthenticated', message: '请先登录' } }, 401);
      actors.set(c, principal);
      return next();
    });
  }
  const setDeps = (): AssetSetDeps => ({
    assetSets: options.assetSets as AssetSetRepository,
    assets: deps.assets,
    projects: deps.projects,
    audit: options.audit,
    now: deps.now
  });
  const setDto = (set: AssetSet) => assetSetSchema.parse({ ...set, assetIds: set.items.map((item) => item.assetId) });

  app.get('/api/asset-sets', async (c) => {
    const result = await listAssetSetsUseCase(setDeps(), actor(c));
    if (!result.ok) return fail(c, result.error);
    return c.json({ sets: result.value.map(setDto) });
  });

  app.post('/api/asset-sets', async (c) => {
    const parsed = await parse(c, assetSetInput);
    if (!parsed.ok) return parsed.response;
    const result = await createAssetSetUseCase(setDeps(), actor(c), parsed.value);
    if (!result.ok) return fail(c, result.error);
    return c.json(setDto(result.value), 201);
  });

  app.patch('/api/asset-sets/:id', async (c) => {
    const parsed = await parse(c, assetSetInput);
    if (!parsed.ok) return parsed.response;
    const result = await updateAssetSetUseCase(setDeps(), actor(c), c.req.param('id'), parsed.value);
    if (!result.ok) return fail(c, result.error);
    return c.json(setDto(result.value));
  });

  app.delete('/api/asset-sets/:id', async (c) => {
    const result = await removeAssetSetUseCase(setDeps(), actor(c), c.req.param('id'));
    if (!result.ok) return fail(c, result.error);
    return c.json({ ok: true });
  });

  // 会话用了哪些资产（启动那一刻记下的清单）：成员也能看，只读。
  app.get('/api/sessions/:sessionId/assets', async (c) => {
    const manifest = await deps.assets.sessionAssets(c.req.param('sessionId'));
    return c.json(manifest ?? { sessionId: c.req.param('sessionId'), workerId: null, entries: [], at: null });
  });

  // 派生前预览项目生效资产：派生对话框据此列出可取消勾选的技能/指令/MCP。
  app.get('/api/projects/:projectId/assets', async (c) => {
    const planOf = options.planOf;
    if (!planOf) return fail(c, unavailable('资产预览尚未就绪'));
    const workerId = c.req.query('workerId');
    if (typeof workerId !== 'string' || workerId === '') return fail(c, invalid('workerId 必填：资产是否下发取决于机器'));
    const principal = principalOf(c);
    if (!principal) return fail(c, notFound('项目不存在'));
    const projectId = c.req.param('projectId');
    const entries = await planOf(projectId, workerId, principal);
    if (entries === 'forbidden') return fail(c, notFound('项目不存在'));
    return c.json(projectAssetPlanSchema.parse({ projectId, workerId, assetIds: entries.map((entry) => entry.assetId), entries }));
  });

  // #226 P2：显式升级本会话资产。重新解析当前生效集、写新快照，下一次重新托管时生效。
  // 权限沿用 access 模型（session.prompt：owner/member 都可）；升级本身不改 environmentRevision。
  app.post('/api/sessions/:sessionId/assets/upgrade', async (c) => {
    const sessions = options.sessions;
    const upgrade = options.environment?.upgrade;
    if (!sessions || !upgrade) return fail(c, unavailable('会话环境升级尚未就绪'));
    const sessionId = asSessionId(c.req.param('sessionId'));
    const session: Session | null = await sessions.byId(sessionId);
    if (!session) return fail(c, notFound('会话不存在'));
    const result = await upgrade(session);
    if (!result) return fail(c, conflict('会话还没有资产快照，不能升级（先启动一次）'));
    await audit(
      c,
      'asset.session_upgrade',
      sessionId,
      `资产快照升级：${result.from.length} → ${result.to.length} 项（${result.changed ? '有变化' : '无变化'}）`
    );
    return c.json(result);
  });

  // 运营后台只管 hub 运营的资产（全局 / 项目级）；团队、个人资产在资产市场里（ADR 0016）。
  app.get('/api/admin/assets', async (c) => {
    const overview = await assetsOverview(deps);
    const assets = overview.assets.filter((asset) => asset.scope === 'global' || asset.scope === 'project');
    return c.json(assetsOverviewSchema.parse({ ...overview, assets }));
  });

  // 密钥：值只进不出（PUT 写入后界面再也看不到它）；审计只记名字。
  app.get('/api/admin/assets/secrets', async (c) => c.json(secretsOverviewSchema.parse(await listSecrets(deps))));
  app.put('/api/admin/assets/secrets/:name', async (c) => {
    const input = await parse(c, secretPutRequest);
    if (!input.ok) return input.response;
    const name = c.req.param('name');
    const result = await setSecret(deps, name, input.value.value);
    if (!result.ok) return fail(c, result.error);
    await audit(c, 'asset.secret.set', name, '设置密钥（值不记录）');
    return c.json({ ok: true });
  });
  app.delete('/api/admin/assets/secrets/:name', async (c) => {
    const name = c.req.param('name');
    const result = await deleteSecret(deps, name);
    if (!result.ok) return fail(c, result.error);
    await audit(c, 'asset.secret.delete', name, '删除密钥');
    return c.json({ ok: true });
  });

  // 项目设置里的资产开关（主人专用，同 /api/admin/*）：enabled=null 恢复默认。
  app.get('/api/admin/assets/projects/:projectId', async (c) => {
    const result = await projectAssets(deps, c.req.param('projectId'));
    return result.ok ? c.json(projectAssetsSchema.parse(result.value)) : fail(c, result.error);
  });
  app.put('/api/admin/assets/projects/:projectId/:assetId', async (c) => {
    const input = await parse(c, projectAssetRequest);
    if (!input.ok) return input.response;
    const { projectId, assetId } = c.req.param();
    const result = await setProjectAsset(deps, { projectId, assetId, enabled: input.value.enabled });
    if (!result.ok) return fail(c, result.error);
    const asset = await deps.assets.get(assetId);
    const state = input.value.enabled === null ? '恢复默认' : input.value.enabled ? '启用' : '停用';
    await audit(c, 'asset.project', asset?.name ?? assetId, `项目 ${projectId}：${state}`);
    return c.json({ ok: true });
  });

  app.post('/api/admin/assets/upload', uploadLimit, async (c) => {
    const input = await parse(c, assetUploadRequest);
    if (!input.ok) return input.response;
    const made = await uploadAsset(deps, {
      kind: input.value.kind,
      name: input.value.name ?? null,
      projectId: input.value.projectId ?? null,
      files: decodeFiles(input.value.files),
      ...adminOwnership(c, input.value.projectId ?? null)
    });
    if (!made.ok) return fail(c, made.error);
    await audit(c, 'asset.create', made.value.name, `上传${ASSET_KIND_LABEL[made.value.kind]} ${made.value.pinned.slice(0, 12)}`);
    await recordAdminPublish(deps, actor(c), made.value, made.value.pinned, '运营后台上传即发布');
    return c.json({ id: made.value.id }, 201);
  });

  app.post('/api/admin/assets/git/scan', async (c) => {
    const input = await parse(c, gitScanRequest);
    if (!input.ok) return input.response;
    const parsed = parseGitSourceUrl(input.value.url);
    const scanned = await scanGitSource(deps, parsed?.url ?? input.value.url.trim(), input.value.ref?.trim() || parsed?.ref || null);
    return scanned.ok ? c.json(gitScanSchema.parse(scanned.value)) : fail(c, scanned.error);
  });

  app.post('/api/admin/assets/git/import', async (c) => {
    const input = await parse(c, gitImportRequest);
    if (!input.ok) return input.response;
    const parsed = parseGitSourceUrl(input.value.url);
    const made = await importGitAsset(deps, {
      kind: input.value.kind,
      url: parsed?.url ?? input.value.url.trim(),
      ref: input.value.ref?.trim() || parsed?.ref || null,
      path: input.value.path.trim() === '' ? parsed?.path ?? '' : input.value.path,
      policy: input.value.policy,
      name: input.value.name ?? null,
      projectId: input.value.projectId ?? null,
      ...adminOwnership(c, input.value.projectId ?? null)
    });
    if (!made.ok) return fail(c, made.error);
    await audit(c, 'asset.create', made.value.name, `从 git 导入 ${input.value.url.trim()} ${input.value.path}`);
    await recordAdminPublish(deps, actor(c), made.value, made.value.pinned, '运营后台导入即发布');
    return c.json({ id: made.value.id }, 201);
  });

  app.get('/api/admin/assets/:assetId/revisions', async (c) => {
    const result = await assetRevisions(deps, c.req.param('assetId'));
    return result.ok ? c.json(result.value.map((revision) => assetRevisionSchema.parse(revision))) : fail(c, result.error);
  });

  app.get('/api/admin/assets/:assetId/file', async (c) => {
    const digest = c.req.query('digest') ?? '';
    const path = c.req.query('path') ?? '';
    const result = await assetFileText(deps, c.req.param('assetId'), digest, path);
    return result.ok ? c.json({ text: result.value }) : fail(c, result.error);
  });

  app.get('/api/admin/assets/:assetId/diff', async (c) => {
    const result = await diffAssetRevisions(deps, c.req.param('assetId'), c.req.query('from') ?? '', c.req.query('to') ?? '');
    return result.ok ? c.json(assetDiffSchema.parse({ files: result.value })) : fail(c, result.error);
  });

  app.post('/api/admin/assets/:assetId/revisions', uploadLimit, async (c) => {
    const input = await parse(c, assetRevisionUploadRequest);
    if (!input.ok) return input.response;
    // 新版本不直接上线：开一个待审提交（ADR 0016），管理员可在审核页批，或在这里「钉到」它（记为自批）。
    const result = await submitAssetRevision(deps, actor(c), c.req.param('assetId'), decodeFiles(input.value.files));
    if (!result.ok) return fail(c, result.error);
    const changed = result.value.submission !== null;
    return c.json({ changed, latest: result.value.asset.latest, submissionId: result.value.submission?.id ?? null });
  });

  app.post('/api/admin/assets/:assetId/check', async (c) => {
    // 5A：来源有新版本 → 待审提交，已钉的老版本照常用。
    const result = await checkGitForReview(deps, actor(c), c.req.param('assetId'));
    if (!result.ok) return fail(c, result.error);
    return c.json({ changed: result.value.submission !== null, latest: result.value.asset.latest, submissionId: result.value.submission?.id ?? null });
  });

  app.post('/api/admin/assets/:assetId/pin', async (c) => {
    const input = await parse(c, assetPinRequest);
    if (!input.ok) return input.response;
    const result = await pinAssetRevision(deps, c.req.param('assetId'), input.value.digest);
    if (!result.ok) return fail(c, result.error);
    await audit(c, 'asset.pin', result.value.name, `钉到 ${input.value.digest.slice(0, 12)}`);
    await recordAdminPublish(deps, actor(c), result.value, input.value.digest, '运营后台钉版本');
    return c.json({ ok: true });
  });

  app.delete('/api/admin/assets/:assetId', async (c) => {
    const asset = await deps.assets.get(c.req.param('assetId'));
    const result = await deleteAsset(deps, c.req.param('assetId'));
    if (!result.ok) return fail(c, result.error);
    await audit(c, 'asset.delete', asset?.name ?? c.req.param('assetId'), '删除资产（已装的机器会一并移除）');
    return c.json({ ok: true });
  });

  app.put('/api/admin/assets/:assetId/workers/:workerId', async (c) => {
    const input = await parse(c, assetInstallRequest);
    if (!input.ok) return input.response;
    const { assetId, workerId } = c.req.param();
    const result = await setAssetInstalled(deps, { workerId, assetId, installed: input.value.installed });
    if (!result.ok) return fail(c, result.error);
    const asset = await deps.assets.get(assetId);
    await audit(c, input.value.installed ? 'asset.install' : 'asset.uninstall', asset?.name ?? assetId, `机器 ${workerId}`);
    return c.json({ ok: true });
  });
}
