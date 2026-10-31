import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAccess, inMemoryAccounts } from '../testing/in-memory.ts';
import { can, customRoleKey, systemSubject, VISIT_MAX_MS } from '../access.ts';
import type { Principal, Role, User } from '../account.ts';
import {
  createGrant,
  createTeamRole,
  deleteTeamRole,
  endVisit,
  listGrants,
  revokeGrant,
  revokeLegacyLocalWorkerGrants,
  setClusterAdmin,
  startVisit,
  withAccess,
  type AccessAdminDeps
} from './access-admin.ts';

const HOUR = 3_600_000;

async function setup() {
  let clock = 1_000_000;
  const accounts = inMemoryAccounts(() => clock);
  const access = inMemoryAccess();
  const deps: AccessAdminDeps = { ...access, users: accounts.users, teams: accounts.teams, audit: accounts.audit!, now: () => clock };
  const user = async (id: string, teamId: string, role: Role, clusterAdmin = false): Promise<User> => {
    const u: User = { id: id as never, email: `${id}@b.co`, displayName: id, role, passwordHash: null, emailVerifiedAt: 1, disabledAt: null, createdAt: 1, teamId: teamId as never, clusterAdmin, deletedAt: null };
    await accounts.users.save(u);
    return u;
  };
  await accounts.teams.save({ id: 't1' as never, name: 'T1', ownerId: 'david' as never, createdAt: 1 });
  await accounts.teams.save({ id: 't2' as never, name: 'T2', ownerId: 'o2' as never, createdAt: 1 });
  const david = await user('david', 't1', 'owner', true);
  const admin = await user('adm', 't1', 'admin');
  const member = await user('mem', 't1', 'member');
  const other = await user('o2', 't2', 'owner');
  const as = async (u: User): Promise<Principal> => (await withAccess(access, { user: (await accounts.users.byId(u.id))!, loginId: 'l' as never }, clock))!;
  return { deps, accounts, access, david, admin, member, other, as, tick: (ms: number) => (clock += ms) };
}

test('自定义角色：只有 owner 能建；admin 不能；挑不了 hub 级 / 永不可授的权限；有人在用不能删', async () => {
  const { deps, accounts, david, admin, member, as } = await setup();
  const input = { name: '审阅员', permissions: { 'project.read': 'team', 'task.read': 'team', 'session.read': 'team' } };
  assert.equal((await createTeamRole(deps, await as(admin), input)).ok, false);
  assert.equal((await createTeamRole(deps, await as(david), { name: 'x', permissions: { 'hub.settings': 'team' } })).ok, false);
  assert.equal((await createTeamRole(deps, await as(david), { name: 'owner', permissions: {} })).ok, false);
  const made = await createTeamRole(deps, await as(david), input);
  assert.ok(made.ok);
  assert.equal((await createTeamRole(deps, await as(david), input)).ok, false, '同名');
  await accounts.users.save({ ...member, role: customRoleKey(made.value.id) });
  const reviewer = await as(member);
  assert.equal(reviewer.customRole?.name, '审阅员');
  assert.ok(can(reviewer, 'project.read', { kind: 'project', id: 'p', teamId: 't1', createdBy: 'david' }));
  assert.ok(!can(reviewer, 'project.update', { kind: 'project', id: 'p', teamId: 't1', createdBy: 'david' }));
  const del = await deleteTeamRole(deps, await as(david), made.value.id);
  assert.ok(!del.ok && del.error.code === 'conflict');
  assert.ok(accounts.auditRows.some((a) => a.action === 'role.create'));
});

test('显式授权：同团队、不跨队、到期 / 撤销即失效、审核人不走这里、都有审计', async () => {
  const { deps, accounts, david, member, other, as, tick } = await setup();
  const resource = { kind: 'session' as const, id: 's1', teamId: 't1', createdBy: 'david' };
  assert.ok(!can(await as(member), 'session.prompt', resource));
  assert.equal((await createGrant(deps, await as(member), { userId: member.id, permission: 'session.prompt', resourceKind: 'session', resourceId: 's1' })).ok, false, '成员不能授权');
  assert.equal((await createGrant(deps, await as(david), { userId: other.id, permission: 'session.prompt', resourceKind: 'session', resourceId: 's1' })).ok, false, '跨团队');
  assert.equal((await createGrant(deps, await as(david), { userId: member.id, permission: 'asset.review', resourceKind: 'team', resourceId: 't1' })).ok, false, '审核人走审核设置');
  // 就算有一条指向本机 Worker 的授权，can() 第 4 步也只认集群管理员
  assert.ok((await createGrant(deps, await as(david), { userId: member.id, permission: 'worker.use', resourceKind: 'worker', resourceId: 'w-local' })).ok);
  assert.ok(!can(await as(member), 'worker.use', { kind: 'worker', id: 'w-local', teamId: null, createdBy: null, local: true }), '本机授权无效');
  const g = await createGrant(deps, await as(david), { userId: member.id, permission: 'session.prompt', resourceKind: 'session', resourceId: 's1', expiresAt: 1_000_000 + HOUR });
  assert.ok(g.ok);
  assert.ok(can(await as(member), 'session.prompt', resource));
  assert.ok(!can(await as(member), 'session.prompt', { ...resource, id: 's2' }), '只对那一个会话');
  tick(HOUR + 1);
  assert.ok(!can(await as(member), 'session.prompt', resource), '过期');
  const g2 = await createGrant(deps, await as(david), { userId: member.id, permission: 'session.interrupt', resourceKind: 'session', resourceId: 's1' });
  assert.ok(g2.ok);
  assert.ok((await revokeGrant(deps, await as(david), g2.value.id)).ok);
  assert.ok(!can(await as(member), 'session.interrupt', resource), '撤销');
  assert.equal((await listGrants(deps, await as(david))).ok, true);
  assert.deepEqual(accounts.auditRows.filter((a) => a.action.startsWith('grant.')).map((a) => a.action).sort(), ['grant.create', 'grant.create', 'grant.create', 'grant.revoke']);
});

