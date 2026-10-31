import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  approveRequest,
  commentRequest,
  installDecisionRequest,
  marketGitRequest,
  marketRevisionRequest,
  marketUploadRequest,
  notificationsReadRequest,
  reasonRequest,
  rejectRequest,
  reviewSettingsRequest,
  scopedSecretRequest
} from '@agent-hub/contract';
import type { AssetReviewDeps, DomainError, IncomingFile, Principal, Result } from '@agent-hub/domain';
import {
  ASSET_LIMITS,
  approveSubmission,
  assetCatalog,
  assetFileText,
  checkGitForReview,
  commentOnSubmission,
  decideInstallRequest,
  diffAssetRevisions,
  installRequestsFor,
  invalid,
  listNotifications,
  marketAssetDetail,
  marketWorkers,
  markNotificationsRead,
  myAssets,
  promoteAsset,
  rejectSubmission,
  reviewQueue,
  reviewSettingsFor,
  revokeAsset,
  scopedSecrets,
  setAssetOnWorker,
  setReviewSettings,
  setScopedSecret,
  submissionDetail,
  submitAssetRevision,
  submitNewAsset,
  withdrawSubmission
} from '@agent-hub/domain';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 资产市场 + 审核（ADR 0016，docs/design/asset-review.md）：/api/assets/*、/api/notifications。
 * 每个登录成员都能用；谁能看 / 批 / 装全由 domain 判断，这里只解析与转 DTO。
 */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

const decodeFiles = (files: readonly { path: string; data: string }[]): IncomingFile[] =>
  files.map((file) => ({ path: file.path, data: new Uint8Array(Buffer.from(file.data, 'base64')) }));

const uploadLimit = bodyLimit({
  maxSize: Math.ceil((ASSET_LIMITS.maxTotalBytes * 4) / 3) + 512 * 1024,
  onError: (c) => fail(c, invalid('文件合计超过 4 MB')) as never
});

