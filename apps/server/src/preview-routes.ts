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
  terminalTarget,
  type PreviewDeps,
  type Subject,
  type WorkspaceId,
} from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';
import { z } from 'zod';
import type { PreviewChannel, PreviewStream } from './preview-channel.ts';
import type { PreviewProxy } from './preview-proxy.ts';

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
  /** Configured independent preview listener host, never supplied by the request. */
  readonly navigationHost?: string | null;
  readonly workflow?: {
    readonly host: string | null;
    readonly candidates: (sessionId: string) => Promise<readonly { port: number; workerId: string; root: string; workspaceId: WorkspaceId }[]>;
    readonly channel: PreviewChannel | null;
    readonly proxy: PreviewProxy | null;
    readonly workerOnline: (workerId: string) => Promise<boolean>;
  };
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
  const workflow = options.workflow;
  const busy = new Set<string>();
  let createQueue: Promise<void> = Promise.resolve();

  const mapping = (link: Parameters<typeof previewLinkPublic>[1]) => {
    const bound = workflow?.proxy?.listening().some((entry) => entry.linkId === link.id && entry.hubPort === link.hubPort) ?? false;
    return !workflow?.host || !workflow.proxy ? 'unavailable' as const : bound ? 'ready' as const : 'pending' as const;
  };
  const target = (candidate: { port: number; workerId: string }, link?: Parameters<typeof previewLinkPublic>[1]) => ({
    port: candidate.port, workerId: candidate.workerId, label: link?.label ?? null,
    linkId: link?.id ?? null,
    url: link && mapping(link) === 'ready' ? previewUrl(workflow!.host!, link.hubPort, false) : null,
    mapping: link ? mapping(link) : workflow?.host && workflow.proxy ? 'pending' as const : 'unavailable' as const,
  });

  app.get('/api/sessions/:sessionId/preview-workflow', async (c) => {
    if (!subjectOf(c)) return c.notFound();
    if (!workflow) return c.json({ available: false, targets: [] });
    const sessionId = c.req.param('sessionId');
    const listed = await listPreviewLinksUseCase(deps, subjectOf(c), sessionId);
    if (!listed.ok) return fail(c, listed.error);
    const before = await terminalTarget(deps, subjectOf(c), sessionId);
    if (!before.ok) return fail(c, before.error);
    const candidates = await workflow.candidates(sessionId);
    const checked = await listPreviewLinksUseCase(deps, subjectOf(c), sessionId);
    if (!checked.ok) return fail(c, checked.error);
    const actual = await terminalTarget(deps, subjectOf(c), sessionId);
    if (!actual.ok) return fail(c, actual.error);
    const workerId = actual.value.workerId ?? 'local';
    if (before.value.workerId !== actual.value.workerId || before.value.root !== actual.value.root) return fail(c, { code: 'conflict', message: '预览会话位置已改变' });
    const targets = candidates.filter((candidate) => candidate.workerId === workerId && candidate.root === actual.value.root).map((candidate) => target(candidate, checked.value.find((link) => link.port === candidate.port && link.workerId === candidate.workerId)));
    for (const link of checked.value) {
      if (link.source !== 'manual' || link.workerId !== workerId || targets.some((item) => item.port === link.port && item.workerId === link.workerId)) continue;
      targets.push(target(link, link));
    }
    return c.json({ available: Boolean(workflow.host && workflow.proxy), targets });
  });

  app.post('/api/sessions/:sessionId/preview-workflow', async (c) => {
    if (!workflow || !subjectOf(c)) return c.json({ error: { code: 'not_found', message: '预览工作流不可用' } }, 404);
    if (!workflow.host || !workflow.proxy) return fail(c, { code: 'conflict', message: '预览监听不可用' });
    const parsed = z.strictObject({ port: z.number().int().min(1024).max(65535) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法' });
    const sessionId = c.req.param('sessionId');
    const subject = subjectOf(c);
    const previous = createQueue;
    let release!: () => void;
    createQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const listed = await listPreviewLinksUseCase(deps, subject, sessionId);
      if (!listed.ok) return fail(c, listed.error);
      const before = await terminalTarget(deps, subject, sessionId);
      if (!before.ok) return fail(c, before.error);
      const found = (await workflow.candidates(sessionId)).filter((entry) => entry.port === parsed.data.port);
      const actual = await terminalTarget(deps, subject, sessionId);
      if (!actual.ok) return fail(c, actual.error);
      if (before.value.workerId !== actual.value.workerId || before.value.root !== actual.value.root) return fail(c, { code: 'conflict', message: '预览会话位置已改变' });
      const manual = listed.value.find((link) => link.source === 'manual' && link.port === parsed.data.port && link.workerId === (actual.value.workerId ?? 'local'));
      if (!manual && found.length !== 1) return fail(c, { code: 'conflict', message: '端口归属无法确认' });
      const candidate = manual ?? found[0]!;
      if ((actual.value.workerId ?? 'local') !== candidate.workerId) return fail(c, { code: 'conflict', message: '预览机器不匹配' });
      if (!manual && found[0]!.root !== actual.value.root) return fail(c, { code: 'conflict', message: '预览会话位置已改变' });
      const existing = listed.value.find((link) => link.port === candidate.port);
      if (existing && existing.workerId !== candidate.workerId) return fail(c, { code: 'conflict', message: '预览机器不匹配' });
      // terminalTarget inside the use case rechecks authorization after inventory collection.
      const created = await createPreviewLinkUseCase(deps, subject, { sessionId, port: candidate.port, source: 'detected', expectedTarget: { ...actual.value, ...(!manual ? { workspaceId: found[0]!.workspaceId } : {}) } });
      if (!created.ok) return fail(c, created.error);
      if (created.value.workerId !== candidate.workerId) return fail(c, { code: 'conflict', message: '预览机器不匹配' });
      await options.afterChange?.();
      return c.json({ target: target(candidate, created.value) });
    } finally { release(); }
  });

  app.post('/api/sessions/:sessionId/previews/:linkId/diagnostic', async (c) => {
    if (!workflow || !subjectOf(c)) return c.notFound();
    const sessionId = c.req.param('sessionId');
    const subject = subjectOf(c);
    const listed = await listPreviewLinksUseCase(deps, subject, sessionId);
    if (!listed.ok) return fail(c, listed.error);
    const link = listed.value.find((item) => item.id === c.req.param('linkId'));
    if (!link) return c.notFound();
    const destination = await terminalTarget(deps, subject, sessionId);
    if (!destination.ok) return fail(c, destination.error);
    if ((destination.value.workerId ?? 'local') !== link.workerId) return c.notFound();
    const result = (state: string, status: number | null = null) => ({ state, status, checkedAt: deps.now() });
    const channel = workflow.channel;
    const token = channel?.connectionToken?.(link.workerId) ?? null;
    const originalMapping = mapping(link);
    let diagnostic: ReturnType<typeof result>;
    if (!(await workflow.workerOnline(link.workerId))) diagnostic = result('worker_offline');
    else if (!token || !channel) diagnostic = result('channel_unavailable');
    else if (mapping(link) !== 'ready') diagnostic = result('listener_unavailable');
    else if (busy.has(link.workerId) || busy.size >= 16) diagnostic = result('indeterminate');
    else {
      busy.add(link.workerId);
      try {
        const rechecked = await listPreviewLinksUseCase(deps, subject, sessionId);
        if (!rechecked.ok) return fail(c, rechecked.error);
        const current = rechecked.value.find((item) => item.id === link.id);
        if (!current || current.createdAt !== link.createdAt || current.workerId !== link.workerId || current.port !== link.port || current.hubPort !== link.hubPort) return c.notFound();
        const currentDestination = await terminalTarget(deps, subject, sessionId);
        if (!currentDestination.ok) return fail(c, currentDestination.error);
        if (currentDestination.value.workerId !== destination.value.workerId || currentDestination.value.root !== destination.value.root) return c.notFound();
        if (channel.connectionToken?.(link.workerId) !== token || mapping(current) !== originalMapping) return c.json(result('indeterminate'));
        diagnostic = await new Promise<ReturnType<typeof result>>((resolve) => {
          let stream: PreviewStream | null = null;
          let settled = false;
          const finish = (value: ReturnType<typeof result>) => {
            if (settled) return;
            settled = true; clearTimeout(timer); stream?.close(); resolve(value);
          };
          const timer = setTimeout(() => finish(result('timeout')), 3000);
          void channel.open(link.workerId, { port: link.port, method: 'HEAD', path: '/', headers: [] }).then((opened) => {
            stream = opened;
            if (settled) { opened.close(); return; }
            opened.onHead((head) => finish(result('response', head.status)));
            opened.onError((error) => finish(result(error.code === 'refused' ? 'refused' : error.code === 'timeout' ? 'timeout' : 'indeterminate')));
            opened.endBody();
          }, () => finish(result('indeterminate')));
        });
      } finally { busy.delete(link.workerId); }
    }
    const again = await listPreviewLinksUseCase(deps, subject, sessionId);
    if (!again.ok) return fail(c, again.error);
    const current = again.value.find((item) => item.id === link.id);
    if (!current || current.workerId !== link.workerId || current.port !== link.port || current.hubPort !== link.hubPort || current.createdAt !== link.createdAt) return c.notFound();
    const finalDestination = await terminalTarget(deps, subject, sessionId);
    if (!finalDestination.ok) return fail(c, finalDestination.error);
    if (finalDestination.value.workerId !== destination.value.workerId || finalDestination.value.root !== destination.value.root) return c.notFound();
    if (token !== (channel?.connectionToken?.(link.workerId) ?? null) || mapping(current) !== originalMapping) diagnostic = result('indeterminate');
    return c.json(diagnostic);
  });

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
  /**
   * 列表里跳过坏行：一条不合约的数据（手工改库、旧版本写入）不该让整个预览页 500。
   * 单条（创建/查询）仍然严格——坏数据要立刻暴露。
   */
  const linksOf = (links: readonly Parameters<typeof previewLinkPublic>[1][]) => {
    const out: ReturnType<typeof dtoOf>[] = [];
    for (const link of links) {
      const parsed = previewLinkSchema.safeParse(previewLinkPublic(deps, link));
      if (parsed.success) out.push(parsed.data);
      else console.warn('[preview] 跳过一条不合契约的链接', link.id, parsed.error.issues[0]?.message);
    }
    return out;
  };

  app.get('/api/sessions/:sessionId/previews', async (c) => {
    const result = await listPreviewLinksUseCase(deps, subjectOf(c), c.req.param('sessionId'));
    if (!result.ok) return fail(c, result.error);
    const addressHost = options.navigationHost ?? workflow?.host ?? null;
    const addresses = Object.fromEntries(result.value.map((link) => [link.id, addressHost ? previewUrl(addressHost, link.hubPort, false) : null]));
    return c.json({ links: linksOf(result.value), addresses });
  });

  app.post('/api/sessions/:sessionId/previews', async (c) => {
    const subject = subjectOf(c);
    const parsed = createPreviewRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法' });
    const sessionId = c.req.param('sessionId');
    // 目前只有手动挂链接；`allowNonLoopback` 由代理层真正 bind 时判断（§5）。
    const previous = createQueue;
    let release!: () => void;
    createQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
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
    } finally { release(); }
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
