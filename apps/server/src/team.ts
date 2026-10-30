import type { Context, Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { auditQuerySchema, inviteRequest, memberRoleRequest } from '@agent-hub/contract';
import { auditDto, auditFilterOf } from './admin.ts';
import type { InviteDto, TeamDto } from '@agent-hub/contract';
import type { Invite, TeamDeps } from '@agent-hub/domain';
import { asInviteId, asUserId, deleteMember, inviteMember, revokeInvite, setMemberRole, teamAudit, viewTeam } from '@agent-hub/domain';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 团队页的 HTTP 外壳（ADR 0011）：/api/team/*。权限都在 domain（can() 的 member.invite / member.manage），
 * 这里只做解析和形状转换。hub 管理员也能用删人 / 改角色（运营后台的用户列表调同一个接口）。
 */
const inviteDto = (invite: Invite): InviteDto => ({
  id: invite.id,
  email: invite.email,
  role: invite.role,
  createdAt: invite.createdAt,
  expiresAt: invite.expiresAt,
  allowOverLimit: invite.allowOverLimit
});

function ipOf(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

export function installTeam(app: Hono, deps: TeamDeps, principalOf: PrincipalOf): void {
  const who = (c: Context) => principalOf(c);
  const unauthorized = (c: Context) => c.json({ error: { code: 'unauthorized', message: '请先登录' } }, 401);
  const invalidBody = (c: Context) => c.json({ error: { code: 'invalid', message: '请求体不合法' } }, 400);

  app.get('/api/team/audit', async (c) => {
    const principal = who(c);
    if (!principal) return unauthorized(c);
    const parsed = auditQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return invalidBody(c);
    const result = await teamAudit(deps, principal, auditFilterOf(parsed.data));
    if (!result.ok) return fail(c, result.error);
    return c.json(result.value.map(auditDto));
  });

  app.get('/api/team', async (c) => {
    const principal = who(c);
    if (!principal) return unauthorized(c);
    const result = await viewTeam(deps, principal);
    if (!result.ok) return fail(c, result.error);
    const view = result.value;
    const dto: TeamDto = {
      id: view.team.id,
      name: view.team.name,
      members: view.members.map(({ user, isTeamOwner, lastSeenAt }) => ({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        teamOwner: isTeamOwner,
        disabled: user.disabledAt !== null,
        emailVerified: user.emailVerifiedAt !== null,
        lastSeenAt
      })),
      invites: view.invites.map(inviteDto),
      seatsLeft: view.seatsLeft,
      canManage: view.canManage,
      isTeamOwner: view.team.ownerId === principal.user.id
    };
    return c.json(dto);
  });

  app.post('/api/team/invites', async (c) => {
    const principal = who(c);
    if (!principal) return unauthorized(c);
    const parsed = inviteRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalidBody(c);
    const result = await inviteMember(deps, principal, { ...parsed.data, ip: ipOf(c) });
    if (!result.ok) return fail(c, result.error);
    return c.json(inviteDto(result.value), 201);
  });

  app.delete('/api/team/invites/:id', async (c) => {
    const principal = who(c);
    if (!principal) return unauthorized(c);
    const result = await revokeInvite(deps, principal, asInviteId(c.req.param('id')), ipOf(c));
    if (!result.ok) return fail(c, result.error);
    return c.json(inviteDto(result.value));
  });

  app.put('/api/team/members/:id/role', async (c) => {
    const principal = who(c);
    if (!principal) return unauthorized(c);
    const parsed = memberRoleRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalidBody(c);
    const result = await setMemberRole(deps, principal, asUserId(c.req.param('id')), parsed.data.role, ipOf(c));
    if (!result.ok) return fail(c, result.error);
    return c.json({ ok: true });
  });

  app.delete('/api/team/members/:id', async (c) => {
    const principal = who(c);
    if (!principal) return unauthorized(c);
    const result = await deleteMember(deps, principal, asUserId(c.req.param('id')), ipOf(c));
    if (!result.ok) return fail(c, result.error);
    return c.json(result.value);
  });
}
