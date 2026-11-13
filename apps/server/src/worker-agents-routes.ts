import type { Hono } from 'hono';
import { agentAliasesProblem, newId, normalizeAgentAliases, type AgentAlias, type AuditLog, type WorkerAgentsRepository } from '@agent-hub/domain';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

/** 路由只认这几个动作，装配由 main.ts 决定（和 bot-routes / worker-resources 一样的写法）。 */
export interface WorkerAgentsApi {
  readonly repo: WorkerAgentsRepository;
  /** 推给在线的 Worker；离线返回 false（仍然存库，等它下次连上再推）。 */
  send(workerId: string, aliases: readonly AgentAlias[]): boolean;
  readonly audit: Pick<AuditLog, 'append'>;
  now(): number;
}

/**
 * 每台 Worker 的自定义运行时别名（CAP-1）。
 *
 * - GET /api/workers/:workerId/agents  owner / admin 可读；从没配过回 `{ aliases: [] }`
 * - PUT /api/workers/:workerId/agents  owner only；存库 + 推给在线 Worker + 审计 `worker.agents`
 *
 * 别名只是「这台机器上有哪些 ACP agent」的声明：不带 env，密钥留在那台机器的 worker.env 里。
 */
export function installWorkerAgentRoutes(app: Hono<any>, api: WorkerAgentsApi, principalOf: PrincipalOf): void {
  app.get('/api/workers/:workerId/agents', async (c) => {
    const principal = principalOf(c);
    if (!principal) return c.json({ error: { code: 'unauthorized', message: '请先登录' } }, 401);
    if (principal.user.role !== 'owner' && principal.user.role !== 'admin') {
      return fail(c, { code: 'forbidden', message: '只有 owner / admin 能看运行时别名' });
    }
    const aliases = (await api.repo.get(c.req.param('workerId'))) ?? [];
    return c.json({ aliases });
  });

  app.put('/api/workers/:workerId/agents', async (c) => {
    const principal = principalOf(c);
    if (!principal) return c.json({ error: { code: 'unauthorized', message: '请先登录' } }, 401);
    if (principal.user.role !== 'owner') return fail(c, { code: 'forbidden', message: '只有 owner 能改运行时别名' });
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return fail(c, { code: 'invalid', message: '请求体要形如 { "aliases": [...] }' });
    }
    const aliases = (body as { aliases?: unknown }).aliases;
    const problem = agentAliasesProblem(aliases);
    if (problem !== null) return fail(c, { code: 'invalid', message: problem });
    const workerId = c.req.param('workerId');
    const normalized = normalizeAgentAliases(aliases as AgentAlias[]);
    await api.repo.save(workerId, normalized);
    api.send(workerId, normalized);
    await api.audit.append({
      id: newId(),
      actorId: principal.user.id,
      actorEmail: principal.user.email,
      action: 'worker.agents',
      target: workerId,
      detail: `${normalized.length} 个别名`,
      at: api.now()
    });
    return c.json({ aliases: normalized });
  });
}
