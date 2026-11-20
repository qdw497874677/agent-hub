// assets 能力的处理函数（从 app.ts 原样搬出；鉴权/限流/审计仍在 app.ts 的前导里）。
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { V1Runtime } from '../context.ts';
import { openapiOn, valid } from '../context.ts';
import type { Env } from '../context.ts';
import {
  can,
  conflict,
  submitAssetRevision,
  forbidden,
  importGitAsset,
  invalid,
  assetRevisions,
  pinAssetRevision,
  recordAssetAudit,
  setAssetInstalled,
  uploadAsset,
  notFound,
  authorizeAssetProject,
  authorizeAssetPublish,
  builtinAssetsFor,
  enableBuiltinAsset,
  assetViewOf,
  scopedTokenCreateDenied
} from '@agent-hub/domain';
import {
  assetSchema
} from '@agent-hub/contract';
import { fail } from '../../http-error.ts';
import {
  routes
} from '.././routes.ts';
import { createAssetVisibility } from '../../asset-visibility.ts';

/** installAssets：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installAssets(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  on(routes.listAssets, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'asset.read')) return fail(c, forbidden('令牌没有 assets:read'));
    if (!rt.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
    const kind = c.req.query('kind');
    const readable = createAssetVisibility({ access: rt.deps.access, projects: rt.deps.projects }, actor);
    const all = await rt.assetReview.assets.list();
    const visible = [];
    for (const asset of all) {
      if (kind !== undefined && asset.kind !== kind) continue;
      if (await readable(asset)) visible.push(asset);
    }
    return c.json(visible);
  });
  on(routes.listBuiltinAssets, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'asset.read')) return fail(c, forbidden('令牌没有 assets:read'));
    if (!rt.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
    const query = valid<{ projectId: string }>(c, 'query');
    // 与项目设置页同门：能改这个项目才看得到启用状态（令牌要 projects:write + 项目权限）。
    const listed = await builtinAssetsFor(rt.assetReview, actor, query.projectId);
    if (!listed.ok) return fail(c, listed.error);
    return c.json(listed.value);
  });
  on(routes.enableBuiltinAsset, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'asset.submit')) return fail(c, forbidden('令牌没有 assets:write：不能启用内置资产'));
    if (!rt.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
    const builtinId = c.req.param('builtinId') ?? '';
    const body = valid<{ projectId: string; secrets?: Record<string, string> }>(c, 'json');
    const made = await enableBuiltinAsset(rt.assetReview, actor, { projectId: body.projectId, builtinId, secrets: body.secrets });
    if (!made.ok) return fail(c, made.error);
    await recordAssetAudit(rt.assetReview, actor, 'asset.project', made.value.asset.name, `启用内置资产 ${builtinId} 到项目 ${body.projectId}${made.value.created ? '' : '（已在用，只打开项目开关）'}${rt.viaNote(actor)}`);
    return c.json({ asset: assetSchema.parse(await assetViewOf(rt.assetReview, made.value.asset)), created: made.value.created });
  });
  on(routes.getAsset, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'asset.read')) return fail(c, forbidden('令牌没有 assets:read'));
    if (!rt.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
    const asset = await rt.assetReview.assets.get(c.req.param('assetId') ?? '');
    if (!asset) return fail(c, notFound('资产不存在'));
    const readable = createAssetVisibility({ access: rt.deps.access, projects: rt.deps.projects }, actor);
    if (!(await readable(asset))) return fail(c, notFound('资产不存在'));
    const revisions = await assetRevisions(rt.assetReview, asset.id);
    if (!revisions.ok) return fail(c, revisions.error);
    return c.json({ asset, revisions: revisions.value });
  });
  on(routes.createAsset, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'asset.submit') || !can(actor, 'asset.read')) return fail(c, forbidden('令牌没有 assets:write'));
    if (!rt.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
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
      const allowed = await authorizeAssetProject(rt.assetReview, actor, input.projectId ?? null);
      if (!allowed.ok) return fail(c, allowed.error);
    }
    const files = input.files.map((file) => ({ path: file.path, data: new Uint8Array(Buffer.from(file.data, 'base64')) }));
    const made = await uploadAsset(rt.assetReview, {
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
    const actor = rt.principal(c);
    if (!can(actor, 'asset.submit') || !can(actor, 'asset.read')) return fail(c, forbidden('令牌没有 assets:write'));
    if (!rt.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
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
      const allowed = await authorizeAssetProject(rt.assetReview, actor, input.projectId ?? null);
      if (!allowed.ok) return fail(c, allowed.error);
    }
    const made = await importGitAsset(rt.assetReview, {
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
    await recordAssetAudit(rt.assetReview, actor, 'asset.create', made.value.name, `${made.value.kind} 从 ${input.url}@${path} 导入${made.value.pinned === '' ? '（待审核）' : '并发布'}${rt.viaNote(actor)}`);
    // 对外用列表同款视图（`workerIds`/`files`/`bytes`）；`tokenSecret` 是内部指针，不在契约里，parse 时被 strip。
    return c.json(assetSchema.parse(await assetViewOf(rt.assetReview, made.value)), 201);
  });
  on(routes.publishAsset, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'asset.review')) return fail(c, forbidden('令牌没有 assets:publish：不能发布资产'));
    if (!rt.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
    const asset = await rt.assetReview.assets.get(c.req.param('assetId') ?? '');
    if (!asset) return fail(c, notFound('资产不存在'));
    // 项目级资产（#230）：同团队但不是项目成员的令牌不能借 assets:publish 发布别人的项目资产。
    // 这一步放在可见性之前：项目成员才有 project.read，非成员在可见性那层只会得到 404；
    // 跨团队的仍按 404，别泄露资产存在。成员走下面的正常可见性 / 版本校验。
    if (asset.scope === 'project') {
      const allowed = await authorizeAssetPublish(rt.assetReview, actor, asset);
      if (!allowed.ok) return fail(c, allowed.error);
    }
    const readable = createAssetVisibility({ access: rt.deps.access, projects: rt.deps.projects }, actor);
    if (!(await readable(asset))) return fail(c, notFound('资产不存在'));
    if (asset.scope === 'global' && !actor.user.clusterAdmin) return fail(c, forbidden('只有集群管理员能发布全局资产'));
    if (asset.latest === '' || asset.latest === asset.pinned) return fail(c, conflict('没有待发布的新版本：latest 已经是线上版本'));
    const published = await pinAssetRevision(rt.assetReview, asset.id, asset.latest);
    if (!published.ok) return fail(c, published.error);
    const next = published.value;
    await recordAssetAudit(rt.assetReview, actor, 'asset.publish', next.name, `${next.kind} ${next.scope} 发布 ${next.pinned.slice(0, 12)}${rt.viaNote(actor)}`);
    return c.json(assetSchema.parse(await assetViewOf(rt.assetReview, next)));
  });
  on(routes.assignAsset, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'asset.assign')) return fail(c, forbidden('令牌没有 assets:publish：不能分配资产'));
    if (!rt.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
    const asset = await rt.assetReview.assets.get(c.req.param('assetId') ?? '');
    if (!asset) return fail(c, notFound('资产不存在'));
    const readable = createAssetVisibility({ access: rt.deps.access, projects: rt.deps.projects }, actor);
    if (!(await readable(asset))) return fail(c, notFound('资产不存在'));
    const input = valid<{ workerId: string; installed: boolean }>(c, 'json');
    const done = await setAssetInstalled(rt.assetReview, { workerId: input.workerId, assetId: asset.id, installed: input.installed }, { actor, policy: rt.assetReview.policy });
    if (!done.ok) return fail(c, done.error);
    await recordAssetAudit(
      rt.assetReview,
      actor,
      input.installed ? 'asset.install' : 'asset.uninstall',
      asset.name,
      `${asset.kind} ${input.installed ? '装到' : '从'}机器 ${input.workerId}${input.installed ? ' 上' : ' 卸下'}${rt.viaNote(actor)}`
    );
    return c.json({ assetId: asset.id, workerId: input.workerId, installed: input.installed });
  });
  on(routes.submitAssetRevision, async (c) => {
    if (!rt.assetReview) return fail(c, { code: 'not_implemented', message: '没装资产中心' });
    const body = valid<{ files: { path: string; data: string }[] }>(c, 'json');
    const files = body.files.map((file) => ({ path: file.path, data: new Uint8Array(Buffer.from(file.data, 'base64')) }));
    const result = await submitAssetRevision(rt.assetReview, rt.principal(c), c.req.param('assetId') ?? '', files);
    if (!result.ok) return fail(c, result.error);
    const { asset, submission } = result.value;
    return c.json({ assetId: asset.id, latest: asset.latest, submissionId: submission?.id ?? null, status: submission?.status ?? null });
  });
}
