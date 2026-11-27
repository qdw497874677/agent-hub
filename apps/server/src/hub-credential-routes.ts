import type { Context, Hono } from 'hono';
import { isSystem } from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import type { HubCredentialBroker } from './hub-credential-broker.ts';

const base = '/api/projects/:projectId/repos/:repoId/hub-credential';

/** A disabled API must not fall through to the Web app's HTML fallback. */
export function installDisabledHubCredentialRoutes(app: Hono<any>): void {
  const disabled = (c: Context) => {
    c.header('cache-control', 'no-store');
    return c.json({ error: { code: 'not_found', message: '仓库凭据不可用' } }, 404);
  };
  app.all(base, disabled);
  app.all(`${base}/*`, disabled);
}

async function readBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new Error('body too large'); }
      chunks.push(part.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { reader.releaseLock(); }
}

/** authorizeManagement must re-fetch the live user and verify team owner/admin AND project.update. */
export function installHubCredentialRoutes(app: Hono<any>, broker: HubCredentialBroker, subjectOf: SubjectOf, authorizeManagement: (c: Context, projectId: string, repoId: string) => Promise<boolean>): void {
  app.use(`${base}*`, async (c, next) => { await next(); c.header('cache-control', 'no-store'); });
  const handler = (action: 'list' | 'bind' | 'unbind' | 'create' | 'check' | 'rotate' | 'revoke') => async (c: Context): Promise<Response> => {
    const projectId = c.req.param('projectId') ?? ''; const repoId = c.req.param('repoId') ?? '';
    const auth = async () => {
      const actor = subjectOf(c);
      if (!actor || isSystem(actor) || actor.via || actor.user.disabledAt !== null || actor.user.deletedAt !== null) return false;
      try { return await authorizeManagement(c, projectId, repoId); } catch { return false; }
    };
    if (!await auth()) return c.json({ error: { code: 'forbidden', message: '无权管理此仓库凭据' } }, 403);
    const principal = subjectOf(c);
    const auditContext = principal && !isSystem(principal) ? { actorId: principal.user.id } : undefined;
    let body: Record<string, unknown> = {};
    if (action === 'create' || action === 'bind' || action === 'rotate' || action === 'revoke' || action === 'check') {
      try { const raw = await readBody(c.req.raw); const parsed: unknown = raw.trim() === '' && action === 'check' ? {} : JSON.parse(raw); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); body = parsed as Record<string, unknown>; } catch { return c.json({ error: { code: 'invalid', message: '请求格式不正确' } }, 400); }
      const fields = action === 'create' ? ['name', 'credential'] : action === 'bind' ? ['credentialId'] : action === 'rotate' ? ['credential', 'credentialId', 'version'] : action === 'revoke' ? ['credentialId', 'version'] : [];
      if (Object.keys(body).length !== fields.length || fields.some((key) => key === 'version' ? !Number.isSafeInteger(body[key]) || (body[key] as number) < 1 : typeof body[key] !== 'string') || Object.keys(body).some((key) => !fields.includes(key))) return c.json({ error: { code: 'invalid', message: '请求格式不正确' } }, 400);
    }
    try {
      switch (action) {
        case 'list': return c.json(await broker.list(projectId, repoId, auth));
        case 'bind': return c.json(await broker.bind(projectId, repoId, body.credentialId as string, auth, auditContext));
        case 'unbind': return c.json(await broker.unbind(projectId, repoId, auth, auditContext));
        case 'create': return c.json(await broker.create(projectId, repoId, body.name as string, body.credential as string, auth, auditContext));
        case 'check': return c.json(await broker.check(projectId, repoId, auth, auditContext));
        case 'rotate': return c.json(await broker.rotate(projectId, repoId, body.credential as string, body.credentialId as string, body.version as number, auth, auditContext));
        case 'revoke': return c.json(await broker.revoke(projectId, repoId, body.credentialId as string, body.version as number, auth, auditContext));
      }
    } catch {
      if (action === 'list') return c.json({ error: { code: 'not_found', message: '仓库不可用' } }, 404);
      return c.json({ error: { code: 'unavailable', message: '仓库凭据不可用' } }, 400);
    }
  };
  app.get(base, handler('list')); app.put(base, handler('bind')); app.delete(base, handler('unbind'));
  app.post(`${base}/create`, handler('create')); app.post(`${base}/check`, handler('check'));
  app.put(`${base}/rotate`, handler('rotate')); app.delete(`${base}/revoke`, handler('revoke'));
}
