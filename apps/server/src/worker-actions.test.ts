import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTeamMember, inMemoryAdmin, inMemoryDeps, inMemoryEnrollment, mailedToken } from '@agent-hub/domain/testing';
import {
  createAccessPolicy,
  customRoleKey,
  type CustomRole,
  type Principal,
  type WorkerCredential,
  type WorkerStatus
} from '@agent-hub/domain';
import { workerActionsFor } from './worker-actions.ts';
import type { WorkerActionsDto, WorkerInfoDto } from '@agent-hub/contract';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

const PASSWORD = 'long enough pw';

function harness() {
  const admin = inMemoryAdmin();
  // 生产网关支持轮换；内存 fake 没实现这个可选方法，这里补上。
  admin.deps.workers.rotateCredential = async () => true;
  const enrollment = inMemoryEnrollment(admin);
  const world = inMemoryDeps();
  const access = createAccessPolicy({
    users: admin.accounts.users,
    settings: admin.accounts.settings,
    enrollment: enrollment.deps.enrollment,
    gateway: world.deps.gateway
  });
  const deps = { ...world.deps, access };
  const app = createApp({
    deps,
    hub: createStreamHub(),
    token: null,
    auth: { accounts: admin.accounts },
    admin: { deps: admin.deps, enrollment: enrollment.deps },
    enrollment: { deps: enrollment.deps, bootstrapScript: '/dev/null', commit: 'abc1234' }
  });
  const browser = () => {
    const jar = new Map<string, string>();
    return async (path: string, init: RequestInit = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (jar.size) headers.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
      if (jar.get('hub_csrf')) headers['x-hub-csrf'] = jar.get('hub_csrf')!;
      const response = await app.fetch(new Request(`http://hub${path}`, { ...init, headers }));
      for (const line of response.headers.getSetCookie()) {
        const [name, value] = line.split(';')[0]!.split('=');
        if (value === '' || /Max-Age=0/.test(line)) jar.delete(name!);
        else jar.set(name!, value!);
      }
      return { status: response.status, body: (await response.json().catch(() => null)) as any };
    };
  };
  return { admin, enrollment, world, browser };
}

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

async function setup() {
  const h = harness();
  const owner = h.browser();
  assert.equal((await owner('/api/auth/register', post({ email: 'boss@b.co', password: PASSWORD }))).status, 200);
  await addTeamMember(h.admin.accounts, 'm@b.co', PASSWORD);
  const member = h.browser();
  assert.equal((await member('/api/auth/login', post({ email: 'm@b.co', password: PASSWORD }))).status, 200);
  // 另一个团队的人：自助注册 + 验证邮箱
  await h.admin.accounts.settings.save({ ...(await h.admin.accounts.settings.get()), openRegistration: true });
  const outsider = h.browser();
  assert.equal((await outsider('/api/auth/register', post({ email: 's@b.co', password: PASSWORD }))).status, 202);
  await outsider('/api/auth/verify-email', post({ token: mailedToken(h.admin.accounts, 's@b.co') }));
  assert.equal((await outsider('/api/auth/login', post({ email: 's@b.co', password: PASSWORD }))).status, 200);
  const user = async (email: string) => {
    const found = await h.admin.accounts.users.byEmail(email);
    assert.ok(found, `missing user ${email}`);
    return found;
  };
  return { ...h, owner, member, outsider, memberUser: await user('m@b.co'), ownerUser: await user('boss@b.co'), outsiderUser: await user('s@b.co') };
}

const provisioned = [{ agentId: 'fake', models: ['m1'], defaultModel: 'm1', provision: { source: 'missing' } }] as unknown as WorkerStatus['agentModels'];

function credential(workerId: string, enrolledBy: string, extra: Partial<WorkerCredential> = {}): WorkerCredential {
  return { workerId, tokenHash: `hash-${workerId}`, enrolledBy, label: workerId, createdAt: 1, revokedAt: null, ...extra } as WorkerCredential;
}

function worker(world: ReturnType<typeof inMemoryDeps>, admin: ReturnType<typeof inMemoryAdmin>, workerId: string, overrides: Partial<WorkerStatus> = {}): WorkerStatus {
  const row = { workerId, label: workerId, origin: 'remote', state: 'online', ...overrides } as WorkerStatus;
  world.workers.push(row);
  admin.workerList.push(row);
  return row;
}

