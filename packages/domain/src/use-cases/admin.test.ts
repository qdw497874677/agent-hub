import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAdmin } from '../testing/in-memory.ts';
import type { Principal, Session, WorkerStatus } from '../index.ts';
import { authenticate, loginWithPassword, registerUser, seedAccount } from './accounts.ts';
import {
  adminOverview,
  adminUsers,
  disconnectWorker,
  requireOwner,
  revokeUserLogins,
  setUserDisabled,
  setUserRole,
  updateSettings,
  updateOutdatedWorkers,
  updateWorker
} from './admin.ts';
import { isOutdated } from '../worker.ts';

const PASSWORD = 'correct horse battery';

async function setup() {
  const admin = inMemoryAdmin();
  const sign = async (email: string): Promise<{ principal: Principal; token: string }> => {
    // 第一个人注册成 hub 管理员；之后的人按内置账号加进他的团队（开放注册默认关闭）
    const first = (await admin.accounts.users.hubAdmin()) === null;
    let token: string;
    if (first) {
      const made = await registerUser(admin.accounts, { email, password: PASSWORD });
      assert.ok(made.ok && made.value.kind === 'login', email);
      token = made.value.issued.token;
    } else {
      assert.ok((await seedAccount(admin.accounts, { email, password: PASSWORD, role: 'member', displayName: email })).ok);
      const login = await loginWithPassword(admin.accounts, { email, password: PASSWORD });
      assert.ok(login.ok, email);
      token = login.value.token;
    }
    const principal = await authenticate(admin.accounts, token);
    assert.ok(principal);
    return { principal, token };
  };
  const owner = await sign('owner@b.co');
  const member = await sign('member@b.co');
  return { ...admin, owner, member, sign };
}

const worker = (workerId: string, origin: 'local' | 'remote', state: 'online' | 'offline'): WorkerStatus =>
  ({ workerId, label: workerId, origin, state, reason: null, hostname: 'h', platform: 'linux', lastSeenAt: 1, sessionCount: 0 }) as unknown as WorkerStatus;

test('只有在用的主人能进后台', async () => {
  const { owner, member } = await setup();
  assert.ok(requireOwner(owner.principal).ok);
  const denied = requireOwner(member.principal);
  assert.ok(!denied.ok && denied.error.code === 'forbidden');
  assert.equal(requireOwner(null).ok, false);
});

test('概览：人数、在线机器、运行中会话、最近注册与登录', async () => {
  const { deps, workerList, owner } = await setup();
  workerList.push(worker('local', 'local', 'online'), worker('w2', 'remote', 'offline'));
  const overview = await adminOverview(deps);
  assert.equal(overview.users, 2);
  assert.equal(overview.onlineWorkers, 1);
  assert.equal(overview.workers, 2);
  assert.equal(overview.runningSessions, 0);
  assert.equal(overview.recentLogins.length, 2);
  assert.ok(overview.recentLogins.some((row) => row.email === owner.principal.user.email));
});

test('用户列表：按邮箱搜索，带最近活跃与有效登录数', async () => {
  const { deps } = await setup();
  assert.equal((await adminUsers(deps)).length, 2);
  const [only] = await adminUsers(deps, 'MEMBER');
  assert.equal(only?.user.email, 'member@b.co');
  assert.equal(only?.activeLogins, 1);
  assert.ok(only?.lastSeenAt !== null);
});

test('停用：不能停自己；停用后对方登录态全没；再启用；都记审计', async () => {
  const { deps, accounts, owner, member, entries } = await setup();
  const self = await setUserDisabled(deps, owner.principal, owner.principal.user.id, true);
  assert.ok(!self.ok && self.error.code === 'conflict');
  const off = await setUserDisabled(deps, owner.principal, member.principal.user.id, true);
  assert.ok(off.ok && off.value.disabledAt !== null);
  assert.equal(await authenticate(accounts, member.token), null);
  const on = await setUserDisabled(deps, owner.principal, member.principal.user.id, false);
  assert.ok(on.ok && on.value.disabledAt === null);
  assert.deepEqual(
    entries.map((entry) => entry.action),
    ['user.enable', 'user.disable']
  );
});

test('角色：最后一个主人不能降级也不能被停用；有第二个主人后可以', async () => {
  const { deps, owner, member } = await setup();
  const demote = await setUserRole(deps, owner.principal, owner.principal.user.id, 'member');
  assert.ok(!demote.ok && demote.error.code === 'conflict');
  assert.ok((await setUserRole(deps, owner.principal, member.principal.user.id, 'owner')).ok);
  // 新主人停用原主人：原主人不是最后一个了，可以
  const other = { ...member.principal, user: { ...member.principal.user, role: 'owner' as const } };
  assert.ok((await setUserDisabled(deps, other, owner.principal.user.id, true)).ok);
  // 现在 other 是唯一可用的主人
  const last = await setUserRole(deps, owner.principal, member.principal.user.id, 'member');
  assert.ok(!last.ok);
});

