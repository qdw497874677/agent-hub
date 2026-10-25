import type { Context, Hono } from 'hono';
import { roleRequest, settingsPatchRequest } from '@agent-hub/contract';
import type { AdminOverviewDto, AdminUserDto, AdminWorkerDto, AuditEntryDto, EnrollInfoDto } from '@agent-hub/contract';
import type { AdminDeps, DomainError, Principal, Result, User, WorkerStatus } from '@agent-hub/domain';
import {
  adminOverview,
  adminUsers,
  asUserId,
  canAddMachines,
  disconnectWorker,
  requireOwner,
  revokeUserLogins,
  setUserDisabled,
  setUserRole,
  updateSettings
} from '@agent-hub/domain';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 运营后台的 HTTP 外壳：/api/admin/* 只有在用的主人能调（其余一律 403）。
 * CSRF 由 auth.ts 的守门中间件统一校验；规则（最后一个主人、不能停自己）都在 domain。
 */
export interface AdminOptions {
  readonly deps: AdminDeps;
}

const userDto = (user: User, lastSeenAt: number | null, activeLogins: number): AdminUserDto => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  role: user.role,
  disabled: user.disabledAt !== null,
  createdAt: user.createdAt,
  lastSeenAt,
  activeLogins
});

const workerDto = (worker: WorkerStatus): AdminWorkerDto => ({
  workerId: worker.workerId,
  label: worker.label,
  origin: worker.origin,
  state: worker.state,
  reason: worker.reason ?? null,
  hostname: worker.hostname ?? null,
  platform: worker.platform ?? null,
  lastSeenAt: worker.lastSeenAt ?? null,
  sessionCount: worker.sessionCount ?? 0,
  enrolledBy: worker.origin === 'local' ? '本机（随 hub 启动）' : 'HUB_TOKEN 接入'
});

export function installAdmin(app: Hono, options: AdminOptions, principalOf: PrincipalOf): void {
  const { deps } = options;
  const owner = (c: Context): Principal => principalOf(c) as Principal; // 中间件已确认

  app.use('/api/admin/*', async (c, next) => {
    const allowed = requireOwner(principalOf(c));
    return allowed.ok ? next() : fail(c, allowed.error);
  });

  app.get('/api/workers/enroll-info', async (c) => {
    const principal = principalOf(c);
    const info: EnrollInfoDto = {
      allowed: principal !== null && canAddMachines(principal.user, await deps.settings.get()),
      hubUrl: new URL(c.req.url).origin
    };
    return c.json(info);
  });

  app.get('/api/admin/overview', async (c) => {
    const overview = await adminOverview(deps);
    const dto: AdminOverviewDto = {
      ...overview,
      recentUsers: overview.recentUsers.map((user) => ({
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        createdAt: user.createdAt
      })),
      recentLogins: overview.recentLogins.map(({ login, email }) => ({
        email,
        method: login.method,
        userAgent: login.userAgent,
        at: login.createdAt
      }))
    };
    return c.json(dto);
  });

  app.get('/api/admin/users', async (c) => {
    const rows = await adminUsers(deps, c.req.query('q') ?? '');
    return c.json(rows.map((row) => userDto(row.user, row.lastSeenAt, row.activeLogins)));
  });

  const userResult = async (c: Context, run: Promise<Result<User, DomainError>>) => {
    const result = await run;
    return result.ok ? c.json(userDto(result.value, null, 0)) : fail(c, result.error);
  };

  app.post('/api/admin/users/:id/disable', (c) =>
    userResult(c, setUserDisabled(deps, owner(c), asUserId(c.req.param('id')), true))
  );
  app.post('/api/admin/users/:id/enable', (c) =>
    userResult(c, setUserDisabled(deps, owner(c), asUserId(c.req.param('id')), false))
  );
  app.post('/api/admin/users/:id/revoke-logins', (c) =>
    userResult(c, revokeUserLogins(deps, owner(c), asUserId(c.req.param('id'))))
  );
  app.post('/api/admin/users/:id/role', async (c) => {
    const parsed = roleRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法' });
    return userResult(c, setUserRole(deps, owner(c), asUserId(c.req.param('id')), parsed.data.role));
  });

  app.get('/api/admin/workers', async (c) => c.json((await deps.workers.list()).map(workerDto)));
  app.post('/api/admin/workers/:id/disconnect', async (c) => {
    const result = await disconnectWorker(deps, owner(c), c.req.param('id'));
    return result.ok ? c.json(workerDto(result.value)) : fail(c, result.error);
  });

  app.get('/api/admin/settings', async (c) => c.json(await deps.settings.get()));
  app.put('/api/admin/settings', async (c) => {
    const parsed = settingsPatchRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法' });
    const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
    return c.json(await updateSettings(deps, owner(c), patch));
  });

  app.get('/api/admin/audit', async (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 100) || 100));
    const entries: AuditEntryDto[] = (await deps.audit.recent(limit)).map((entry) => ({
      id: entry.id,
      actorEmail: entry.actorEmail,
      action: entry.action,
      target: entry.target,
      detail: entry.detail,
      at: entry.at
    }));
    return c.json(entries);
  });
}
