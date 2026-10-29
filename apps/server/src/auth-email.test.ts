import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAccounts, inMemoryAdmin, inMemoryDeps, mailedToken } from '@agent-hub/domain/testing';
import type { AccountDeps } from '@agent-hub/domain';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

const PASSWORD = 'long enough pw';

function harness(extra: Partial<AccountDeps> = {}, mailRateMax = 5) {
  let clock = 1_000_000;
  const admin = inMemoryAdmin(() => clock);
  const base = inMemoryAccounts(() => clock);
  const accounts = { ...base, ...extra };
  const { deps } = inMemoryDeps({ now: () => clock });
  const app = createApp({ deps, hub: createStreamHub(), token: null, auth: { accounts, hubToken: null, mailRateMax }, admin: { deps: { ...admin.deps, users: base.users, logins: base.logins, settings: base.settings } } });
  const browser = (ua = 'test-browser') => {
    const jar = new Map<string, string>();
    return async (path: string, init: RequestInit & { csrf?: boolean } = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': ua };
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
  return { accounts: base, browser, tick: (ms: number) => (clock += ms) };
}
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

test('第一位主人直接算已验证；新成员未验证只能看「去验证邮箱」，点信里链接后放行', async () => {
  const h = harness();
  const owner = h.browser();
  const member = h.browser();
  assert.equal((await owner('/api/auth/register', post({ email: 'boss@b.co', password: PASSWORD }))).body.user.emailVerified, true);
  assert.equal(h.accounts.sent.length, 0);
  const reg = await member('/api/auth/register', post({ email: 'm@b.co', password: PASSWORD }));
  assert.equal(reg.body.user.emailVerified, false);
  assert.equal((await member('/api/projects')).status, 403);
  assert.equal((await member('/api/projects')).body.error.code, 'email_unverified');
  assert.equal((await member('/api/auth/state')).body.user.emailVerified, false);

  assert.equal((await member('/api/auth/resend-verification', post({}))).status, 200);
  const token = mailedToken(h.accounts, 'm@b.co');
  assert.equal(h.accounts.sent.filter((m) => m.kind === 'verify-email').length, 2);
  assert.equal((await member('/api/auth/verify-email', post({ token: 'nope' }))).status, 400);
  assert.equal((await member('/api/auth/verify-email', post({ token }))).status, 200);
  assert.equal((await member('/api/auth/verify-email', post({ token }))).status, 400); // 一次性
  assert.equal((await member('/api/projects')).status, 200);
});

test('验证链接 30 分钟过期', async () => {
  const h = harness();
  await h.browser()('/api/auth/register', post({ email: 'boss@b.co', password: PASSWORD }));
  const member = h.browser();
  await member('/api/auth/register', post({ email: 'm@b.co', password: PASSWORD }));
  h.tick(31 * 60 * 1000);
  assert.equal((await member('/api/auth/verify-email', post({ token: mailedToken(h.accounts, 'm@b.co') }))).status, 400);
});

test('忘记密码：有没有这个邮箱回应都一样；限流；重置后旧登录全失效并发「密码已修改」', async () => {
  const h = harness();
  const owner = h.browser('phone');
  await owner('/api/auth/register', post({ email: 'boss@b.co', password: PASSWORD }));
  const stranger = h.browser();
  const a = await stranger('/api/auth/password/forgot', post({ email: 'boss@b.co' }));
  const b = await stranger('/api/auth/password/forgot', post({ email: 'ghost@b.co' }));
  assert.equal(a.status, 204);
  assert.deepEqual([b.status, b.body], [a.status, a.body]);
  await new Promise((r) => setTimeout(r, 0));
  const token = mailedToken(h.accounts, 'boss@b.co', 'reset-password');
  assert.equal(h.accounts.sent.some((m) => m.to === 'ghost@b.co'), false);

  assert.equal((await stranger('/api/auth/password/reset', post({ token, password: 'short' }))).status, 400);
  const reset = await stranger('/api/auth/password/reset', post({ token, password: 'a brand new pw' }));
  assert.equal(reset.status, 200);
  assert.equal(reset.body.user.email, 'boss@b.co');
  assert.equal((await owner('/api/projects')).status, 401); // 旧设备被踢
  assert.equal((await stranger('/api/projects')).status, 200);
  assert.equal(h.accounts.sent.at(-1)?.kind, 'password-changed');
  assert.equal((await stranger('/api/auth/password/reset', post({ token, password: 'another new pw' }))).status, 400);
  assert.equal((await h.browser()('/api/auth/login', post({ email: 'boss@b.co', password: PASSWORD }))).status === 200, false);

  const spam = h.browser();
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await spam('/api/auth/password/forgot', post({ email: `x${i}@b.co` }))).status);
  assert.ok(codes.includes(429));
});

