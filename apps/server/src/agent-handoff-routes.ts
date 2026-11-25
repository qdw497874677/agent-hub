import type { Hono } from 'hono';
import { z } from 'zod';
import type { PrincipalOf } from './auth.ts';
import type { AgentHandoffService } from './agent-handoff.ts';
import { fail } from './http-error.ts';

const reservation = z.object({ agentId: z.string(), model: z.string(), requestId: z.string() }).strict();
const first = z.object({ text: z.string(), clientMessageId: z.string(), withHistory: z.boolean() }).strict();

export function installAgentHandoffRoutes(app: Hono<any>, service: AgentHandoffService, principalOf: PrincipalOf): void {
  const path = '/api/sessions/:sessionId/agent-handoff';
  app.use(path, async (c, next) => { c.header('cache-control', 'no-store'); await next(); });
  app.use(`${path}/first`, async (c, next) => { c.header('cache-control', 'no-store'); await next(); });
  app.get(path, async c => {
    const result = await service.metadata(principalOf(c), c.req.param('sessionId'));
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  app.post(path, async c => {
    const parsed = reservation.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '参数不合法' });
    const result = await service.reserve(principalOf(c), c.req.param('sessionId'), parsed.data);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  app.post(`${path}/first`, async c => {
    const parsed = first.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '参数不合法' });
    const result = await service.first(principalOf(c), c.req.param('sessionId'), parsed.data);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
}
