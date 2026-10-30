import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAccounts, inMemoryDeps, mailedToken } from '@agent-hub/domain/testing';
import { createAccessPolicy } from '@agent-hub/domain';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

const PASSWORD = 'long enough pw';
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
const put = (body: unknown) => ({ method: 'PUT', body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: 'PATCH', body: JSON.stringify(body) });
const del = { method: 'DELETE' };

function harness(maxUsers?: number) {
  let clock = 1_000;
  const accounts = { ...inMemoryAccounts(() => clock), ...(maxUsers ? { maxUsers } : {}) };
  const world = inMemoryDeps();
  const access = createAccessPolicy({
    users: accounts.users,
    settings: accounts.settings,
    enrollment: { credentialFor: async () => null },
    gateway: world.deps.gateway
  });
  const deps = { ...world.deps, access };
  const team = { ...accounts, projects: world.deps.projects };
  const app = createApp({ deps, hub: createStreamHub(), token: null, auth: { accounts, team, hubToken: null, loginRateMax: 1000 } });
  const browser = () => {
    const jar = new Map<string, string>();
    return async (path: string, init: RequestInit = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (jar.get('hub_csrf')) headers['x-hub-csrf'] = jar.get('hub_csrf')!;
      const response = await app.fetch(new Request(`http://hub${path}`, { ...init, headers }));
      for (const line of response.headers.getSetCookie()) {
        const [name, value] = line.split(';')[0]!.split('=');
        if (value === '' || /Max-Age=0/.test(line)) jar.delete(name!);
        else jar.set(name!, value!);
      }
      return { status: response.status, body: (await response.json().catch(() => null)) as any, headers: response.headers };
    };
  };
  return { accounts, world, browser, tick: (ms: number) => (clock += ms) };
}

async function withDavid(maxUsers?: number) {
  const h = harness(maxUsers);
  const david = h.browser();
  assert.equal((await david('/api/auth/register', post({ email: 'david@b.co', password: PASSWORD }))).status, 200);
  return { ...h, david };
}

async function invited(h: Awaited<ReturnType<typeof withDavid>>, email: string, role: 'owner' | 'member' = 'member') {
  assert.equal((await h.david('/api/team/invites', post({ email, role }))).status, 201);
  const guest = h.browser();
  const accepted = await guest('/api/auth/invite/accept', post({ token: mailedToken(h.accounts, email, 'invite'), password: PASSWORD, displayName: 'Mia' }));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { guest, id: accepted.body.user.id as string };
}

test('邀请：进邀请人的团队、带角色、邮箱算已验证；链接只能用一次', async () => {
  const h = await withDavid();
  assert.equal((await h.david('/api/team/invites', post({ email: 'Mia@B.co', role: 'member' }))).status, 201);
  const token = mailedToken(h.accounts, 'mia@b.co', 'invite');
  const guest = h.browser();
  const preview = await guest('/api/auth/invite/preview', post({ token }));
  assert.equal(preview.body.email, 'mia@b.co');
  assert.equal(preview.body.role, 'member');
  const accepted = await guest('/api/auth/invite/accept', post({ token, password: PASSWORD }));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.user.emailVerified, true);
  assert.equal(accepted.body.user.role, 'member');
  assert.equal((await h.browser()('/api/auth/invite/accept', post({ token, password: PASSWORD }))).status, 400);
  const team = (await h.david('/api/team')).body;
  assert.deepEqual(team.members.map((m: any) => m.email), ['david@b.co', 'mia@b.co']);
  assert.deepEqual(team.invites, []);
  // 被邀请的成员能看团队，但不能邀请人、不能管人
  const asMember = (await guest('/api/team')).body;
  assert.equal(asMember.canManage, false);
  assert.equal((await guest('/api/team/invites', post({ email: 'x@b.co', role: 'member' }))).status, 403);
  assert.equal((await guest(`/api/team/members/${team.members[0].id}`, del)).status, 404);
  assert.ok(h.accounts.auditRows.some((row) => row.action === 'invite.create' && row.target === 'mia@b.co'));
});

