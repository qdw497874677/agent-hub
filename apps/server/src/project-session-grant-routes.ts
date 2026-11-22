import type { Context, Hono } from 'hono';
import { asSessionId, authorizeProject, err, invalid, notFound, ok, projectSessionGrantActive, type Deps, type DomainError, type Principal, type Result, type SessionId } from '@agent-hub/domain';
import { fail } from './http-error.ts';
import type { ProjectSessionGrantService } from './project-session-grant.ts';

const AVAILABLE_SCOPES = ['task:write', 'worktree:open', 'project:read', 'candidate:import', 'message:send', 'asset:write'] as const;
type AvailableScope = (typeof AVAILABLE_SCOPES)[number];
const isAvailableScope = (scope: string): scope is AvailableScope => AVAILABLE_SCOPES.some((candidate) => candidate === scope);

export function createProjectSessionGrantRoutes(
  deps: Pick<Deps, 'sessions' | 'tasks' | 'projects' | 'access' | 'now'>,
  service: ProjectSessionGrantService
): ProjectSessionGrantRoutes {
  const current = async (actor: Principal, sessionId: SessionId) => {
    const session = await deps.sessions.byId(sessionId);
    if (!session || session.createdBy !== actor.user.id) return err(notFound('会话不存在'));
    const task = session.taskId === null ? null : await deps.tasks.byId(session.taskId);
    const projectId = session.taskId === null ? session.originProjectId : task?.projectId;
    if (!projectId || (session.originProjectId && session.originProjectId !== projectId)) return err(notFound('会话不存在'));
    const project = await authorizeProject(deps.access, actor, await deps.projects.byId(projectId), 'session.read');
    return project.ok ? ok(project.value) : project;
  };
  return {
    async get(actor, sessionId) {
      const project = await current(actor, sessionId);
      if (!project.ok) return project;
      const grants = await service.list({ accountId: actor.user.id, sessionId });
      if (!grants.ok) return grants;
      const active = grants.value.find((grant) => grant.projectId === project.value.id && projectSessionGrantActive(grant, deps.now()));
      return ok(active ? { scopes: active.scopes } : null);
    },
    async set(actor, sessionId, scopes) {
      const project = await current(actor, sessionId);
      if (!project.ok) return project;
      if (!scopes.every(isAvailableScope)) return err(invalid('不支持的项目工具授权范围'));
      const grant = await service.grant({ accountId: actor.user.id, sessionId, projectId: project.value.id, scopes });
      return grant.ok ? ok({ scopes: grant.value.scopes }) : grant;
    },
    async revoke(actor, sessionId) {
      const session = await deps.sessions.byId(sessionId);
      if (!session || session.createdBy !== actor.user.id) return err(notFound('会话不存在'));
      const revoked = await service.revoke({ accountId: actor.user.id, sessionId });
      return revoked.ok ? ok(null) : revoked;
    }
  };
}

export interface ProjectSessionGrantRoutes {
  readonly get: (actor: Principal, sessionId: SessionId) => Promise<Result<unknown, DomainError>>;
  readonly set: (actor: Principal, sessionId: SessionId, scopes: readonly string[]) => Promise<Result<unknown, DomainError>>;
  readonly revoke: (actor: Principal, sessionId: SessionId) => Promise<Result<unknown, DomainError>>;
}

export function installProjectSessionGrantRoutes(
  app: Hono,
  routes: ProjectSessionGrantRoutes,
  principalOf: (c: Context) => Principal | null
): void {
  const path = '/api/sessions/:sessionId/project-tool-grant';
  const human = (c: Context) => {
    const principal = principalOf(c);
    return principal?.via === undefined ? principal : null;
  };
  const denied = (c: Context) => c.json({ error: { code: 'forbidden', message: '仅登录用户可管理会话项目工具授权' } }, 403);
  const respond = (c: Context, result: Result<unknown, DomainError>) => result.ok
    ? c.json({ grant: result.value })
    : fail(c, result.error);
  app.get(path, async (c) => {
    const actor = human(c);
    return actor ? respond(c, await routes.get(actor, asSessionId(c.req.param('sessionId')))) : denied(c);
  });
  app.put(path, async (c) => {
    const actor = human(c);
    if (!actor) return denied(c);
    const body = await c.req.json<unknown>().catch(() => null);
    if (!body || typeof body !== 'object' || !('scopes' in body) || Object.keys(body).length !== 1
      || !Array.isArray(body.scopes) || body.scopes.length < 1 || body.scopes.length > 8
      || !body.scopes.every((scope): scope is string => typeof scope === 'string')) {
      return c.json({ error: { code: 'invalid', message: '需要有效的 scopes；撤权请使用 DELETE' } }, 400);
    }
    return respond(c, await routes.set(actor, asSessionId(c.req.param('sessionId')), body.scopes));
  });
  app.delete(path, async (c) => {
    const actor = human(c);
    return actor ? respond(c, await routes.revoke(actor, asSessionId(c.req.param('sessionId')))) : denied(c);
  });
}
