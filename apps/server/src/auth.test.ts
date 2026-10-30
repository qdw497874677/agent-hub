import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAccounts, inMemoryDeps } from '@agent-hub/domain/testing';
import { seedAccount } from '@agent-hub/domain';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

const DAY = 24 * 60 * 60 * 1000;

function harness(hubToken: { value: string; until: number } | null = null) {
  let clock = 1_000_000;
  const accounts = inMemoryAccounts(() => clock);
  const { deps } = inMemoryDeps({ now: () => clock });
  const app = createApp({ deps, hub: createStreamHub(), token: hubToken?.value ?? null, auth: { accounts, hubToken } });
  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit & { csrf?: boolean; base?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string>) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (init.csrf && jar.get('hub_csrf')) headers['x-hub-csrf'] = jar.get('hub_csrf')!;
    const response = await app.fetch(new Request(`${init.base ?? 'http://hub'}${path}`, { ...init, headers }));
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const [name, value] = pair!.split('=');
      if (value === '' || /Max-Age=0/.test(line)) jar.delete(name!);
      else jar.set(name!, value!);
    }
    return { status: response.status, body: (await response.json().catch(() => null)) as any, cookies: response.headers.getSetCookie() };
  };
  return { app, call, accounts, jar, tick: (ms: number) => (clock += ms) };
}

test('没登录：API 401，健康检查和账号接口放行', async () => {
  const { call } = harness();
  assert.equal((await call('/api/projects')).status, 401);
  assert.equal((await call('/api/health')).status, 200);
  assert.deepEqual((await call('/api/auth/state')).body, { user: null, tokenLogin: false, registration: true, mailDelivery: false });
});

test('注册 → 有 cookie、能调 API；写请求要 CSRF 头；登出后 cookie 失效', async () => {
  const { call, jar } = harness();
  const registered = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'A@B.co', password: 'long enough pw' }) });
  assert.equal(registered.status, 200);
  assert.equal(registered.body.user.email, 'a@b.co');
  assert.equal(registered.body.user.role, 'owner');
  const login = registered.cookies.find((c) => c.startsWith('hub_login='))!;
  assert.match(login, /HttpOnly/);
  assert.match(login, /SameSite=Lax/);
  assert.doesNotMatch(login, /Secure/); // http 测试环境不加 Secure

  assert.equal((await call('/api/projects')).status, 200);
  const body = JSON.stringify({ name: 'demo', rootPath: '/tmp/demo' });
  assert.equal((await call('/api/projects', { method: 'POST', body })).status, 403);
  assert.equal((await call('/api/projects', { method: 'POST', body, csrf: true })).status, 201);
  assert.equal((await call('/api/auth/state')).body.user.email, 'a@b.co');

  const saved = jar.get('hub_login')!;
  await call('/api/auth/logout', { method: 'POST', csrf: true });
  jar.set('hub_login', saved); // 拿旧 cookie 再来：服务端已删
  assert.equal((await call('/api/projects')).status, 401);
});

test('登录：错密码与不存在的邮箱同一句话；停用账号拒绝；https 下用 __Host- 与 Secure', async () => {
  const { call, accounts } = harness();
  await seedAccount(accounts, { email: 't@x.co', password: 'seeded password', role: 'owner', displayName: 't' });
  const wrong = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 't@x.co', password: 'nope nope nope' }) });
  const ghost = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'g@x.co', password: 'nope nope nope' }) });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.message, ghost.body.error.message);

  const ok = await call('/api/auth/login', { method: 'POST', base: 'https://hub', body: JSON.stringify({ email: 'T@x.co', password: 'seeded password' }) });
  assert.equal(ok.status, 200);
  assert.match(ok.cookies.find((c) => c.startsWith('__Host-hub_login='))!, /Secure/);

  const user = (await accounts.users.byEmail('t@x.co'))!;
  await accounts.users.save({ ...user, disabledAt: 5 });
  const disabled = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 't@x.co', password: 'seeded password' }) });
  assert.equal(disabled.status, 409);
});

test('旧 HUB_TOKEN：过渡期内 Bearer 放行、能换 Owner 登录；过期后两者都不行', async () => {
  const { app, call, accounts, jar, tick } = harness({ value: 's3cret', until: 1_000_000 + 30 * DAY });
  await seedAccount(accounts, { email: 'o@x.co', password: 'owner password', role: 'owner', displayName: 'o' });
  assert.equal((await call('/api/projects', { headers: { authorization: 'Bearer s3cret' } })).status, 200);
  // 查询串只给 SSE：别的接口带 ?token= 一律 401（令牌会进日志、历史和 Referer）
  assert.equal((await call('/api/projects?token=s3cret')).status, 401);
  const abort = new AbortController();
  const stream = await app.fetch(new Request('http://hub/api/stream?token=s3cret', { signal: abort.signal }));
  assert.equal(stream.status, 200);
  await stream.body?.cancel();
  abort.abort();
  assert.equal((await call('/api/projects', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await call('/api/auth/token-login', { method: 'POST', body: JSON.stringify({ token: 'wrong' }) })).status, 401);
  const exchanged = await call('/api/auth/token-login', { method: 'POST', body: JSON.stringify({ token: 's3cret' }) });
  assert.equal(exchanged.body.user.email, 'o@x.co');
  assert.equal((await call('/api/auth/state')).body.tokenLogin, true);

  jar.clear();
  tick(31 * DAY);
  assert.equal((await call('/api/projects', { headers: { authorization: 'Bearer s3cret' } })).status, 401);
  assert.equal((await call('/api/auth/token-login', { method: 'POST', body: JSON.stringify({ token: 's3cret' }) })).status, 401);
});

test('登录退避：同一邮箱连错 5 次后 429', async () => {
  const { call } = harness();
  const attempt = () => call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'x@x.co', password: 'wrong wrong' }) });
  for (let i = 0; i < 5; i += 1) assert.equal((await attempt()).status, 400);
  assert.equal((await attempt()).status, 429);
});