export function installAssetMarket(app: Hono, deps: AssetReviewDeps, principalOf: PrincipalOf): void {
  const actors = new WeakMap<Context, Principal>();
  for (const path of ['/api/assets', '/api/assets/*', '/api/notifications', '/api/notifications/*']) {
    app.use(path, async (c, next) => {
      const principal = principalOf(c);
      if (!principal) return c.json({ error: { code: 'unauthenticated', message: '请先登录' } }, 401);
      actors.set(c, principal);
      return next();
    });
  }
  const me = (c: Context): Principal => actors.get(c) as Principal;
  const body = async <T>(c: Context, schema: Schema<T>): Promise<T | null> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  };
  const reply = <T>(c: Context, result: Result<T, DomainError>, status: 200 | 201 = 200) =>
    result.ok ? c.json(result.value as object, status) : fail(c, result.error);
  const bad = (c: Context) => fail(c, invalid('请求体不合法'));

  // ---- 市场 ----
  app.get('/api/assets/catalog', async (c) => c.json(await assetCatalog(deps, me(c))));
  app.get('/api/assets/mine', async (c) => c.json(await myAssets(deps, me(c))));
  app.get('/api/assets/reviews', async (c) => c.json(await reviewQueue(deps, me(c))));
  app.get('/api/assets/workers', async (c) => c.json(await marketWorkers(deps, me(c))));
  app.get('/api/assets/install-requests', async (c) => c.json(await installRequestsFor(deps, me(c))));
  app.get('/api/assets/settings', async (c) => c.json(await reviewSettingsFor(deps, me(c))));
  app.put('/api/assets/settings', async (c) => {
    const input = await body(c, reviewSettingsRequest);
    if (!input) return bad(c);
    return reply(c, await setReviewSettings(deps, me(c), input.target, { reviewers: input.reviewers, twoReviewers: input.twoReviewers }));
  });
  app.get('/api/assets/secrets', async (c) => c.json(await scopedSecrets(deps, me(c))));
  app.put('/api/assets/secrets/:layer/:name', async (c) => {
    const layer = c.req.param('layer');
    if (layer !== 'personal' && layer !== 'team') return bad(c);
    const input = await body(c, scopedSecretRequest);
    if (!input) return bad(c);
    const result = await setScopedSecret(deps, me(c), layer, c.req.param('name'), input.value);
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  });
  app.delete('/api/assets/secrets/:layer/:name', async (c) => {
    const layer = c.req.param('layer');
    if (layer !== 'personal' && layer !== 'team') return bad(c);
    const result = await setScopedSecret(deps, me(c), layer, c.req.param('name'), null);
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  });

  app.post('/api/assets/upload', uploadLimit, async (c) => {
    const input = await body(c, marketUploadRequest);
    if (!input) return bad(c);
    const result = await submitNewAsset(deps, me(c), { from: 'upload', ...input, files: decodeFiles(input.files) });
    return result.ok ? c.json({ assetId: result.value.asset.id, submissionId: result.value.submission.id, status: result.value.submission.status }, 201) : fail(c, result.error);
  });
  app.post('/api/assets/git', async (c) => {
    const input = await body(c, marketGitRequest);
    if (!input) return bad(c);
    const result = await submitNewAsset(deps, me(c), { from: 'git', ...input, url: input.url.trim(), ref: input.ref?.trim() || null });
    return result.ok ? c.json({ assetId: result.value.asset.id, submissionId: result.value.submission.id, status: result.value.submission.status }, 201) : fail(c, result.error);
  });

  app.get('/api/assets/items/:assetId', async (c) => reply(c, await marketAssetDetail(deps, me(c), c.req.param('assetId'))));
  app.post('/api/assets/items/:assetId/revisions', uploadLimit, async (c) => {
    const input = await body(c, marketRevisionRequest);
    if (!input) return bad(c);
    const result = await submitAssetRevision(deps, me(c), c.req.param('assetId'), decodeFiles(input.files));
    return result.ok ? c.json({ latest: result.value.asset.latest, submissionId: result.value.submission?.id ?? null }) : fail(c, result.error);
  });
  app.post('/api/assets/items/:assetId/check', async (c) => {
    const result = await checkGitForReview(deps, me(c), c.req.param('assetId'));
    return result.ok ? c.json({ latest: result.value.asset.latest, submissionId: result.value.submission?.id ?? null }) : fail(c, result.error);
  });
  app.post('/api/assets/items/:assetId/promote', async (c) => {
    const result = await promoteAsset(deps, me(c), c.req.param('assetId'));
    return result.ok ? c.json({ submissionId: result.value.id }) : fail(c, result.error);
  });
  app.post('/api/assets/items/:assetId/revoke', async (c) => {
    const input = await body(c, reasonRequest);
    if (!input) return bad(c);
    const result = await revokeAsset(deps, me(c), c.req.param('assetId'), input.reason);
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  });
  app.put('/api/assets/items/:assetId/workers/:workerId', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { installed?: unknown } | null;
    if (!input || typeof input.installed !== 'boolean') return bad(c);
    return reply(c, await setAssetOnWorker(deps, me(c), { assetId: c.req.param('assetId'), workerId: c.req.param('workerId'), installed: input.installed }));
  });

  // ---- 审核 ----
  app.get('/api/assets/reviews/:submissionId', async (c) => reply(c, await submissionDetail(deps, me(c), c.req.param('submissionId'))));
  app.get('/api/assets/reviews/:submissionId/diff', async (c) => {
    const detail = await submissionDetail(deps, me(c), c.req.param('submissionId'));
    if (!detail.ok) return fail(c, detail.error);
    const { submission } = detail.value;
    if (!submission.previous) return c.json({ files: null });
    return reply(c, await diffAssetRevisions(deps, submission.assetId, submission.previous, submission.digest).then((r) => (r.ok ? { ok: true as const, value: { files: r.value } } : r)));
  });
  app.get('/api/assets/reviews/:submissionId/file', async (c) => {
    const detail = await submissionDetail(deps, me(c), c.req.param('submissionId'));
    if (!detail.ok) return fail(c, detail.error);
    const result = await assetFileText(deps, detail.value.submission.assetId, detail.value.submission.digest, c.req.query('path') ?? '');
    return result.ok ? c.json({ text: result.value }) : fail(c, result.error);
  });
  app.post('/api/assets/reviews/:submissionId/approve', async (c) => {
    const input = await body(c, approveRequest);
    if (!input) return bad(c);
    return reply(c, await approveSubmission(deps, me(c), c.req.param('submissionId'), input));
  });
  app.post('/api/assets/reviews/:submissionId/reject', async (c) => {
    const input = await body(c, rejectRequest);
    if (!input) return bad(c);
    return reply(c, await rejectSubmission(deps, me(c), c.req.param('submissionId'), input));
  });
  app.post('/api/assets/reviews/:submissionId/withdraw', async (c) => reply(c, await withdrawSubmission(deps, me(c), c.req.param('submissionId'))));
  app.post('/api/assets/reviews/:submissionId/comments', async (c) => {
    const input = await body(c, commentRequest);
    if (!input) return bad(c);
    return reply(c, await commentOnSubmission(deps, me(c), c.req.param('submissionId'), input), 201);
  });
  app.post('/api/assets/install-requests/:requestId', async (c) => {
    const input = await body(c, installDecisionRequest);
    if (!input) return bad(c);
    return reply(c, await decideInstallRequest(deps, me(c), c.req.param('requestId'), input));
  });

  // ---- 站内通知 ----
  app.get('/api/notifications', async (c) => c.json(await listNotifications(deps, me(c))));
  app.post('/api/notifications/read', async (c) => {
    const input = await body(c, notificationsReadRequest);
    if (!input) return bad(c);
    await markNotificationsRead(deps, me(c), input.ids);
    return c.json({ ok: true });
  });
}
