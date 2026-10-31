import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  ALL_PERMISSIONS,
  CUSTOM_ROLE_GRANTABLE,
  NEVER_GRANTABLE,
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
  createGrant,
  createTeamRole,
  deleteTeamRole,
  endVisit,
  listGrants,
  listTeamRoles,
  myVisits,
  revokeGrant,
  setClusterAdmin,
  startVisit,
  updateTeamRole,
  type AccessAdminDeps,
  type AccessGrant,
  type CustomRole,
  type Permission,
  type ResourceKind
} from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * ADR 0017 的 HTTP 外壳：团队角色（内置 + 自定义）、显式授权、集群管理员临时进入、设 / 撤集群管理员。
 * 权限都在 domain（can()），这里只解析和转形状。
 */
const roleBody = z.object({
  name: z.string().max(40),
  permissions: z.record(z.string(), z.enum(['own', 'team']))
});
const grantBody = z.object({
  userId: z.string().min(1).max(80),
  permission: z.string().max(60),
  resourceKind: z.enum(['project', 'task', 'session', 'worker', 'provider']),
  resourceId: z.string().min(1).max(120),
  reason: z.string().max(200).optional(),
  expiresAt: z.number().int().positive().nullable().optional()
});
const visitBody = z.object({ teamId: z.string().min(1).max(80), reason: z.string().max(200), durationMs: z.number().int().positive() });
const clusterAdminBody = z.object({ clusterAdmin: z.boolean() });

const roleDto = (role: CustomRole) => ({ id: role.id, key: `custom:${role.id}`, name: role.name, permissions: role.permissions, updatedAt: role.updatedAt });
const grantDto = (grant: AccessGrant) => ({ ...grant });

export function installAccessRoutes(app: Hono, deps: AccessAdminDeps, subjectOf: SubjectOf): void {
  const json = async <T>(c: Context, schema: z.ZodType<T>): Promise<T | null> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  };
  const bad = (c: Context) => fail(c, { code: 'invalid', message: '请求体不合法' });

  /** 权限目录：编辑器按它画矩阵。 */
  app.get('/api/access/catalog', (c) =>
    c.json({
      catalog: PERMISSION_CATALOG,
      all: ALL_PERMISSIONS,
      grantable: CUSTOM_ROLE_GRANTABLE,
      neverGrantable: [...NEVER_GRANTABLE],
      builtin: ROLE_PERMISSIONS
    })
  );

  app.get('/api/team/roles', async (c) => {
    const result = await listTeamRoles(deps, subjectOf(c), ROLE_PERMISSIONS);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });
  app.post('/api/team/roles', async (c) => {
    const input = await json(c, roleBody);
    if (!input) return bad(c);
    const result = await createTeamRole(deps, subjectOf(c), input);
    return result.ok ? c.json(roleDto(result.value), 201) : fail(c, result.error);
  });
  app.put('/api/team/roles/:id', async (c) => {
    const input = await json(c, roleBody);
    if (!input) return bad(c);
    const result = await updateTeamRole(deps, subjectOf(c), c.req.param('id'), input);
    return result.ok ? c.json(roleDto(result.value)) : fail(c, result.error);
  });
  app.delete('/api/team/roles/:id', async (c) => {
    const result = await deleteTeamRole(deps, subjectOf(c), c.req.param('id'));
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  });

  app.get('/api/team/grants', async (c) => {
    const result = await listGrants(deps, subjectOf(c));
    return result.ok ? c.json(result.value.map(grantDto)) : fail(c, result.error);
  });
  app.post('/api/team/grants', async (c) => {
    const input = await json(c, grantBody);
    if (!input || !(ALL_PERMISSIONS as readonly string[]).includes(input.permission)) return bad(c);
    const result = await createGrant(deps, subjectOf(c), {
      ...input,
      permission: input.permission as Permission,
      resourceKind: input.resourceKind as ResourceKind
    });
    return result.ok ? c.json(grantDto(result.value), 201) : fail(c, result.error);
  });
  app.delete('/api/team/grants/:id', async (c) => {
    const result = await revokeGrant(deps, subjectOf(c), c.req.param('id'));
    return result.ok ? c.json(grantDto(result.value)) : fail(c, result.error);
  });

  app.get('/api/access/visits', async (c) => c.json((await myVisits(deps, subjectOf(c))).map(grantDto)));
  app.post('/api/admin/visits', async (c) => {
    const input = await json(c, visitBody);
    if (!input) return bad(c);
    const result = await startVisit(deps, subjectOf(c), input);
    return result.ok ? c.json(grantDto(result.value), 201) : fail(c, result.error);
  });
  app.delete('/api/access/visits/:id', async (c) => {
    const result = await endVisit(deps, subjectOf(c), c.req.param('id'));
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  });
  app.get('/api/admin/teams', async (c) => {
    return c.json((await deps.teams.list()).map((team) => ({ id: team.id, name: team.name })));
  });

  app.put('/api/admin/users/:id/cluster-admin', async (c) => {
    const input = await json(c, clusterAdminBody);
    if (!input) return bad(c);
    const result = await setClusterAdmin(deps, subjectOf(c), c.req.param('id'), input.clusterAdmin);
    return result.ok ? c.json({ id: result.value.id, clusterAdmin: result.value.clusterAdmin }) : fail(c, result.error);
  });
}
