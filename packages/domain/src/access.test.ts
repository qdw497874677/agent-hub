import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Principal, User, UserId } from './account.ts';
import {
  ALL_PERMISSIONS,
  BUILTIN_ROLES,
  CUSTOM_ROLE_GRANTABLE,
  HUB_PERMISSIONS,
  NEVER_GRANTABLE,
  TOKEN_NEVER_GRANTABLE,
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
  can,
  customRoleKey,
  customRoleProblem,
  decide,
  systemSubject,
  type AccessContext,
  type AccessGrant,
  type CustomRole,
  type Permission,
  type Resource
} from './access.ts';
import { API_SCOPES, apiTokenUsable, permissionsOf } from './api-token.ts';
import { authorizeWorker, type AccessPolicy } from './use-cases/authorization.ts';

/**
 * 权限模型（ADR 0017）的矩阵测试：改 ROLE_PERMISSIONS / decide() 必须同时改这里。
 * 场景：hub 团队（集群管理员 david + owner/admin/member/viewer）和另一个团队 other。
 */
const user = (id: string, role: User['role'], teamId: string, clusterAdmin = false, extra: Partial<Principal> = {}): Principal =>
  ({
    user: {
      id: id as UserId, email: `${id}@b.co`, displayName: id, role, passwordHash: null, emailVerifiedAt: 1,
      disabledAt: null, createdAt: 1, teamId: teamId as User['teamId'], clusterAdmin, deletedAt: null
    },
    login: { id: `l-${id}`, userId: id as UserId, tokenHash: 'h', method: 'password', userAgent: null, ip: null, createdAt: 1, lastSeenAt: 1, expiresAt: 9e15 },
    ...extra
  }) as unknown as Principal;

const david = user('david', 'owner', 'hub', true);
const owner = user('own', 'owner', 'hub');
const admin = user('adm', 'admin', 'hub');
const member = user('mem', 'member', 'hub');
const viewer = user('vw', 'viewer', 'hub');
const otherOwner = user('o2', 'owner', 'other');
const otherMember = user('m3', 'member', 'other');
const everyone = [david, owner, admin, member, viewer, otherOwner, otherMember];

const ctx: AccessContext = { hubTeamId: 'hub', settings: { membersCanAddMachines: true } };
const local: Resource = { kind: 'worker', id: 'local', teamId: 'hub', createdBy: null, local: true };
const project = (createdBy: string, sharedWith: string[] = [], teamId = 'hub'): Resource => ({ kind: 'project', id: `p-${createdBy}`, teamId, createdBy, sharedWith });
const session = (createdBy: string, teamId = 'hub'): Resource => ({ kind: 'session', id: `s-${createdBy}`, teamId, createdBy });

// ───────── 1. 表驱动矩阵 ─────────

