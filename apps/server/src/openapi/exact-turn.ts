import { z, type OpenAPIHono } from '@hono/zod-openapi';
import { asSessionId, authorizeProject, notFound, projectOfSessionOrigin, unavailable } from '@agent-hub/domain';
import type { ExactTurnReader } from '@agent-hub/storage-sqlite';
import { fail } from '../http-error.ts';
import type { Env, V1Runtime } from './context.ts';
import { openapiOn } from './context.ts';
import { V1, errors, errorSchema, json, route } from './routes/base.ts';

const id = z.string().min(1).max(512).refine(s => Buffer.byteLength(s) <= 512 && !/[\u0000-\u001f\u007f]/.test(s));
const turn = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(s => Number.isSafeInteger(Number(s)));
const params = z.object({ sessionId: id.openapi({ param: { name: 'sessionId', in: 'path' } }), turn: turn.openapi({ param: { name: 'turn', in: 'path' } }) });
export const exactTurnSchema = z.object({
  sessionId: z.string(), turn: z.number().int().positive(), promptSeq: z.number().int().positive().nullable(),
  deliveryId: z.string().nullable(), deliveryState: z.enum(['queued','sending','delivered','undelivered','cancelled','held']).nullable(),
  outcome: z.enum(['done','failed','stopped','interrupted']).nullable(), outcomeUnknown: z.boolean(),
  endedSeq: z.number().int().positive().nullable(), status: z.enum(['pending','terminal','unknown']), reason: z.string()
}).openapi('ExactTurnStatus');

export const exactTurnRoute = route('sessions:read', {
  method: 'get', path: `${V1}/sessions/{sessionId}/turns/{turn}`, tags: ['sessions'], summary: '精确查询一轮的投递结果',
  description: '只以持久化 prompt、投递和匹配 deliveryId 的 ended 为证据；未知不等于失败。',
  request: { params, query: z.object({}).strict() }, responses: { ...errors, 200: json(exactTurnSchema), 503: json(errorSchema, '精确回合查询不可用') }
}, { module: 'sessions', need: 'session.read', readOnly: true, expose: 'get_session_turn' });

/** The caller wires a reader from the same SQLite database; no authorization is delegated to storage. */
export function installExactTurn(app: OpenAPIHono<Env>, rt: V1Runtime, readExactTurn?: ExactTurnReader): void {
  openapiOn(app)(exactTurnRoute, async (c) => {
    const rawId = c.req.param('sessionId') ?? '';
    const rawTurn = c.req.param('turn') ?? '';
    const sessionId = asSessionId(rawId);
    const session = await rt.deps.sessions.byId(sessionId);
    if (!session) return fail(c, notFound('会话不存在'));
    const project = await projectOfSessionOrigin(rt.deps, session);
    const allowed = await authorizeProject(rt.deps.access, rt.principal(c), project, 'session.read');
    if (!allowed.ok) return fail(c, allowed.error);
    if (!readExactTurn) return fail(c, unavailable('精确回合查询不可用'));
    return c.json(readExactTurn(rawId, Number(rawTurn)), 200);
  });
}