const actionsOf = (body: WorkerInfoDto[], workerId: string): WorkerActionsDto => {
  const found = body.find((item) => item.workerId === workerId);
  assert.ok(found, `missing worker ${workerId} in ${body.map((item) => item.workerId).join(',')}`);
  return found.actions;
};

const expectActions = (actual: WorkerActionsDto, expected: Partial<WorkerActionsDto>, label: string) => {
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(actual[key as keyof WorkerActionsDto], value, `${label}.${key}`);
  }
};

const versionStatusOf = (body: WorkerInfoDto[], workerId: string): WorkerInfoDto['versionStatus'] => {
  const found = body.find((item) => item.workerId === workerId);
  assert.ok(found, `missing worker ${workerId} in ${body.map((item) => item.workerId).join(',')}`);
  return found.versionStatus;
};

const allFalse: WorkerActionsDto = {
  update: false,
  updateLogs: false,
  disconnect: false,
  rotateCredential: false,
  revokeCredential: false,
  installRuntime: false,
  installComponent: false,
  configureResources: false
};

test('GET /api/workers 按实际角色和机器状态给出 actions', async () => {
  const h = await setup();
  // 默认 inMemoryDeps 自带本机；只给它一个可安装的运行时，验证本机也不能更新 / 断开 / 轮换。
  h.world.workers[0] = { ...h.world.workers[0]!, agentModels: provisioned };

  h.enrollment.credentials.set('own', credential('own', h.memberUser.id));
  h.enrollment.credentials.set('shared', credential('shared', h.ownerUser.id));
  h.enrollment.credentials.set('foreign', credential('foreign', h.outsiderUser.id));
  h.enrollment.credentials.set('offline', credential('offline', h.memberUser.id));
  h.enrollment.credentials.set('no-install', credential('no-install', h.memberUser.id));
  h.enrollment.credentials.set('pending', credential('pending', h.memberUser.id, { pendingHash: 'next', pendingUntil: 9_999_999_999_999 }));
  h.enrollment.credentials.set('revoked', credential('revoked', h.memberUser.id, { revokedAt: 2 }));
  h.enrollment.credentials.set('updating', credential('updating', h.memberUser.id));
  h.enrollment.credentials.set('trial', credential('trial', h.memberUser.id));
  h.enrollment.credentials.set('unprovisioned', credential('unprovisioned', h.memberUser.id));

  worker(h.world, h.admin, 'own', { agentModels: provisioned, update: { state: 'succeeded', message: 'ok', logTail: 'secret-log', at: 1 } });
  worker(h.world, h.admin, 'shared', { agentModels: provisioned });
  worker(h.world, h.admin, 'foreign', { agentModels: provisioned });
  worker(h.world, h.admin, 'legacy', {});
  worker(h.world, h.admin, 'offline', { state: 'offline', agentModels: provisioned });
  worker(h.world, h.admin, 'no-install', { agentModels: provisioned, capabilities: ['sessions', 'files.read'] });
  worker(h.world, h.admin, 'pending', { agentModels: provisioned });
  worker(h.world, h.admin, 'revoked', { agentModels: provisioned });
  worker(h.world, h.admin, 'updating', { agentModels: provisioned, update: { state: 'updating', message: 'busy', logTail: 'busy-log', at: 1 } });
  worker(h.world, h.admin, 'trial', { agentModels: provisioned, update: { state: 'trial', message: '试运行中', logTail: 'trial-log', at: 1 } });
  worker(h.world, h.admin, 'unprovisioned', {});
  worker(h.world, h.admin, 'legacy-offline', { state: 'offline' });

  const owner = (await h.owner('/api/workers')).body as WorkerInfoDto[];
  // hub 管理员也受团队边界约束：别的团队的机器只在 /api/admin/workers 里看。
  assert.deepEqual(owner.map((item) => item.workerId).sort(), ['legacy', 'legacy-offline', 'local', 'no-install', 'offline', 'own', 'pending', 'revoked', 'shared', 'trial', 'unprovisioned', 'updating']);

  expectActions(actionsOf(owner, 'local'), { update: false, updateLogs: false, disconnect: false, rotateCredential: false, revokeCredential: false, installRuntime: true, installComponent: false, configureResources: true }, 'owner.local');
  expectActions(actionsOf(owner, 'own'), { update: true, updateLogs: true, disconnect: true, rotateCredential: true, revokeCredential: true, installRuntime: true, installComponent: false, configureResources: true }, 'owner.own');
  expectActions(actionsOf(owner, 'shared'), { update: true, disconnect: true, rotateCredential: true, revokeCredential: true, installRuntime: true, configureResources: true }, 'owner.shared');

  // 共享 HUB_TOKEN 的老机器没有凭据：管理员仍可断开 / 吊销，但没有可轮换的凭据，也不能凭空装运行时。
  expectActions(actionsOf(owner, 'legacy'), { update: true, updateLogs: false, disconnect: true, rotateCredential: false, revokeCredential: true, installRuntime: false, configureResources: true }, 'owner.legacy');
  expectActions(actionsOf(owner, 'offline'), { update: false, disconnect: false, rotateCredential: false, revokeCredential: true, installRuntime: false }, 'owner.offline');
  expectActions(actionsOf(owner, 'no-install'), { update: false, installRuntime: false, rotateCredential: true, configureResources: true }, 'owner.no-install');
  expectActions(actionsOf(owner, 'pending'), { rotateCredential: false, revokeCredential: true }, 'owner.pending');
  expectActions(actionsOf(owner, 'revoked'), { rotateCredential: false, revokeCredential: false }, 'owner.revoked');
  expectActions(actionsOf(owner, 'updating'), { update: false, updateLogs: true }, 'owner.updating');
  // 试运行期间也算忙：批量更新和单台按钮都不能再发一次。
  expectActions(actionsOf(owner, 'trial'), { update: false, updateLogs: true }, 'owner.trial');
  expectActions(actionsOf(owner, 'unprovisioned'), { installRuntime: false }, 'owner.unprovisioned');
  expectActions(actionsOf(owner, 'legacy-offline'), { update: false, disconnect: false, revokeCredential: false, rotateCredential: false }, 'owner.legacy-offline');

  const member = (await h.member('/api/workers')).body as WorkerInfoDto[];
  assert.deepEqual(member.map((item) => item.workerId).sort(), ['legacy', 'legacy-offline', 'no-install', 'offline', 'own', 'pending', 'revoked', 'shared', 'trial', 'unprovisioned', 'updating']);
  // 自己的机器：可以使用、轮换、吊销；更新 / 断开是运营后台动作。
  expectActions(actionsOf(member, 'own'), { update: false, updateLogs: false, disconnect: false, rotateCredential: true, revokeCredential: true, installRuntime: true, configureResources: true }, 'member.own');
  // 同团队但不是接入人：看得见，不能管理。
  expectActions(actionsOf(member, 'shared'), allFalse, 'member.shared');
  // 没凭据的老机器不能因为 credential 404 就送权限。
  expectActions(actionsOf(member, 'legacy'), allFalse, 'member.legacy');
  expectActions(actionsOf(member, 'legacy-offline'), allFalse, 'member.legacy-offline');
  expectActions(actionsOf(member, 'offline'), { rotateCredential: false, revokeCredential: true, installRuntime: false, configureResources: true }, 'member.offline');
  expectActions(actionsOf(member, 'no-install'), { update: false, installRuntime: false, rotateCredential: true }, 'member.no-install');
  expectActions(actionsOf(member, 'pending'), { rotateCredential: false }, 'member.pending');
  expectActions(actionsOf(member, 'revoked'), { revokeCredential: false, rotateCredential: false }, 'member.revoked');
  expectActions(actionsOf(member, 'updating'), { update: false, updateLogs: false }, 'member.updating');
  expectActions(actionsOf(member, 'trial'), { update: false, updateLogs: false, rotateCredential: true, revokeCredential: true }, 'member.trial');
  expectActions(actionsOf(member, 'unprovisioned'), { installRuntime: false }, 'member.unprovisioned');

  const outsider = (await h.outsider('/api/workers')).body as WorkerInfoDto[];
  assert.deepEqual(outsider.map((item) => item.workerId), ['foreign']);
  expectActions(actionsOf(outsider, 'foreign'), { update: false, updateLogs: false, disconnect: false, rotateCredential: true, revokeCredential: true, installRuntime: true, configureResources: true }, 'outsider.foreign');

  // 成员的响应里不能出现接入人、邮箱或更新日志。
  const memberText = JSON.stringify(member);
  assert.ok(!memberText.includes(h.memberUser.id), 'member sees user id');
  assert.ok(!memberText.includes(h.ownerUser.id), 'member sees owner id');
  assert.ok(!memberText.includes('m@b.co'), 'member sees email');
  assert.ok(!memberText.includes('secret-log'), 'member sees update log');
  assert.ok(!memberText.includes('enrolledBy'), 'member sees enrollment metadata');
});

