import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAdmin, inMemoryDeps } from '@agent-hub/domain/testing';
import type { WorkerStatus } from '@agent-hub/domain';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

const PASSWORD = 'long enough pw';

/** 两个浏览器（各自一个 cookie 罐）对着同一个 hub。 */
function harness() {
  const admin = inMemoryAdmin();
  const { deps } = inMemoryDeps();
  const app = createApp({
    deps,
    hub: createStreamHub(),
    token: null,
    auth: { accounts: admin.accounts, hubToken: null },
    admin: { deps: admin.deps }
  });
  const browser = () => {
    const jar = new Map<string, string>();
    return async (path: string, init: RequestInit & { csrf?: boolean } = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (init.csrf !== false && jar.get('hub_csrf')) headers['x-hub-csrf'] = jar.get('hub_csrf')!;
      const response = await app.fetch(new Request(`http://hub${path}`, { ...init, headers }));
      for (const line of response.headers.getSetCookie()) {
        const [name, value] = line.split(';')[0]!.split('=');
        if (value === '' || /Max-Age=0/.test(line)) jar.delete(name!);
        else jar.set(name!, value!);
      }
      return { status: response.status, body: (await response.json().catch(() => null)) as any };
    };
  };
  return { ...admin, browser };
}

async function signedIn(h: ReturnType<typeof harness>) {
  const owner = h.browser();
  const member = h.browser();
  const register = (email: string) => ({ method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal((await owner('/api/auth/register', register('boss@b.co'))).status, 200);
  assert.equal((await member('/api/auth/register', register('m@b.co'))).status, 200);
  const users = (await owner('/api/admin/users')).body as { id: string; email: string }[];
  const id = (email: string) => users.find((u) => u.email === email)!.id;
  return { owner, member, ownerId: id('boss@b.co'), memberId: id('m@b.co') };
}

test('后台只给主人：成员 403，没登录 401；写请求没 CSRF 也 403', async () => {
  const h = harness();
  const { owner, member, memberId } = await signedIn(h);
  assert.equal((await member('/api/admin/overview')).status, 403);
  assert.equal((await h.browser()('/api/admin/overview')).status, 401);
  assert.equal((await owner('/api/admin/overview')).body.users, 2);
  assert.equal((await owner(`/api/admin/users/${memberId}/disable`, { method: 'POST', csrf: false })).status, 403);
});

test('停用成员：对方立刻掉线；不能停自己；最后一个主人不能降级；审计有记录', async () => {
  const h = harness();
  const { owner, member, ownerId, memberId } = await signedIn(h);
  assert.equal((await owner(`/api/admin/users/${ownerId}/disable`, { method: 'POST' })).status, 409);
  const role = { method: 'POST', body: JSON.stringify({ role: 'member' }) };
  assert.equal((await owner(`/api/admin/users/${ownerId}/role`, role)).status, 409);

  const off = await owner(`/api/admin/users/${memberId}/disable`, { method: 'POST' });
  assert.equal(off.body.disabled, true);
  assert.equal((await member('/api/projects')).status, 401);
  assert.equal((await owner(`/api/admin/users/${memberId}/enable`, { method: 'POST' })).body.disabled, false);

  const audit = (await owner('/api/admin/audit')).body as { action: string; actorEmail: string }[];
  assert.deepEqual(audit.map((a) => a.action), ['user.enable', 'user.disable']);
  assert.equal(audit[0]?.actorEmail, 'boss@b.co');
});

test('提拔成员为主人后，后台就对他开放；踢下线后他要重新登录', async () => {
  const h = harness();
  const { owner, member, memberId } = await signedIn(h);
  await owner(`/api/admin/users/${memberId}/role`, { method: 'POST', body: JSON.stringify({ role: 'owner' }) });
  assert.equal((await member('/api/admin/overview')).status, 200);
  await owner(`/api/admin/users/${memberId}/revoke-logins`, { method: 'POST' });
  assert.equal((await member('/api/admin/overview')).status, 401);
});

test('设置落库并在服务端生效：关注册后新人注册被拒；成员看不到加机器说明', async () => {
  const h = harness();
  const { owner, member } = await signedIn(h);
  assert.equal((await member('/api/workers/enroll-info')).body.allowed, true);
  const saved = await owner('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify({ openRegistration: false, membersCanAddMachines: false })
  });
  assert.deepEqual(saved.body, { openRegistration: false, membersCanAddMachines: false });
  assert.equal((await h.browser()('/api/auth/state')).body.registration, false);
  const late = await h.browser()('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'x@b.co', password: PASSWORD }) });
  assert.equal(late.status, 409);
  assert.equal((await member('/api/workers/enroll-info')).body.allowed, false);
  assert.equal((await owner('/api/workers/enroll-info')).body.allowed, true);
  assert.equal((await owner('/api/admin/settings', { method: 'PUT', body: '{"openRegistration":"yes"}' })).status, 400);
});

test('机器：列出状态与来路；断开在线的远程机器，本机不让断', async () => {
  const h = harness();
  const { owner } = await signedIn(h);
  const status = (workerId: string, origin: 'local' | 'remote') =>
    ({ workerId, label: workerId, origin, state: 'online', lastSeenAt: 5 }) as WorkerStatus;
  h.workerList.push(status('local', 'local'), status('lap', 'remote'));
  const list = (await owner('/api/admin/workers')).body as { workerId: string; enrolledBy: string }[];
  assert.equal(list.length, 2);
  assert.match(list[1]!.enrolledBy, /HUB_TOKEN/);
  assert.equal((await owner('/api/admin/workers/local/disconnect', { method: 'POST' })).status, 409);
  assert.equal((await owner('/api/admin/workers/lap/disconnect', { method: 'POST' })).status, 200);
  assert.deepEqual(h.disconnected, ['lap']);
});
