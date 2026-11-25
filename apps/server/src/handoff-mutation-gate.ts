import type { Hono } from 'hono';
import { authorizeSession, conflict, handoffFirstEnded, handoffRecord, projectOfSessionOrigin, type Deps, type Subject } from '@agent-hub/domain';
import type { Context } from 'hono';
import { fail } from './http-error.ts';

/** Protect reserved targets until the exact first turn is durably complete.
 * Install after authentication and access checks, before the matching routes. */
export function installHandoffMutationGate(app: Hono<any>, deps: Deps, prefix: '/api' | '/openapi/v1', subjectOf: (c: Context) => Subject | null): void {
  app.use(`${prefix}/*`, async (c, next) => {
    if (!deps.agentHandoffs || ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
    const path = c.req.path;
    const root = `${prefix}/sessions`;
    const ids: string[] = [];
    const route = path.startsWith(`${root}/`) ? path.slice(root.length + 1).split('/') : [];
    const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
    let inspectBody = false;
    if (c.req.method === 'POST' && (path === `${root}/fork` || path === `${root}/derive` || path === root)) {
      inspectBody = true;
    } else if (route.length >= 1 && !['fork', 'derive'].includes(route[0] ?? '')) {
      const action = route[1] ?? '';
      // Prompt and external messages have their own first-admission gate. Delivery
      // actions likewise protect the first delivery without blocking later entries.
      if (!['prompt', 'messages', 'deliveries'].includes(action) && action !== 'agent-handoff') ids.push(decode(route[0]!));
      if (['links', 'unlink'].includes(action)) inspectBody = true;
    }
    if (prefix === '/api' && /^\/api\/projects\/[^/]+\/session-links(?:\/[^/]+\/[^/]+)?$/.test(path)) {
      const parts = path.split('/');
      if (parts.length === 7) ids.push(decode(parts[5]!), decode(parts[6]!));
      else inspectBody = true;
    }
    if (inspectBody) {
      const body = await c.req.raw.clone().json().catch(() => null) as Record<string, unknown> | null;
      for (const key of ['sessionId', 'parentSessionId', 'otherSessionId', 'aSessionId', 'bSessionId']) {
        if (typeof body?.[key] === 'string') ids.push(body[key] as string);
      }
      if (Array.isArray(body?.linkWith)) for (const id of body.linkWith) if (typeof id === 'string') ids.push(id);
    }
    for (const id of new Set(ids)) {
      const record = await handoffRecord(deps, id);
      if (!record.ok) return fail(c, record.error);
      if (record.value) {
        if (deps.access) {
          const session = await deps.sessions.byId(record.value.reservation.target.id);
          const project = session ? await projectOfSessionOrigin(deps, session) : null;
          const allowed = await authorizeSession(deps.access, subjectOf(c), project, session, 'session.read');
          if (!allowed.ok) return fail(c, allowed.error);
        }
        if (!(await handoffFirstEnded(deps, record.value))) return fail(c, conflict('交接首轮尚未完成，不能修改会话'));
      }
    }
    return next();
  });
}
