import type { Context, Hono } from 'hono';
import { createPreviewRequest, previewLinkSchema, sharePreviewRequest } from '@agent-hub/contract';
import {
  createPreviewLinkUseCase,
  listPreviewLinksUseCase,
  previewLinkPublic,
  previewUrl,
  removePreviewLinkUseCase,
  revokePreviewShareUseCase,
  sharePreviewLinkUseCase,
  type PreviewDeps,
  type Subject,
} from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/** 预览链接的审计动作（`AuditAction` 里已加同名成员，这里只是收窄本文件用到的几项）。 */
export type PreviewAuditAction = 'preview.create' | 'preview.remove' | 'preview.share' | 'preview.unshare';

export interface PreviewApiOptions {
  /**
   * 数据面依赖。`previewPorts` 不在这里 —— 端口区间单独给，
   * 组合根通常是 `parsePreviewPortRange(process.env.HUB_PREVIEW_PORTS, hubPort)`。
   *
   * 需要传：`projects`、`tasks`、`sessions`、`workspaces`、`access`、`now`、
   * `previewLinks`（`store.previewLinks`），以及可选的 `previewPortFree`。
   */
  readonly deps: Omit<PreviewDeps, 'previewPorts'>;
  /** hub 侧可分配的预览端口区间。 */
  readonly ports: { readonly from: number; readonly to: number };
  /**
   * 链接增删之后叫一声（组合根用它把端口监听立刻对齐）。
   * 不传就等定期对账，新建的链接最多晚一个周期才有端口。
   */
  readonly afterChange?: () => void | Promise<void>;
  /**
   * 拼分享链接用的对外主机名（不含端口）。不传就取请求的 `Host` 头，
   * 再没有就退回 `localhost`。
   */
  readonly publicHost?: string;
  /** 拼分享链接用 https；不传就看 `x-forwarded-proto`，默认 http。 */
  readonly https?: boolean;
}

export interface PreviewRouteOptions extends PreviewApiOptions {
  readonly audit?: (
    c: Context,
    subject: Subject | null,
    action: PreviewAuditAction,
    target: string,
    detail: string,
  ) => Promise<void>;
}

/**
 * 预览链接的 HTTP 面（docs/design/preview.md §4）：
 *
 * - `GET    /api/sessions/:sessionId/previews`           → `{ links: PreviewLinkDto[] }`
 * - `POST   /api/sessions/:sessionId/previews`           → 201 `{ link }`（body `createPreviewRequest`）
 * - `DELETE /api/sessions/:sessionId/previews/:linkId`   → `{ ok: true }`
 *
 * 三条路由都走 `session.read`（会话本人/同团队可见），别人一律 404。
 */
export function installPreviewRoutes(app: Hono<any>, options: PreviewRouteOptions, subjectOf: SubjectOf): void {
  const deps: PreviewDeps = { ...options.deps, previewPorts: options.ports };

  /** 分享链接的对外主机：显式配置 > 请求 Host > localhost。 */
  const hostOf = (c: Context): string => {
    if (options.publicHost !== undefined && options.publicHost !== '') return options.publicHost;
    const header = (c.req.header('host') ?? '').trim();
    if (header === '') return 'localhost';
    if (header.startsWith('[')) {
      const end = header.indexOf(']');
      return end === -1 ? header : header.slice(0, end + 1);
    }
    const colon = header.indexOf(':');
    return colon === -1 ? header : header.slice(0, colon);
  };
  const httpsOf = (c: Context): boolean =>
    options.https ?? (c.req.header('x-forwarded-proto') ?? '').toLowerCase() === 'https';
  const dtoOf = (link: Parameters<typeof previewLinkPublic>[1]) =>
    previewLinkSchema.parse(previewLinkPublic(deps, link));

  app.get('/api/sessions/:sessionId/previews', async (c) => {
    const result = await listPreviewLinksUseCase(deps, subjectOf(c), c.req.param('sessionId'));
    return result.ok ? c.json({ links: result.value.map((link) => dtoOf(link)) }) : fail(c, result.error);
  });

  app.post('/api/sessions/:sessionId/previews', async (c) => {
    const subject = subjectOf(c);
    const parsed = createPreviewRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法' });
    const sessionId = c.req.param('sessionId');
    // 目前只有手动挂链接；`allowNonLoopback` 由代理层真正 bind 时判断（§5）。
    const result = await createPreviewLinkUseCase(deps, subject, {
      sessionId,
      port: parsed.data.port,
      ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
      source: 'manual',
    });
    if (!result.ok) return fail(c, result.error);
    await options.audit?.(c, subject, 'preview.create', sessionId, `端口 ${result.value.port} → :${result.value.hubPort}`);
    await options.afterChange?.();
    return c.json({ link: dtoOf(result.value) }, 201);
  });

  app.delete('/api/sessions/:sessionId/previews/:linkId', async (c) => {
    const sessionId = c.req.param('sessionId');
    const linkId = c.req.param('linkId');
    const result = await removePreviewLinkUseCase(deps, subjectOf(c), sessionId, linkId);
    if (!result.ok) return fail(c, result.error);
    await options.audit?.(c, subjectOf(c), 'preview.remove', sessionId, `删掉预览链接 ${linkId}`);
    await options.afterChange?.();
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:sessionId/previews/:linkId/share', async (c) => {
    const subject = subjectOf(c);
    const sessionId = c.req.param('sessionId');
    const linkId = c.req.param('linkId');
    const body = await c.req.json().catch(() => null);
    const parsed = sharePreviewRequest.safeParse(body ?? {});
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法' });
    const result = await sharePreviewLinkUseCase(deps, subject, {
      sessionId,
      linkId,
      ...(parsed.data.hours === undefined ? {} : { hours: parsed.data.hours }),
    });
    if (!result.ok) return fail(c, result.error);
    const url = `${previewUrl(hostOf(c), result.value.link.hubPort, httpsOf(c))}?share=${encodeURIComponent(result.value.token)}`;
    await options.audit?.(c, subject, 'preview.share', sessionId, `分享预览链接 ${linkId}，到期 ${result.value.expiresAt}`);
    return c.json({ ok: true, url, expiresAt: result.value.expiresAt });
  });

  app.delete('/api/sessions/:sessionId/previews/:linkId/share', async (c) => {
    const sessionId = c.req.param('sessionId');
    const linkId = c.req.param('linkId');
    const result = await revokePreviewShareUseCase(deps, subjectOf(c), { sessionId, linkId });
    if (!result.ok) return fail(c, result.error);
    await options.audit?.(c, subjectOf(c), 'preview.unshare', sessionId, `取消分享预览链接 ${linkId}`);
    return c.json({ ok: true });
  });
}