test('installRuntime / installComponent 各看各的权限，不能用 OR 互相放大', async () => {
  const admin = inMemoryAdmin();
  const enrollment = inMemoryEnrollment(admin);
  const world = inMemoryDeps();
  for (const email of ['rt@b.co', 'member@b.co']) await addTeamMember(admin.accounts, email, PASSWORD);
  const lookup = async (email: string) => {
    const found = await admin.accounts.users.byEmail(email);
    assert.ok(found, email);
    return found;
  };
  const runtimeUser = await lookup('rt@b.co');
  const memberUser = await lookup('member@b.co');
  const access = createAccessPolicy({
    users: admin.accounts.users,
    settings: admin.accounts.settings,
    enrollment: enrollment.deps.enrollment,
    gateway: world.deps.gateway
  });
  const inventory = { runtimes: [], components: [], capabilities: [], collectedAt: 1, componentInstall: true };
  const makeWorker = (workerId: string, enrolledBy: string): WorkerStatus => {
    const row = { workerId, label: workerId, origin: 'remote', state: 'online', agentModels: provisioned, inventory } as WorkerStatus;
    world.workers.push(row);
    enrollment.credentials.set(workerId, credential(workerId, enrolledBy));
    return row;
  };
  const runtimeWorker = makeWorker('runtime-only', runtimeUser.id);
  const memberWorker = makeWorker('member-both', memberUser.id);
  const role = (id: string, permissions: CustomRole['permissions'], teamId: string): CustomRole => ({
    id,
    teamId,
    name: id,
    permissions,
    createdBy: 'owner',
    createdAt: 1,
    updatedAt: 1
  });
  const principalFor = (user: Awaited<ReturnType<typeof lookup>>, customRole: CustomRole): Principal => ({
    user: { ...user, role: customRoleKey(customRole.id) },
    loginId: 'test-login' as never,
    customRole
  });
  const teamId = runtimeUser.teamId;
  assert.ok(teamId);
  const runtimeRole = role('runtime-only', { 'runtime.install': 'own' }, teamId);
  const actionsFor = async (worker: WorkerStatus, principal: Principal) =>
    workerActionsFor(worker, {
      access,
      subject: principal,
      principal,
      credential: (await enrollment.deps.enrollment.credentialFor(worker.workerId)) ?? null,
      now: 1,
      hubCommit: 'a'.repeat(40),
      canRotate: true
    });

  const runtimeActions = await actionsFor(runtimeWorker, principalFor(runtimeUser, runtimeRole));
  assert.equal(runtimeActions.installRuntime, true, '只有 runtime.install 时能装卸运行时');
  assert.equal(runtimeActions.installComponent, false, '只有 runtime.install 不能装卸组件');

  // runtime.component.install 是 NEVER_GRANTABLE，自定义角色拿不到；内置成员两项都有。
  // 组件权限只可能来自内置角色，所以这里验证「只有 runtime.install 的自定义角色不能碰组件」即可。
  const memberActions = await actionsFor(memberWorker, { user: memberUser, loginId: 'test-login' as never });
  assert.equal(memberActions.installRuntime, true);
  assert.equal(memberActions.installComponent, true, '内置成员两项权限都有，且清单支持组件');
});

test('GET /api/workers 给普通成员版本关系，不泄露 hub build', async () => {
  const h = await setup();
  const hub = h.admin.deps.workers.hubBuild();
  for (const id of ['version-current', 'version-outdated', 'version-unknown']) {
    h.enrollment.credentials.set(id, credential(id, h.memberUser.id));
  }
  worker(h.world, h.admin, 'version-current', { build: hub });
  worker(h.world, h.admin, 'version-outdated', { build: { ...hub, commit: 'b'.repeat(40) } });
  // 没报 build 的老 Worker：不能确定，不能说「已是最新」。
  worker(h.world, h.admin, 'version-unknown', {});

  const body = (await h.member('/api/workers')).body as WorkerInfoDto[];
  assert.equal(versionStatusOf(body, 'version-current'), 'current');
  assert.equal(versionStatusOf(body, 'version-outdated'), 'outdated');
  assert.equal(versionStatusOf(body, 'version-unknown'), 'unknown');

  const text = JSON.stringify(body);
  assert.ok(!text.includes(hub.commit!), 'member sees hub commit');
  assert.ok(!text.includes('"build"'), 'member sees worker build');
  assert.ok(!text.includes('logTail'), 'member sees update log metadata');
});
