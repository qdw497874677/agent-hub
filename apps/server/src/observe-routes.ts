import { buildTree, type ObserveListQuery, type ObserveReader } from '@agent-hub/observe';
import { isSystem, type Subject } from '@agent-hub/domain';
import type { Hono } from 'hono';
import type { Context } from 'hono';
import { fail } from './http-error.ts';
import type { SubjectOf } from './auth.ts';

/** 可观测只读路由。适配器抛错只影响这次读取。 */
export interface ObserveRouteOptions {
  readonly enabled: boolean;
  readonly readers: readonly ObserveReader[];
}

const DAY = 24 * 60 * 60_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** 路由能区分的看的人。匿名在这里直接空返回，不把「被拒绝」伪装成没有记录。 */
function viewerOf(subject: Subject | null): 'anonymous' | 'user' | 'system' {
  if (!subject) return 'anonymous';
  if (isSystem(subject)) return 'system';
  return 'user';
}

export function installObserveRoutes(app: Hono<any>, options: ObserveRouteOptions, subjectOf: SubjectOf): void {
  const subject = (c: Context): Subject | null => subjectOf(c);
  app.get('/api/observe', async (c) => {
    if (!options.enabled) return c.json({ enabled: false, truncated: false, items: [] });
    const since = Number(c.req.query('since') ?? Date.now() - DAY);
    if (!Number.isFinite(since)) return fail(c, { code: 'invalid', message: 'since 要是毫秒时间' });
    const limitRaw = Number(c.req.query('limit') ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw))) : DEFAULT_LIMIT;
    const query: ObserveListQuery = {
      since,
      source: c.req.query('source') || null,
      projectId: c.req.query('projectId') || null,
      needsLook: c.req.query('needsLook') === '1',
      limit
    };
    const viewer = viewerOf(subject(c));
    if (viewer === 'anonymous') return c.json({ enabled: true, truncated: false, viewer, scanLimit: null, items: [] });
    try {
      const parts = [];
      for (const reader of options.readers) {
        if (query.source && reader.id !== query.source) continue;
        parts.push(await reader.list(query, subject(c)));
      }
      const items = parts.flatMap((part) => part.items).sort((a, b) => b.at - a.at).slice(0, limit);
      const truncated = parts.some((part) => part.truncated) || parts.reduce((n, part) => n + part.items.length, 0) > limit;
      const scanLimit = parts.reduce((max, part) => Math.max(max, part.scanLimit ?? 0), 0);
      return c.json({ enabled: true, truncated, viewer, scanLimit: scanLimit || null, items });
    } catch (error) {
      return fail(c, { code: 'unavailable', message: error instanceof Error ? error.message : '可观测暂时读不了' });
    }
  });
  app.get('/api/observe/:source/:id', async (c) => {
    if (!options.enabled) return c.json({ enabled: false, trace: null, tree: null });
    if (viewerOf(subject(c)) === 'anonymous') return fail(c, { code: 'forbidden', message: '请先登录' });
    const reader = options.readers.find((item) => item.id === c.req.param('source'));
    if (!reader) return fail(c, { code: 'not_found', message: '没有这个来源' });
    try {
      const trace = await reader.get(c.req.param('id'), subject(c));
      if (!trace) return fail(c, { code: 'not_found', message: '没有这条记录' });
      return c.json({ enabled: true, trace, tree: buildTree(trace) });
    } catch (error) {
      return fail(c, { code: 'unavailable', message: error instanceof Error ? error.message : '可观测暂时读不了' });
    }
  });
}