test('邀请：已有账号 / 重复邀请不行；撤销后链接失效', async () => {
  const h = await withDavid();
  assert.equal((await h.david('/api/team/invites', post({ email: 'david@b.co', role: 'member' }))).status, 409);
  const first = await h.david('/api/team/invites', post({ email: 'x@b.co', role: 'member' }));
  assert.equal((await h.david('/api/team/invites', post({ email: 'x@b.co', role: 'member' }))).status, 409);
  const token = mailedToken(h.accounts, 'x@b.co', 'invite');
  assert.equal((await h.david(`/api/team/invites/${first.body.id}`, del)).status, 200);
  assert.equal((await h.browser()('/api/auth/invite/accept', post({ token, password: PASSWORD }))).status, 400);
});

test('邀请占 HUB_MAX_USERS 名额；团队 owner 可以勾「超出名额」', async () => {
  const h = await withDavid(2);
  assert.equal((await h.david('/api/team/invites', post({ email: 'a@b.co', role: 'member' }))).status, 201);
  const full = await h.david('/api/team/invites', post({ email: 'b@b.co', role: 'member' }));
  assert.equal(full.status, 409);
  assert.equal((await h.david('/api/team')).body.seatsLeft, 0);
  const over = await h.david('/api/team/invites', post({ email: 'b@b.co', role: 'member', allowOverLimit: true }));
  assert.equal(over.status, 201);
  assert.equal(over.body.allowOverLimit, true);
  for (const email of ['a@b.co', 'b@b.co']) {
    const r = await h.browser()('/api/auth/invite/accept', post({ token: mailedToken(h.accounts, email, 'invite'), password: PASSWORD }));
    assert.equal(r.status, 200, email);
  }
});

test('删人：软删 + 匿名化 + 踢下线，项目转给团队 owner；不能删自己 / 团队 owner', async () => {
  const h = await withDavid();
  const { guest, id } = await invited(h, 'mia@b.co');
  const project = (await guest('/api/projects', post({ name: 'mine' }))).body;
  assert.ok(project.id);
  const davidId = (await h.david('/api/auth/state')).body.user.id;
  assert.equal((await h.david(`/api/team/members/${davidId}`, del)).status, 409);
  const removed = await h.david(`/api/team/members/${id}`, del);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.transferredProjects, 1);
  assert.equal((await guest('/api/projects')).status, 401);
  const user = await h.accounts.users.byId(id as any);
  assert.ok(user?.deletedAt);
  assert.match(user!.email, /^deleted-.*@deleted\.invalid$/);
  assert.equal(user!.passwordHash, null);
  assert.equal((await h.world.deps.projects.byId(project.id))?.createdBy, davidId);
  assert.equal((await h.browser()('/api/auth/login', post({ email: 'mia@b.co', password: PASSWORD }))).status, 400);
  assert.deepEqual((await h.david('/api/team')).body.members.map((m: any) => m.email), ['david@b.co']);
  // 删掉以后邮箱腾出来了，可以再邀请
  assert.equal((await h.david('/api/team/invites', post({ email: 'mia@b.co', role: 'member' }))).status, 201);
  const audit = h.accounts.auditRows.find((row) => row.action === 'user.delete');
  assert.equal(audit?.target, 'mia@b.co');
});

test('改角色：团队 owner 能改别人，不能改自己（团队 owner）', async () => {
  const h = await withDavid();
  const { id } = await invited(h, 'mia@b.co');
  assert.equal((await h.david(`/api/team/members/${id}/role`, put({ role: 'owner' }))).status, 200);
  assert.equal((await h.accounts.users.byId(id as any))?.role, 'owner');
  const davidId = (await h.david('/api/auth/state')).body.user.id;
  assert.equal((await h.david(`/api/team/members/${davidId}/role`, put({ role: 'member' }))).status, 409);
});