test('临时进入：只有集群管理员；必须写原因；≤ 24h；只读；两边审计；到期 / 结束后失效', async () => {
  const { deps, accounts, david, admin, as, tick } = await setup();
  const proj = { kind: 'project' as const, id: 'p2', teamId: 't2', createdBy: 'o2' };
  assert.equal((await startVisit(deps, await as(admin), { teamId: 't2', reason: '排查问题', durationMs: HOUR })).ok, false);
  assert.equal((await startVisit(deps, await as(david), { teamId: 't2', reason: 'x', durationMs: HOUR })).ok, false, '原因太短');
  assert.equal((await startVisit(deps, await as(david), { teamId: 't2', reason: '排查问题', durationMs: VISIT_MAX_MS + 1 })).ok, false, '超过 24h');
  assert.equal((await startVisit(deps, await as(david), { teamId: 't1', reason: '排查问题', durationMs: HOUR })).ok, false, '自己团队');
  assert.ok(!can(await as(david), 'project.read', proj), '进入前看不到');
  const v = await startVisit(deps, await as(david), { teamId: 't2', reason: '排查问题', durationMs: HOUR });
  assert.ok(v.ok);
  const visiting = await as(david);
  assert.ok(can(visiting, 'project.read', proj));
  assert.ok(!can(visiting, 'project.update', proj), '只读');
  assert.ok(!can(visiting, 'session.prompt', { kind: 'session', id: 's', teamId: 't2', createdBy: 'o2' }), '只读');
  const rows = accounts.auditRows.filter((a) => a.action === 'team.visit');
  assert.deepEqual(rows.map((a) => a.teamId).sort(), [null, 't2'].sort() as never);
  tick(HOUR + 1);
  assert.ok(!can(await as(david), 'project.read', proj), '到期');
  const v2 = await startVisit(deps, await as(david), { teamId: 't2', reason: '再看一下', durationMs: HOUR });
  assert.ok(v2.ok);
  assert.ok((await endVisit(deps, await as(david), v2.value.id)).ok);
  assert.ok(!can(await as(david), 'project.read', proj), '结束');
  assert.equal(accounts.auditRows.filter((a) => a.action === 'team.visit_end').length, 2);
});

test('集群管理员：至少一位；可以多位；只有集群管理员能设', async () => {
  const { deps, david, admin, as } = await setup();
  assert.equal((await setClusterAdmin(deps, await as(admin), admin.id, true)).ok, false);
  const last = await setClusterAdmin(deps, await as(david), david.id, false);
  assert.ok(!last.ok && last.error.code === 'conflict');
  assert.ok((await setClusterAdmin(deps, await as(david), admin.id, true)).ok);
  assert.ok((await setClusterAdmin(deps, await as(admin), david.id, false)).ok, '有第二位后可以撤');
  assert.ok((await setClusterAdmin(deps, systemSubject('migration'), david.id, true)).ok, '系统主体（迁移）可以');
});

test('迁移 1A：localWorkerGrants 逐人撤销并审计，幂等', async () => {
  const { accounts, admin, member, david } = await setup();
  await accounts.settings.save({ ...(await accounts.settings.get()), localWorkerGrants: [admin.id, member.id, david.id] } as never);
  const deps = { settings: accounts.settings, users: accounts.users, audit: accounts.audit!, now: () => 5 };
  assert.equal(await revokeLegacyLocalWorkerGrants(deps), 3);
  const rows = accounts.auditRows.filter((a) => a.action === 'access.local_revoked');
  assert.deepEqual(rows.map((a) => a.target).sort(), ['adm@b.co', 'mem@b.co'], '集群管理员本来就能用，不记');
  assert.ok(!('localWorkerGrants' in (await accounts.settings.get())));
  assert.equal(await revokeLegacyLocalWorkerGrants(deps), 0);
});
