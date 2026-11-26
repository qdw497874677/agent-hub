import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  asSessionId, asTaskId, authorizeSession, authorizeWorker, conflict, err, invalid, notFound, ok,
  promptSessionUseCase, retryDeliveryNow, unavailable,
  type Deps, type DiffReviewNote, type DiffReviewScope, type DiffReviewStore, type Principal, type Result, type DomainError, type WorkspaceFilesService
} from '@agent-hub/domain';
import { fail } from './http-error.ts';
import { reviewAnchor, reviewRangeValid } from './review-anchor.ts';

const base = z.string().regex(/^(session|head|branch|turn:[1-9]\d{0,5})$/);
const noteInput = z.object({ path: z.string().min(1).max(4096), member: z.string().min(1).max(200).nullable(), base, side: z.enum(['old', 'new']), start: z.number().int().positive().safe(), end: z.number().int().positive().safe(), version: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().min(1).max(8000).refine(s => !!s.trim()) }).strict().refine(x => x.end >= x.start);
const sendInput = z.object({ batchId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/), targetSessionId: z.string().min(1).max(200), noteIds: z.array(z.string().min(1).max(200)).min(1).max(20).refine(a => new Set(a).size === a.length) }).strict();
const cleanNote = (note: DiffReviewNote) => { const { delivery: _delivery, ...rest } = note; return rest; };

