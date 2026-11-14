import type { Context, Hono } from 'hono';
import { createPreviewRequest, previewLinkSchema } from '@agent-hub/contract';
import {
  createPreviewLinkUseCase,
  listPreviewLinksUseCase,
  removePreviewLinkUseCase,
  type PreviewDeps,
  type Subject,
} from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/** 预览链接的审计动作（`AuditAction` 里已加同名成员，这里只是收窄本文件用到的两项）。 */
export type PreviewAuditAction = 'preview.create' | 'preview.remove';

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

  app.get('/api/sessions/:sessionId/previews', async (c) => {
    const result = await listPreviewLinksUseCase(deps, subjectOf(c), c.req.param('sessionId'));
    return result.ok
      ? c.json({ links: result.value.map((link) => previewLinkSchema.parse(link)) })
      : fail(c, result.error);
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
    return c.json({ link: previewLinkSchema.parse(result.value) }, 201);
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
}