type Row = readonly [who: Principal, permission: Permission, resource: Resource | undefined, expected: boolean, why: string];
const rows: Row[] = [
  // 项目：owner / admin 全团队；member 只看自己建的和共享给自己的；viewer 只读全团队
  [owner, 'project.read', project('mem'), true, 'owner 看团队全部项目'],
  [admin, 'project.update', project('mem'), true, 'admin 改团队项目'],
  [admin, 'project.purge', project('mem'), false, 'admin 不能彻底删除'],
  [owner, 'project.purge', project('mem'), true, 'owner 能彻底删除'],
  [member, 'project.read', project('mem'), true, '成员看自己的'],
  [member, 'project.read', project('own', ['mem']), true, '成员看共享给自己的'],
  [member, 'project.read', project('own'), false, '成员看不到别人的'],
  [member, 'project.update', project('own', ['mem']), true, '被共享的人能协作编辑'],
  [member, 'project.delete', project('own', ['mem']), false, '被共享的人不能删别人的项目'],
  [member, 'project.share', project('own', ['mem']), false, '被共享的人不能再共享'],
  [viewer, 'project.read', project('own'), true, 'viewer 只读全团队'],
  [viewer, 'project.update', project('vw'), false, 'viewer 不能写，自己的也不行'],
  [viewer, 'project.create', undefined, false, 'viewer 不能建项目'],
  [viewer, 'task.create', project('own'), false, 'viewer 不能建任务'],
  [viewer, 'session.prompt', session('vw'), false, 'viewer 不能说话'],
  [member, 'project.create', undefined, true, '成员能建项目'],
  // 跨团队：一律不行（含集群管理员，决定 5A）
  [otherOwner, 'project.read', project('own'), false, '别的团队 owner 看不到'],
  [david, 'project.read', project('o2', [], 'other'), false, '集群管理员默认看不到别的团队'],
  [david, 'session.read', session('o2', 'other'), false, '集群管理员默认看不到别的团队的会话'],
  // 会话（决定 4A）：只有创建者、team 范围的 owner/admin、或显式授权能说话 / 打断
  [member, 'session.prompt', session('mem'), true, '自己的会话能说话'],
  [member, 'session.prompt', session('own'), false, '共享项目里别人的会话不能说话'],
  [member, 'session.interrupt', session('own'), false, '也不能打断'],
  [member, 'session.continue', session('own'), false, '也不能换机继续'],
  [admin, 'session.prompt', session('mem'), true, 'admin 能接管'],
  [owner, 'session.interrupt', session('mem'), true, 'owner 能打断'],
  // hub 级：只认集群管理员
  [david, 'hub.settings', undefined, true, '集群管理员改设置'],
  [owner, 'hub.settings', undefined, false, '团队 owner 不能改 hub 设置'],
  [admin, 'hub.users', undefined, false, 'admin 不能管 hub 用户'],
  // 团队管理
  [owner, 'team.roles', { teamId: 'hub' }, true, 'owner 能定义角色'],
  [admin, 'team.roles', { teamId: 'hub' }, false, 'admin 不能定义角色'],
  [admin, 'team.manage', { teamId: 'hub' }, true, 'admin 能管成员（受 team.ts 限制）'],
  [member, 'team.manage', { teamId: 'hub' }, false, '成员不能管成员'],
  [viewer, 'audit.read', { teamId: 'hub' }, false, 'viewer 看不了审计'],
  // 远端机器按团队
  [member, 'worker.use', { kind: 'worker', id: 'w1', teamId: 'hub', createdBy: 'own' }, true, '用团队里的机器'],
  [member, 'worker.manage', { kind: 'worker', id: 'w1', teamId: 'hub', createdBy: 'own' }, false, '管不了别人接入的机器'],
  [member, 'worker.manage', { kind: 'worker', id: 'w2', teamId: 'hub', createdBy: 'mem' }, true, '管自己接入的机器'],
  [otherMember, 'worker.use', { kind: 'worker', id: 'w1', teamId: 'hub', createdBy: 'own' }, false, '别的团队的机器用不了']
];

test('权限矩阵（表驱动）', () => {
  for (const [who, permission, resource, expected, why] of rows) {
    assert.equal(can(who, permission, resource, ctx), expected, `${who.user.id} ${permission}: ${why}`);
  }
});

test('每个内置角色都有权限表；owner ⊇ admin ⊇ viewer 的只读', () => {
  for (const role of BUILTIN_ROLES) assert.ok(ROLE_PERMISSIONS[role], role);
  for (const p of Object.keys(ROLE_PERMISSIONS.admin) as Permission[]) assert.ok(ROLE_PERMISSIONS.owner[p], p);
  for (const p of Object.keys(ROLE_PERMISSIONS.viewer) as Permission[]) assert.ok(p.endsWith('.read'), `viewer 只能有 read：${p}`);
  for (const role of BUILTIN_ROLES) for (const p of HUB_PERMISSIONS) assert.equal(ROLE_PERMISSIONS[role][p], undefined, `${role} 不该带 ${p}`);
});

// ───────── 2. 穷举证明：hub 本机 Worker 只有集群管理员（决定 1A） ─────────