test('别的团队的 owner 管不了我的团队', async () => {
  const h = await withDavid();
  const { id } = await invited(h, 'mia@b.co');
  await h.accounts.settings.save({ ...(await h.accounts.settings.get()), openRegistration: true });
  const other = h.browser();
  await other('/api/auth/register', post({ email: 'o@b.co', password: PASSWORD }));
  await other('/api/auth/verify-email', post({ token: mailedToken(h.accounts, 'o@b.co') }));
  assert.equal((await other('/api/auth/login', post({ email: 'o@b.co', password: PASSWORD }))).status, 200);
  assert.equal((await other(`/api/team/members/${id}`, del)).status, 404);
  assert.equal((await other(`/api/team/members/${id}/role`, put({ role: 'owner' }))).status, 404);
  assert.deepEqual((await other('/api/team')).body.members.map((m: any) => m.email), ['o@b.co']);
});

test('改密码：要原密码，踢掉其他设备，留下这台，发通知', async () => {
  const h = await withDavid();
  const laptop = h.browser();
  assert.equal((await laptop('/api/auth/login', post({ email: 'david@b.co', password: PASSWORD }))).status, 200);
  assert.equal((await h.david('/api/auth/password/change', post({ oldPassword: 'wrong password', newPassword: 'another long pw' }))).status, 400);
  const changed = await h.david('/api/auth/password/change', post({ oldPassword: PASSWORD, newPassword: 'another long pw' }));
  assert.equal(changed.status, 200);
  assert.equal((await h.david('/api/projects')).status, 200);
  assert.equal((await laptop('/api/projects')).status, 401);
  assert.ok(h.accounts.sent.some((m) => m.kind === 'password-changed' && m.to === 'david@b.co'));
  assert.equal((await h.browser()('/api/auth/login', post({ email: 'david@b.co', password: 'another long pw' }))).status, 200);
});

test('改显示名', async () => {
  const h = await withDavid();
  assert.equal((await h.david('/api/auth/profile', patch({ displayName: '  ' }))).status, 400);
  const r = await h.david('/api/auth/profile', patch({ displayName: '大卫' }));
  assert.equal(r.body.user.displayName, '大卫');
  assert.equal((await h.david('/api/auth/state')).body.user.displayName, '大卫');
});

test('登录退避：同一邮箱连错 5 次后要等，不管邮箱存不存在；到点放行，成功清零', async () => {
  const h = await withDavid();
  const b = h.browser();
  for (const email of ['david@b.co', 'nobody@b.co']) {
    for (let i = 0; i < 5; i++) assert.equal((await b('/api/auth/login', post({ email, password: 'wrong password' }))).status, 400);
    const blocked = await b('/api/auth/login', post({ email, password: PASSWORD }));
    assert.equal(blocked.status, 429, email);
    assert.equal(blocked.headers.get('retry-after'), '1');
  }
  h.tick(1000);
  assert.equal((await b('/api/auth/login', post({ email: 'david@b.co', password: PASSWORD }))).status, 200);
  assert.equal((await b('/api/auth/login', post({ email: 'david@b.co', password: 'wrong password' }))).status, 400);
  assert.equal((await b('/api/auth/login', post({ email: 'david@b.co', password: PASSWORD }))).status, 200);
  assert.ok(h.accounts.auditRows.some((row) => row.action === 'auth.login_failed' && row.target === 'nobody@b.co'));
});

test('按 IP 限流：不分邮箱，换着邮箱试也会被挡', async () => {
  const h = harness();
  const accounts = { ...h.accounts };
  const world = inMemoryDeps();
  const app = createApp({ deps: world.deps, hub: createStreamHub(), token: null, auth: { accounts, hubToken: null, loginRateMax: 3 } });
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await app.fetch(new Request('http://hub/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `u${i}@b.co`, password: 'wrong password' }) }));
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [400, 400, 400, 429]);
});
