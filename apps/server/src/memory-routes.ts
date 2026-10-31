import type { Hono } from 'hono';
import { z } from 'zod';
import { MEMORY_BODY_MAX, MEMORY_KINDS, MEMORY_STATUSES, asProjectId, authorizeProject, principalOfSubject, type Deps, type MemoryService } from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 记忆的 HTTP 外壳（ADR 0019 · P1）：界面和开放 API 用；权限全在 MemoryService 里过 can()。
 * - GET  /api/memory/scopes              我能看的作用域（带能不能写 / 审）
 * - GET  /api/memory?scope=&status=      一个作用域里的条目
 * - GET  /api/memory/pending             等我审的
 * - GET  /api/memory/search?q=&scope=    搜索（条目 + 来源）
 * - POST /api/memory                     人写一条
 * - POST /api/memory/:id/review          通过 / 拒绝（令牌拿不到 memory.review）
 * - POST /api/memory/:id/forget          忘掉（软删除）
 * - DELETE /api/memory/:id               彻底删除（memory.purge，只有 owner）
 * - GET  /api/memory/export?scope=       导出
 * - GET/PUT /api/projects/:id/memory     项目写入模式（append-only / review）
 * - POST /api/projects/:id/memory/reindex 立刻重扫项目来源（memory.source.manage）
 */
const writeBody = z.object({
  scope: z.string().min(3).max(200),
  kind: z.enum(MEMORY_KINDS as [string, ...string[]]),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(MEMORY_BODY_MAX),
  tags: z.array(z.string().max(40)).max(10).optional(),
  supersedes: z.array(z.string()).max(5).optional()
});
const reviewBody = z.object({ approve: z.boolean(), note: z.string().max(300).optional() });
const forgetBody = z.object({ reason: z.string().min(1).max(300) });
const modeBody = z.object({ mode: z.enum(['append-only', 'review']) });

export interface MemoryRouteDeps {
  readonly memory: MemoryService;
  readonly deps: Pick<Deps, 'projects' | 'access'>;
}

export function installMemoryRoutes(app: Hono<any>, options: MemoryRouteDeps, subjectOf: SubjectOf): void {
  const { memory, deps } = options;
  const who = (c: Parameters<SubjectOf>[0]) => principalOfSubject(subjectOf(c));

  app.get('/api/memory/scopes', async (c) => {
    const principal = who(c);
    if (!principal) return fail(c, { code: 'forbidden', message: '要登录' });
    return c.json({ scopes: await memory.scopesFor(principal) });
  });

  app.get('/api/memory/pending', async (c) => {
    const principal = who(c);
    if (!principal) return fail(c, { code: 'forbidden', message: '要登录' });
    return c.json({ entries: await memory.pending(principal) });
  });

  app.get('/api/memory/search', async (c) => {
    const principal = who(c);
    if (!principal) return fail(c, { code: 'forbidden', message: '要登录' });
    const q = c.req.query('q') ?? '';
    const scopes = c.req.queries('scope') ?? [];
    const found = await memory.search({ kind: 'user', principal }, { query: q, scopes, includeInactive: c.req.query('all') === '1' });
    return found.ok ? c.json({ results: found.value }) : fail(c, found.error);
  });

  app.get('/api/memory/export', async (c) => {
    const principal = who(c);
    if (!principal) return fail(c, { code: 'forbidden', message: '要登录' });
    const exported = await memory.export(principal, c.req.query('scope') ?? '');
    return exported.ok ? c.json({ entries: exported.value }) : fail(c, exported.error);
  });

  app.get('/api/memory', async (c) => {
    const principal = who(c);
    if (!principal) return fail(c, { code: 'forbidden', message: '要登录' });
    const status = (c.req.queries('status') ?? []).filter((s): s is (typeof MEMORY_STATUSES)[number] => (MEMORY_STATUSES as readonly string[]).includes(s));
    const listed = await memory.list({ kind: 'user', principal }, { scope: c.req.query('scope') ?? '', status, limit: 200 });
    return listed.ok ? c.json({ entries: listed.value }) : fail(c, listed.error);
  });

  app.post('/api/memory', async (c) => {
    const principal = who(c);
    if (!principal) return fail(c, { code: 'forbidden', message: '要登录' });
    const parsed = writeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: parsed.error.issues[0]?.message ?? '格式不对' });
    const wrote = await memory.write({ kind: 'user', principal }, parsed.data as never, 'ui');
    return wrote.ok ? c.json(wrote.value, 201) : fail(c, wrote.error);
  });

  app.post('/api/memory/:id/review', async (c) => {
    const principal = who(c);
    if (!principal) return fail(c, { code: 'forbidden', message: '要登录' });
    const parsed = reviewBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '要给 approve' });
    const reviewed = await memory.review(principal, c.req.param('id'), parsed.data.approve, parsed.data.note);
    return reviewed.ok ? c.json(reviewed.value) : fail(c, reviewed.error);
  });

  app.post('/api/memory/:id/forget', async (c) => {
    const principal = who(c);
    if (!principal) return fail(c, { code: 'forbidden', message: '要登录' });
    const parsed = forgetBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '要写原因' });
    const forgot = await memory.forget({ kind: 'user', principal }, c.req.param('id'), parsed.data.reason);
    return forgot.ok ? c.json(forgot.value) : fail(c, forgot.error);
  });

  app.delete('/api/memory/:id', async (c) => {
    const principal = who(c);
    if (!principal) return fail(c, { code: 'forbidden', message: '要登录' });
    const purged = await memory.purge(principal, c.req.param('id'));
    return purged.ok ? c.body(null, 204) : fail(c, purged.error);
  });

  app.get('/api/projects/:id/memory', async (c) => {
    const principal = who(c);
    if (!principal) return fail(c, { code: 'forbidden', message: '要登录' });
    const mode = await memory.projectMode(principal, c.req.param('id'));
    return mode.ok ? c.json({ mode: mode.value }) : fail(c, mode.error);
  });

  app.put('/api/projects/:id/memory', async (c) => {
    const principal = who(c);
    if (!principal) return fail(c, { code: 'forbidden', message: '要登录' });
    const parsed = modeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '模式只能是 append-only 或 review' });
    const mode = await memory.setProjectMode(principal, c.req.param('id'), parsed.data.mode);
    return mode.ok ? c.json({ mode: mode.value }) : fail(c, mode.error);
  });

  app.post('/api/projects/:id/memory/reindex', async (c) => {
    const principal = who(c);
    const project = await deps.projects.byId(asProjectId(c.req.param('id')));
    const allowed = await authorizeProject(deps.access, principal, project, 'memory.source.manage');
    if (!allowed.ok) return fail(c, allowed.error);
    return c.json(await memory.reindex(allowed.value.id, true));
  });
}