export function installReviewRoutes(app: Hono<any>, deps: Deps, files: WorkspaceFilesService, store: DiffReviewStore, principalOf: (c: Context) => Principal | null): void {
  const route = '/api/sessions/:id/git/review';
  app.use(`${route}/*`, async (c, next) => { c.header('cache-control', 'no-store'); await next(); });
  app.use(route, async (c, next) => { c.header('cache-control', 'no-store'); await next(); });
  app.use(`${route}/*`, bodyLimit({ maxSize: 128 * 1024, onError: c => fail(c, invalid('请求体过大')) as never }));
  async function source(c: Context): Promise<Result<{ actor: Principal; scope: DiffReviewScope }, DomainError>> {
    const who = principalOf(c);
    if (!who || who.via) return err(notFound('评审不存在'));
    const id = c.req.param('id') ?? '';
    const permission = await files.authorizeReview(who, id);
    if (!permission.ok) return permission;
    const session = await deps.sessions.byId(asSessionId(id));
    if (!session?.taskId || !(await deps.tasks.byId(session.taskId))) return err(notFound('评审不存在'));
    return ok({ actor: who, scope: { actorId: who.user.id, taskId: session.taskId, sourceSessionId: id } });
  }
  async function target(who: Principal, scope: DiffReviewScope, id: string) {
    const task = await deps.tasks.byId(asTaskId(scope.taskId));
    const session = await deps.sessions.byId(asSessionId(id));
    if (!task || !session || session.taskId !== task.id) return err(notFound('目标会话不存在'));
    const project = await deps.projects.byId(task.projectId);
    const seen = await authorizeSession(deps.access, who, project, session, 'session.read');
    if (!seen.ok) return seen;
    const allowed = await authorizeSession(deps.access, who, project, session, 'session.prompt');
    if (!allowed.ok) return allowed;
    const worker = await authorizeWorker(deps.access, who, session.workerId);
    return worker.ok ? ok(session) : worker;
  }
  type AnchorNote = Pick<DiffReviewNote, 'member' | 'path' | 'base' | 'side' | 'start' | 'end' | 'version'>;
  function checker(who: Principal, scope: DiffReviewScope, limit = Infinity) {
    const cache = new Map<string, Promise<ReturnType<typeof reviewAnchor> | 'unknown'>>();
    async function lookup(note: AnchorNote): Promise<ReturnType<typeof reviewAnchor> | 'unknown'> {
    const parsed = base.safeParse(note.base);
    if (!parsed.success) return null;
    const isTurn = note.base.startsWith('turn:');
    const r = await files.reviewDiff(who, scope.sourceSessionId, note.path, isTurn ? 'turn' : note.base as 'head' | 'session' | 'branch', isTurn ? Number(note.base.slice(5)) : undefined, note.member ?? undefined);
    if (!r.ok) return 'unknown';
    const v = r.value;
    if (!v.reviewable || v.member !== note.member) return null;
    return reviewAnchor({ sourceSessionId: scope.sourceSessionId, path: note.path, member: v.member, scopeKey: v.scopeKey, base: isTurn ? 'turn' : note.base as 'head' | 'session' | 'branch', turn: v.turn, commit: v.commit, target: v.target, branch: v.branch }, v.diff);
    }
    return async (note: AnchorNote): Promise<'current' | 'stale' | 'unknown'> => {
      const key = JSON.stringify([note.member, note.path, note.base]);
      let pending = cache.get(key);
      if (!pending) {
        if (cache.size >= limit) return 'unknown';
        pending = lookup(note).catch(() => 'unknown' as const); cache.set(key, pending);
      }
      const anchor = await pending;
      return anchor === 'unknown' ? 'unknown' : anchor && anchor.version === note.version && reviewRangeValid(anchor, note.side, note.start, note.end) ? 'current' : 'stale';
    };
  }
  app.get(route, async c => {
    const context = await source(c); if (!context.ok) return fail(c, context.error);
    const requested = c.req.queries('note') ?? [];
    if (requested.length > 20 || requested.some(id => !id || id.length > 200)) return fail(c, invalid('评审查询参数不合法'));
    const requestedIds = new Set(requested);
    const statusOnly = c.req.query('statusOnly') === '1';
    const { actor: who, scope } = context.value;
    const notes = await store.list(scope);
    const check = checker(who, scope, 20);
    const states: Array<'current' | 'stale' | 'unknown'> = [];
    for (const note of notes) states.push(statusOnly || note.delivery || (requested.length > 0 && !requestedIds.has(note.id)) ? 'unknown' : await check(note));
    const candidates = await deps.sessions.listByTask(asTaskId(scope.taskId));
    const targets: { id: string; title: string }[] = [];
    for (const session of candidates) if ((await target(who, scope, session.id)).ok) targets.push({ id: session.id, title: session.title ?? '' });
    return c.json({ notes: notes.map((n, i) => ({ ...n, delivery: n.delivery ? { batchId: n.delivery.batchId, targetSessionId: n.delivery.targetSessionId, state: n.delivery.state } : null, anchorState: states[i] })), targets });
  });
  app.post(`${route}/notes`, async c => {
    const context = await source(c); if (!context.ok) return fail(c, context.error);
    const parsed = noteInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, invalid('评审内容不合法'));
    const { actor: who, scope } = context.value;
    if ((await store.list(scope)).length >= 200) return fail(c, invalid('评审数量已达上限'));
    const status = await checker(who, scope)(parsed.data);
    if (status !== 'current') return fail(c, status === 'unknown' ? unavailable('无法确认当前 diff') : conflict('diff 已变化或行号无效'));
    const note = { id: randomUUID(), ...parsed.data };
    return await store.save(scope, note) ? c.json({ ...note, delivery: null, anchorState: 'current' }, 201) : fail(c, conflict('无法保存评审'));
  });
  app.delete(`${route}/notes/:noteId`, async c => {
    const context = await source(c); if (!context.ok) return fail(c, context.error);
    return await store.remove(context.value.scope, c.req.param('noteId')) ? c.json({ ok: true }) : fail(c, conflict('评审不存在或已发送'));
  });
  app.post(`${route}/send`, async c => {
    const context = await source(c); if (!context.ok) return fail(c, context.error);
    const parsed = sendInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, invalid('发送参数不合法'));
    const { actor: who, scope } = context.value; const input = parsed.data;
    const allowed = await target(who, scope, input.targetSessionId); if (!allowed.ok) return fail(c, allowed.error);
    const ids = [...input.noteIds].sort();
    const existing = await store.batch(scope, input.batchId);
    if (existing) return existing.targetSessionId === input.targetSessionId && JSON.stringify([...existing.noteIds].sort()) === JSON.stringify(ids) ? c.json({ ok: true }, 202) : fail(c, conflict('批次编号已用于其他评审'));
    const all = await store.list(scope);
    const notes = ids.map(id => all.find(n => n.id === id));
    if (notes.some(n => !n || n.delivery)) {
      const raced = await store.batch(scope, input.batchId);
      if (raced && raced.targetSessionId === input.targetSessionId && JSON.stringify([...raced.noteIds].sort()) === JSON.stringify(ids)) return c.json({ ok: true }, 202);
      return fail(c, conflict('评审不存在或已发送'));
    }
    const selected = notes as DiffReviewNote[];
    const text = `代码评审（来源会话 ${scope.sourceSessionId}）：\n\n` + selected.map(n => `- ${n.member ? `${n.member}/` : ''}${n.path} (${n.base}, ${n.side} ${n.start}-${n.end})\n${n.text}`).join('\n\n');
    const result = await promptSessionUseCase(deps, { sessionId: input.targetSessionId, text, author: { id: who.user.id, name: who.user.displayName }, promptActor: 'account', clientMessageId: `diff-review:${randomUUID()}` }, async ({ event, payload, now }) => {
      const fresh = await source(c); if (!fresh.ok) return fresh;
      if (fresh.value.scope.taskId !== scope.taskId || fresh.value.scope.actorId !== scope.actorId) return err(conflict('评审范围已变化'));
      const permitted = await target(who, scope, input.targetSessionId); if (!permitted.ok) return permitted;
      const replay = await store.batch(scope, input.batchId);
      const check = checker(who, scope);
      if (!replay) for (const note of selected) {
        const state = await check(note);
        if (state !== 'current') {
          const raced = await store.batch(scope, input.batchId);
          if (raced && raced.targetSessionId === input.targetSessionId && JSON.stringify([...raced.noteIds].sort()) === JSON.stringify(ids)) {
            return ok({ ack: { seq: raced.seq, deliveryId: raced.deliveryId, state: 'queued' as const, turn: raced.turn }, publishedSession: null });
          }
          return err(state === 'unknown' ? unavailable('无法确认当前 diff') : conflict('diff 已变化或行号无效'));
        }
      }
      const admitted = await store.admit(scope, { ...input, noteIds: ids, expectedNotes: selected.map(cleanNote), event, payload, now });
      if (admitted.kind === 'conflict') return err(conflict('评审已变化或批次编号冲突'));
      return ok({ ack: { seq: admitted.batch.seq, deliveryId: admitted.batch.deliveryId, state: 'queued' as const, turn: admitted.batch.turn }, publishedSession: admitted.kind === 'admitted' ? admitted.session : null });
    });
    return result.ok ? c.json({ ok: true }, 202) : fail(c, result.error);
  });
  app.post(`${route}/batches/:batchId/retry`, async c => {
    const context = await source(c); if (!context.ok) return fail(c, context.error);
    const { actor: who, scope } = context.value;
    const batch = await store.batch(scope, c.req.param('batchId')); if (!batch) return fail(c, notFound('评审批次不存在'));
    const allowed = await target(who, scope, batch.targetSessionId); if (!allowed.ok) return fail(c, allowed.error);
    if (!deps.deliveries) return fail(c, unavailable('送达队列不可用'));
    const delivery = await deps.deliveries.byId(batch.deliveryId);
    if (!delivery || delivery.sessionId !== batch.targetSessionId) return fail(c, notFound('送达记录不存在'));
    const result = await retryDeliveryNow({ ...deps, deliveries: deps.deliveries }, batch.deliveryId);
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  });
}