test('踢下线：对别人删光；对自己保留当前这台', async () => {
  const { deps, accounts, owner, member } = await setup();
  const again = await loginWithPassword(accounts, { email: 'owner@b.co', password: PASSWORD });
  assert.ok(again.ok);
  assert.ok((await revokeUserLogins(deps, owner.principal, member.principal.user.id)).ok);
  assert.equal(await authenticate(accounts, member.token), null);
  assert.ok((await revokeUserLogins(deps, owner.principal, owner.principal.user.id)).ok);
  assert.ok(await authenticate(accounts, owner.token), '当前设备留着');
  const rows = [...accounts.loginRows.values()].filter((row) => row.userId === owner.principal.user.id);
  assert.equal(rows.length, 1);
});

test('设置：只记真正变了的项；关闭开放注册后成员注册被拒', async () => {
  const { deps, accounts, owner, entries } = await setup();
  await updateSettings(deps, owner.principal, { openRegistration: false });
  assert.equal(entries.length, 0);
  await updateSettings(deps, owner.principal, { openRegistration: true });
  assert.deepEqual(entries.map((entry) => entry.detail).sort(), ['openRegistration=true']);
  const next = await updateSettings(deps, owner.principal, { openRegistration: false });
  assert.equal(next.openRegistration, false);
  assert.deepEqual(entries.map((entry) => entry.detail).sort(), ['openRegistration=false', 'openRegistration=true']);
  const blocked = await registerUser(accounts, { email: 'late@b.co', password: PASSWORD });
  assert.ok(!blocked.ok && blocked.error.code === 'conflict');
});

test('断开机器：本机不能断；不在线报冲突；在线的远程机器断开并记审计', async () => {
  const { deps, workerList, disconnected, owner, entries } = await setup();
  workerList.push(worker('local', 'local', 'online'), worker('w2', 'remote', 'online'), worker('w3', 'remote', 'offline'));
  assert.equal((await disconnectWorker(deps, owner.principal, 'local')).ok, false);
  assert.equal((await disconnectWorker(deps, owner.principal, 'w3')).ok, false);
  assert.equal((await disconnectWorker(deps, owner.principal, 'nope')).ok, false);
  assert.ok((await disconnectWorker(deps, owner.principal, 'w2')).ok);
  assert.deepEqual(disconnected, ['w2']);
  assert.equal(entries[0]?.action, 'worker.disconnect');
});

test('更新机器：只发 hub 的提交、记审计；离线/不存在报错；「更新全部过期」只动在线且过期的', async () => {
  const { deps, workerList, updates, owner, entries } = await setup();
  const hub = deps.workers.hubBuild();
  workerList.push(
    { ...worker('local', 'local', 'online'), build: hub },
    { ...worker('w2', 'remote', 'online'), build: { ...hub, commit: 'b'.repeat(40) } },
    worker('w3', 'remote', 'online'),
    worker('w4', 'remote', 'offline')
  );
  assert.equal(isOutdated(workerList[0]!, hub), false);
  assert.equal(isOutdated(workerList[1]!, hub), true);
  assert.equal(isOutdated(workerList[2]!, hub), true, '没报版本的算过期');
  assert.equal((await updateWorker(deps, owner.principal, 'w4')).ok, false);
  assert.equal((await updateWorker(deps, owner.principal, 'nope')).ok, false);
  assert.ok((await updateWorker(deps, owner.principal, 'local')).ok, '已是最新也能发：演练');
  assert.equal(entries[0]?.action, 'worker.update');
  assert.match(entries[0]?.detail ?? '', /aaaaaaa → aaaaaaa/);
  updates.length = 0;
  const all = await updateOutdatedWorkers(deps, owner.principal);
  assert.ok(all.ok);
  assert.deepEqual(
    updates.map((u) => u.id),
    ['w2', 'w3']
  );
  assert.ok(updates.every((u) => u.commit === hub.commit));
});

test('概览：刚派生/刚分叉、还没发过话的会话是「就绪」，不算运行中', async () => {
  const { deps, sessionList } = await setup();
  const base = { status: 'running', lastSeq: 0 } as unknown as Session;
  sessionList.push(base, { ...base, lastSeq: 3 }, { ...base, status: 'done', lastSeq: 5 } as Session);
  assert.equal((await adminOverview(deps)).runningSessions, 1);
});
