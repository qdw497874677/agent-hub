import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Principal, User, UserId } from './account.ts';
import { can, ROLE_PERMISSIONS, type AccessContext, type Permission, type Resource } from './access.ts';
import { authorizeWorker, type AccessPolicy } from './use-cases/authorization.ts';

/**
 * 权限矩阵（ADR 0011）：谁对什么能做什么。改 ROLE_PERMISSIONS 必须同时改这里。
 * 场景：hub 团队（hub 管理员 + 成员 + 被授权用本机的成员）和一个自助注册的团队（owner + 成员）。
 */
const user = (id: string, role: User['role'], teamId: string, hubAdmin = false): Principal => ({
  user: {
    id: id as UserId, email: `${id}@b.co`, displayName: id, role, passwordHash: null, emailVerifiedAt: 1,
    disabledAt: null, createdAt: 1, teamId: teamId as User['teamId'], hubAdmin, deletedAt: null
  },
  login: { id: `l-${id}`, userId: id as UserId, tokenHash: 'h', method: 'password', userAgent: null, ip: null, createdAt: 1, lastSeenAt: 1, expiresAt: 9e15 }
} as unknown as Principal);

const david = user('david', 'owner', 'hub', true);
const hubMember = user('m1', 'member', 'hub');
const granted = user('m2', 'member', 'hub');
const selfOwner = user('o2', 'owner', 'other');
const otherMember = user('m3', 'member', 'other');

const ctx: AccessContext = { hubTeamId: 'hub', hubAdminId: 'david', settings: { localWorkerGrants: ['m2'], membersCanAddMachines: true } };
const local: Resource = { teamId: 'hub', createdBy: 'david', local: true };
const hubRemote: Resource = { teamId: 'hub', createdBy: 'm1' };
const otherRemote: Resource = { teamId: 'other', createdBy: 'o2' };
const hubProject = (createdBy: string, sharedWith: string[] = []): Resource => ({ teamId: 'hub', createdBy, sharedWith });

const policy = (resource: Resource): AccessPolicy => ({ context: async () => ctx, worker: async () => resource });

test('self-registered team owner cannot start session on hub-local worker', async () => {
  assert.equal(can(selfOwner, 'worker.use_local', local, ctx), false);
  assert.equal(can(selfOwner, 'worker.use', local, ctx), false);
  const denied = await authorizeWorker(policy(local), selfOwner, null);
  assert.ok(!denied.ok && denied.error.code === 'forbidden');
  // 就算 hub 管理员误把别的团队的人写进授权名单，也不行
  const leaky: AccessContext = { ...ctx, settings: { ...ctx.settings, localWorkerGrants: ['o2'] } };
  assert.equal(can(selfOwner, 'worker.use_local', local, leaky), false);
});

test('cannot install runtime on hub-local worker', async () => {
  for (const who of [selfOwner, otherMember, hubMember, granted]) {
    assert.equal(can(who, 'runtime.install', local, ctx), false, who.user.id);
    assert.equal(can(who, 'worker.manage', local, ctx), false, who.user.id);
    const denied = await authorizeWorker(policy(local), who, null, 'runtime.install');
    assert.ok(!denied.ok && denied.error.code === 'forbidden', who.user.id);
  }
  assert.equal(can(david, 'runtime.install', local, ctx), true);
});

test('本机 Worker：只有 hub 管理员和被单独授权的 hub 团队成员能用', () => {
  assert.equal(can(david, 'worker.use_local', local, ctx), true);
  assert.equal(can(granted, 'worker.use_local', local, ctx), true);
  assert.equal(can(hubMember, 'worker.use_local', local, ctx), false);
  assert.equal(can(otherMember, 'worker.use_local', local, ctx), false);
});

test('远端机器按团队：自己团队的能用，别的团队的看不见也用不了', () => {
  assert.equal(can(selfOwner, 'worker.use', otherRemote, ctx), true);
  assert.equal(can(otherMember, 'worker.use', otherRemote, ctx), true);
  assert.equal(can(selfOwner, 'worker.read', hubRemote, ctx), false);
  assert.equal(can(david, 'worker.use', otherRemote, ctx), false);
  // 成员只能管自己接入的
  assert.equal(can(otherMember, 'worker.manage', otherRemote, ctx), false);
  assert.equal(can(selfOwner, 'runtime.install', otherRemote, ctx), true);
});

test('项目：成员看自己建的和共享给自己的；团队 owner 看全部；跨团队一律不行', () => {
  const mine = hubProject('m1');
  const shared = hubProject('david', ['m1']);
  const theirs = hubProject('david');
  const orphan: Resource = { teamId: 'hub', createdBy: null };
  for (const permission of ['project.read', 'project.update', 'project.delete', 'session.create', 'task.write'] as Permission[]) {
    assert.equal(can(hubMember, permission, mine, ctx), true, permission);
    assert.equal(can(hubMember, permission, shared, ctx), true, permission);
    assert.equal(can(hubMember, permission, theirs, ctx), false, permission);
    assert.equal(can(hubMember, permission, orphan, ctx), false, permission);
    assert.equal(can(david, permission, theirs, ctx), true, permission);
    assert.equal(can(david, permission, orphan, ctx), true, permission);
    assert.equal(can(selfOwner, permission, theirs, ctx), false, permission);
    assert.equal(can(david, permission, { teamId: 'other', createdBy: 'o2' }, ctx), false, permission);
  }
});

test('hub 级权限只认 hub 管理员；团队 owner 管成员但不碰 hub 设置', () => {
  for (const permission of ['hub.settings', 'hub.users', 'hub.assets'] as Permission[]) {
    assert.equal(can(david, permission), true);
    assert.equal(can(selfOwner, permission), false);
    assert.equal(can(hubMember, permission), false);
  }
  assert.equal(can(selfOwner, 'member.invite'), true);
  assert.equal(can(otherMember, 'member.invite'), false);
  assert.equal(can(otherMember, 'audit.read'), false);
});

test('停用 / 删除的人什么都不能做；没装账号体系一律放行', () => {
  const disabled = { ...hubMember, user: { ...hubMember.user, disabledAt: 1 } };
  const deleted = { ...hubMember, user: { ...hubMember.user, deletedAt: 1 } };
  assert.equal(can(disabled, 'project.read', hubProject('m1'), ctx), false);
  assert.equal(can(deleted, 'project.read', hubProject('m1'), ctx), false);
  assert.equal(can(null, 'hub.settings'), true);
});

test('加角色只改配置：每个角色都有权限表', () => {
  assert.deepEqual(Object.keys(ROLE_PERMISSIONS).sort(), ['member', 'owner']);
});