test('穷举：本机 Worker 的任何权限只给集群管理员——所有角色 × 所有权限 × 授权 × 自定义角色 × 令牌', () => {
  const workerPerms = ALL_PERMISSIONS.filter((p) => p.startsWith('worker.') || p === 'runtime.install');
  const grantAll = (who: Principal): AccessGrant[] =>
    ALL_PERMISSIONS.map((permission, i) => ({
      id: `g${i}`, teamId: 'hub', userId: who.user.id, permission, resourceKind: 'worker', resourceId: 'local',
      reason: '', createdBy: 'own', createdAt: 0, expiresAt: null, revokedAt: null
    }));
  const maxRole: CustomRole = {
    id: 'max', teamId: 'hub', name: 'max',
    permissions: Object.fromEntries(ALL_PERMISSIONS.map((p) => [p, 'team'])) as CustomRole['permissions'],
    createdBy: 'own', createdAt: 0, updatedAt: 0
  };
  const roles: User['role'][] = [...BUILTIN_ROLES, customRoleKey('max')];
  let checked = 0;
  for (const role of roles) {
    for (const team of ['hub', 'other']) {
      for (const clusterAdmin of [false, true]) {
        for (const withGrants of [false, true]) {
          for (const viaToken of [false, true]) {
            const base = user(`u-${role}-${team}`, role, team, clusterAdmin, { customRole: { ...maxRole, teamId: team } });
            let who: Principal = withGrants ? { ...base, grants: grantAll(base) } : base;
            if (viaToken) who = { ...who, via: { tokenId: 't', name: 't', kind: 'personal', permissions: [...ALL_PERMISSIONS] } } as Principal;
            for (const permission of ALL_PERMISSIONS) {
              for (const resource of [local, { ...local, teamId: team }, { ...local, createdBy: who.user.id }]) {
                const allowed = can(who, permission, resource, ctx);
                checked++;
                if (!allowed) continue;
                // 放行只能是：集群管理员、不走令牌、且是 worker 类权限或 hub 级权限
                assert.ok(clusterAdmin && !viaToken, `${role}/${team}/grants=${withGrants}/token=${viaToken} 拿到了本机 ${permission}`);
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 1000);
  // 反方向：集群管理员确实能用本机
  for (const p of workerPerms) assert.equal(can(david, p, local, ctx), true, p);
});

test('本机 Worker：authorizeWorker 拒绝非集群管理员', async () => {
  const policy: AccessPolicy = { context: async () => ctx, worker: async () => local };
  for (const who of [owner, admin, member, otherOwner]) {
    const denied = await authorizeWorker(policy, who, null, 'runtime.install');
    assert.ok(!denied.ok && denied.error.code === 'forbidden', who.user.id);
  }
  assert.equal((await authorizeWorker(policy, david, null)).ok, true);
});

// ───────── 3. 自定义角色（决定 6B） ─────────

test('自定义角色：只能挑可授的权限；hub.* / team.roles 永远不行', () => {
  for (const p of NEVER_GRANTABLE) assert.ok(!CUSTOM_ROLE_GRANTABLE.includes(p), p);
  for (const p of PERMISSION_CATALOG.hub) assert.notEqual(customRoleProblem('x', { [p]: 'team' }), null, p);
  assert.notEqual(customRoleProblem('x', { 'team.roles': 'team' }), null);
  assert.notEqual(customRoleProblem('owner', {}), null, '不能和内置角色同名');
  assert.notEqual(customRoleProblem('x', { 'project.read': 'all' }), null, '范围只能 own / team');
  assert.equal(customRoleProblem('评审员', { 'project.read': 'team', 'session.read': 'team' }), null);
});

test('自定义角色按定义生效；库被改坏也不放大权限；别的团队的角色定义无效', () => {
  const reviewer: CustomRole = {
    id: 'r1', teamId: 'hub', name: '评审员',
    permissions: { 'project.read': 'team', 'session.read': 'team', 'hub.settings': 'team' } as CustomRole['permissions'],
    createdBy: 'own', createdAt: 0, updatedAt: 0
  };
  const who = user('rv', customRoleKey('r1'), 'hub', false, { customRole: reviewer });
  assert.equal(can(who, 'project.read', project('own'), ctx), true);
  assert.equal(can(who, 'project.update', project('rv'), ctx), false);
  assert.equal(can(who, 'hub.settings', undefined, ctx), false, '被塞进去的 hub 权限无效');
  const foreign = user('rv2', customRoleKey('r1'), 'other', false, { customRole: reviewer });
  assert.equal(can(foreign, 'project.read', project('o2', [], 'other'), ctx), false);
  const missing = user('rv3', customRoleKey('gone'), 'hub');
  assert.equal(can(missing, 'project.read', project('own'), ctx), false, '角色删了 = 什么都没有');
});

// ───────── 4. 显式授权与临时进入（决定 4A / 5A） ─────────

const grant = (userId: string, permission: Permission, kind: AccessGrant['resourceKind'], id: string, teamId = 'hub'): AccessGrant => ({
  id: `${userId}-${permission}`, teamId, userId, permission, resourceKind: kind, resourceId: id, reason: '', createdBy: 'own', createdAt: 0, expiresAt: null, revokedAt: null
});

test('显式授权：只补那一个资源、那一项权限', () => {
  const who = user('mem', 'member', 'hub', false, { grants: [grant('mem', 'session.prompt', 'session', 's-own')] });
  assert.equal(can(who, 'session.prompt', session('own'), ctx), true);
  assert.equal(can(who, 'session.interrupt', session('own'), ctx), false);
  assert.equal(can(who, 'session.prompt', session('adm'), ctx), false);
  const revoked = user('mem', 'member', 'hub', false, { grants: [{ ...grant('mem', 'session.prompt', 'session', 's-own'), revokedAt: 1 }] });
  assert.equal(can(revoked, 'session.prompt', session('own'), ctx), false);
});

test('临时进入：集群管理员只读那个团队；写操作、别的团队、非集群管理员都不行', () => {
  const visit = grant('david', 'hub.visit', 'team', 'other', 'other');
  const visiting = user('david', 'owner', 'hub', true, { grants: [visit] });
  assert.equal(can(visiting, 'project.read', project('o2', [], 'other'), ctx), true);
  assert.equal(can(visiting, 'session.read', session('o2', 'other'), ctx), true);
  assert.equal(can(visiting, 'project.update', project('o2', [], 'other'), ctx), false);
  assert.equal(can(visiting, 'session.prompt', session('o2', 'other'), ctx), false);
  assert.equal(can(visiting, 'project.read', project('x', [], 'third'), ctx), false);
  const fake = user('own', 'owner', 'hub', false, { grants: [{ ...visit, userId: 'own' }] });
  assert.equal(can(fake, 'project.read', project('o2', [], 'other'), ctx), false);
});

// ───────── 5. 主体：null 拒绝、系统主体放行、停用的人什么都不能做 ─────────

test('null 一律拒绝（不再代表放行）；系统主体显式放行', () => {
  for (const p of ALL_PERMISSIONS) {
    assert.equal(decide(null, p, project('own'), ctx).allow, false, p);
    assert.equal(can(systemSubject('test'), p, project('own'), ctx), true, p);
  }
});

test('停用 / 删除的人什么都不能做', () => {
  const disabled = { ...member, user: { ...member.user, disabledAt: 5 } } as Principal;
  const deleted = { ...member, user: { ...member.user, deletedAt: 5 } } as Principal;
  for (const p of ALL_PERMISSIONS) {
    assert.equal(can(disabled, p, project('mem'), ctx), false);
    assert.equal(can(deleted, p, project('mem'), ctx), false);
  }
});

test('成员接入机器受 hub 设置约束；owner / admin 不受', () => {
  const off: AccessContext = { ...ctx, settings: { membersCanAddMachines: false } };
  assert.equal(can(member, 'worker.enroll', undefined, off), false);
  assert.equal(can(admin, 'worker.enroll', undefined, off), true);
  assert.equal(can(owner, 'worker.enroll', undefined, off), true);
});

// ───────── 6. 令牌（ADR 0015） ─────────

const viaToken = (who: Principal, scopes: Parameters<typeof permissionsOf>[0]): Principal =>
  ({ ...who, via: { tokenId: 't1', name: 'bot', kind: 'personal', permissions: permissionsOf(scopes) } }) as Principal;

test('令牌：权限是本人权限和 scopes 的交集', () => {
  const read = viaToken(david, ['projects:read']);
  assert.equal(can(read, 'project.read', project('david'), ctx), true);
  assert.equal(can(read, 'project.create', undefined, ctx), false);
  const mine = viaToken(member, ['projects:read', 'projects:write']);
  assert.equal(can(mine, 'project.read', project('own'), ctx), false);
  assert.equal(can(mine, 'project.read', project('mem'), ctx), true);
});

test('令牌：hub 级、team.roles、本机 Worker 永远授不出去，哪怕全部 scopes、哪怕集群管理员', () => {
  const all = permissionsOf([...API_SCOPES]);
  for (const permission of TOKEN_NEVER_GRANTABLE) assert.ok(!all.includes(permission), permission);
  const token = viaToken(david, [...API_SCOPES]);
  assert.equal(can(token, 'worker.use', local, ctx), false);
  assert.equal(can(token, 'worker.use', { kind: 'worker', id: 'w', teamId: 'hub', createdBy: 'david' }, ctx), true);
  const forged = { ...david, via: { tokenId: 'x', name: 'x', kind: 'personal', permissions: [...ALL_PERMISSIONS] } } as unknown as Principal;
  for (const p of HUB_PERMISSIONS) assert.equal(can(forged, p, undefined, ctx), false, p);
  assert.equal(can(forged, 'worker.use', local, ctx), false);
});

test('令牌可用性：吊销、过期', () => {
  const base = { revokedAt: null, expiresAt: null } as Parameters<typeof apiTokenUsable>[0];
  assert.equal(apiTokenUsable(base, 10), true);
  assert.equal(apiTokenUsable({ ...base, revokedAt: 5 }, 10), false);
  assert.equal(apiTokenUsable({ ...base, expiresAt: 5 }, 10), false);
  assert.equal(apiTokenUsable({ ...base, expiresAt: 50 }, 10), true);
});

void everyone;