test('登录设备：列出、登出单台、登出其他所有设备', async () => {
  const h = harness();
  const phone = h.browser('phone');
  await phone('/api/auth/register', post({ email: 'boss@b.co', password: PASSWORD }));
  const laptop = h.browser('laptop');
  const tablet = h.browser('tablet');
  await laptop('/api/auth/login', post({ email: 'boss@b.co', password: PASSWORD }));
  await tablet('/api/auth/login', post({ email: 'boss@b.co', password: PASSWORD }));
  const list = (await phone('/api/auth/logins')).body as { id: string; userAgent: string; current: boolean }[];
  assert.equal(list.length, 3);
  assert.equal(list[0]!.current, true);
  assert.equal(list[0]!.userAgent, 'phone');
  const tab = list.find((l) => l.userAgent === 'tablet')!;
  assert.equal((await phone(`/api/auth/logins/${tab.id}`, { method: 'DELETE', csrf: false })).status, 403);
  assert.equal((await phone(`/api/auth/logins/${tab.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await tablet('/api/projects')).status, 401);
  assert.equal((await phone('/api/auth/logins/revoke-others', post({}))).status, 200);
  assert.equal((await laptop('/api/projects')).status, 401);
  assert.equal((await phone('/api/projects')).status, 200);
  assert.equal((await phone('/api/auth/logins')).body.length, 1);
});

test('主人可以在后台手动把成员标记为已验证', async () => {
  const h = harness();
  const owner = h.browser();
  const member = h.browser();
  await owner('/api/auth/register', post({ email: 'boss@b.co', password: PASSWORD }));
  await member('/api/auth/register', post({ email: 'm@b.co', password: PASSWORD }));
  const users = (await owner('/api/admin/users')).body as { id: string; email: string; emailVerified: boolean }[];
  const m = users.find((u) => u.email === 'm@b.co')!;
  assert.equal(m.emailVerified, false);
  assert.equal((await member(`/api/admin/users/${m.id}/verify`, post({}))).status, 403);
  assert.equal((await owner(`/api/admin/users/${m.id}/verify`, post({}))).body.emailVerified, true);
  assert.equal((await member('/api/projects')).status, 200);
});

test('HUB_MAX_USERS：名额满了自助注册被拒，state 显示注册关闭；第一位主人不受限', async () => {
  const h = harness({ maxUsers: 2 });
  await h.browser()('/api/auth/register', post({ email: 'boss@b.co', password: PASSWORD }));
  assert.equal((await h.browser()('/api/auth/state')).body.registration, true);
  assert.equal((await h.browser()('/api/auth/register', post({ email: 'm@b.co', password: PASSWORD }))).status, 200);
  const full = await h.browser()('/api/auth/register', post({ email: 'n@b.co', password: PASSWORD }));
  assert.notEqual(full.status, 200);
  assert.match(JSON.stringify(full.body), /名额已满/);
  assert.equal((await h.browser()('/api/auth/state')).body.registration, false);

  const solo = harness({ maxUsers: 1 });
  assert.equal((await solo.browser()('/api/auth/register', post({ email: 'boss@b.co', password: PASSWORD }))).status, 200);
});
