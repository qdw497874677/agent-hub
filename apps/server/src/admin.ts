import type { Context, Hono } from 'hono';
import { auditQuerySchema, roleRequest, settingsPatchRequest } from '@agent-hub/contract';
import type { AuditQuery } from '@agent-hub/contract';
import type { AdminOverviewDto, AdminUserDto, AdminWorkerDto, AdminWorkersDto, AuditEntryDto, EnrollInfoDto } from '@agent-hub/contract';
import type { AuditEntry, AuditFilter, AdminDeps, BuildInfo, EnrollmentDeps, DomainError, Principal, Result, User, WorkerStatus } from '@agent-hub/domain';
import {
  adminOverview,
  adminUsers,
  asUserId,
  canAddMachines,
  disconnectWorker,
  isOutdated,
  markUserVerified,
  requireOwner,
  revokeUserLogins,
  setUserDisabled,
  setUserRole,
  updateOutdatedWorkers,
  updateSettings,
  updateWorker,
  workerCredentials
} from '@agent-hub/domain';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 运营后台的 HTTP 外壳：/api/admin/* 只有在用的主人能调（其余一律 403）。
 * CSRF 由 auth.ts 的守门中间件统一校验；规则（最后一个主人、不能停自己）都在 domain。
 */
export interface AdminOptions {
  readonly deps: AdminDeps;
  /** 有了就在机器列表上标出「谁接入的」、有没有专属凭据。 */
  readonly enrollment?: Pick<EnrollmentDeps, 'enrollment'>;
}

interface Enrolment {
  readonly by: string;
  readonly dedicated: boolean;
}

const userDto = (user: User, lastSeenAt: number | null, activeLogins: number, hubTeamId: string | null = null): AdminUserDto => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  role: user.role,
  emailVerified: user.emailVerifiedAt !== null,
  disabled: user.disabledAt !== null,
  createdAt: user.createdAt,
  lastSeenAt,
  activeLogins,
  hubAdmin: user.hubAdmin === true,
  teamId: user.teamId ?? null,
  hubTeam: hubTeamId !== null && user.teamId === hubTeamId
});

const workerDto = (worker: WorkerStatus, hub: BuildInfo, enrolment?: Enrolment): AdminWorkerDto => ({
  workerId: worker.workerId,
  label: worker.label,
  origin: worker.origin,
  state: worker.state,
  reason: worker.reason ?? null,
  hostname: worker.hostname ?? null,
  platform: worker.platform ?? null,
  lastSeenAt: worker.lastSeenAt ?? null,
  sessionCount: worker.sessionCount ?? 0,
  enrolledBy: worker.origin === 'local' ? '本机（随 hub 启动）' : (enrolment?.by ?? '共享 HUB_TOKEN 接入'),
  dedicated: enrolment?.dedicated ?? false,
  build: worker.build ?? null,
  outdated: isOutdated(worker, hub),
  update: worker.update ?? null,
  harnesses: (worker.agentModels ?? []).map((entry) => ({
    agentId: entry.agentId,
    ...(entry.readiness ? { readiness: entry.readiness } : {})
  }))
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
    const hubTeamId = (await deps.users.hubAdmin())?.teamId ?? null;
    return c.json(rows.map((row) => userDto(row.user, row.lastSeenAt, row.activeLogins, hubTeamId)));
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
  app.post('/api/admin/users/:id/verify', (c) =>
    userResult(c, markUserVerified(deps, owner(c), asUserId(c.req.param('id'))))
  );
  app.post('/api/admin/users/:id/revoke-logins', (c) =>
    userResult(c, revokeUserLogins(deps, owner(c), asUserId(c.req.param('id'))))
  );
  app.post('/api/admin/users/:id/role', async (c) => {
    const parsed = roleRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法' });
    return userResult(c, setUserRole(deps, owner(c), asUserId(c.req.param('id')), parsed.data.role));
  });

  /** workerId → 谁接入的。凭接入码加的才有记录；吊销了的不会出现在在线列表里。 */
  const enrolments = async (): Promise<Map<string, Enrolment>> => {
    if (!options.enrollment) return new Map();
    const [credentials, users] = await Promise.all([workerCredentials(options.enrollment), deps.users.list()]);
    const emailOf = new Map(users.map((user) => [user.id, user.email]));
    const out = new Map<string, Enrolment>();
    for (const [workerId, credential] of credentials) {
      if (credential.revokedAt !== null) continue;
      out.set(workerId, { by: emailOf.get(credential.enrolledBy) ?? '（已删除的用户）', dedicated: true });
    }
    return out;
  };

  app.get('/api/admin/workers', async (c) => {
    const hub = deps.workers.hubBuild();
    const known = await enrolments();
    const body: AdminWorkersDto = {
      hub,
      workers: (await deps.workers.list()).map((worker) => workerDto(worker, hub, known.get(worker.workerId)))
    };
    return c.json(body);
  });
  app.post('/api/admin/workers/:id/disconnect', async (c) => {
    const result = await disconnectWorker(deps, owner(c), c.req.param('id'));
    if (!result.ok) return fail(c, result.error);
    return c.json(workerDto(result.value, deps.workers.hubBuild(), (await enrolments()).get(result.value.workerId)));
  });
  // 更新：不收请求体——目标永远是 hub 自己的提交（见 domain updateWorker）。
  app.post('/api/admin/workers/update-outdated', async (c) => {
    const result = await updateOutdatedWorkers(deps, owner(c));
    if (!result.ok) return fail(c, result.error);
    const hub = deps.workers.hubBuild();
    const known = await enrolments();
    return c.json(result.value.map((worker) => workerDto(worker, hub, known.get(worker.workerId))));
  });
  app.post('/api/admin/workers/:id/update', async (c) => {
    const result = await updateWorker(deps, owner(c), c.req.param('id'));
    if (!result.ok) return fail(c, result.error);
    return c.json(workerDto(result.value, deps.workers.hubBuild(), (await enrolments()).get(result.value.workerId)), 202);
  });

  app.get('/api/admin/settings', async (c) => c.json(await deps.settings.get()));
  app.put('/api/admin/settings', async (c) => {
    const parsed = settingsPatchRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法' });
    const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
    return c.json(await updateSettings(deps, owner(c), patch));
  });

  app.get('/api/admin/audit', async (c) => {
    const parsed = auditQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return fail(c, { code: 'invalid', message: '过滤条件不合法' });
    const filter = auditFilterOf(parsed.data);
    return c.json((await deps.audit.query({ ...filter, ...(parsed.data.teamId ? { teamId: parsed.data.teamId } : {}) })).map(auditDto));
  });
}

/** 审计查询的 query string → domain 的过滤（空串当没填）。 */
export function auditFilterOf(query: AuditQuery): Omit<AuditFilter, 'teamId'> {
  const text = (value: string | undefined) => (value && value.trim() ? value.trim() : undefined);
  const action = text(query.action);
  const actor = text(query.actor);
  const ip = text(query.ip);
  return {
    limit: query.limit ?? 100,
    ...(action ? { action } : {}),
    ...(actor ? { actor } : {}),
    ...(ip ? { ip } : {}),
    ...(query.since !== undefined ? { since: query.since } : {}),
    ...(query.until !== undefined ? { until: query.until } : {})
  };
}

export const auditDto = (entry: AuditEntry): AuditEntryDto => ({
  id: entry.id,
  actorEmail: entry.actorEmail,
  action: entry.action,
  target: entry.target,
  detail: entry.detail,
  at: entry.at,
  ip: entry.ip ?? null,
  teamId: entry.teamId ?? null
});
