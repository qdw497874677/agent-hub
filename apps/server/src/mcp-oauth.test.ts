import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpOAuth } from '@agent-hub/domain';
import { createMcpOAuth } from './mcp-oauth.ts';

const base: McpOAuth = {
  tokenUrl: 'https://auth.example.test/token',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  scope: 'tools.read',
  audience: 'mcp.example.test',
  authStyle: 'basic'
};

/** 假 fetch：记录每次请求，按次序给响应。 */
function fakeFetch(respond: (call: number) => Response): {
  calls: { url: string; init: RequestInit }[];
  impl: typeof fetch;
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(calls.length);
  }) as typeof fetch;
  return { calls, impl };
}

const tokenResponse = (body: Record<string, unknown>, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const formOf = (init: RequestInit): URLSearchParams => new URLSearchParams(String(init.body));

test('MCP OAuth：basic 认证把凭据放 Authorization 头，body 只带 grant/scope/audience', async () => {
  const { calls, impl } = fakeFetch(() => tokenResponse({ access_token: 'tok-1', expires_in: 3600 }));
  const oauth = createMcpOAuth({ fetch: impl });
  const result = await oauth.authorization(base);
  assert.ok(result.ok);
  assert.equal(result.value, 'Bearer tok-1');

  assert.equal(calls.length, 1);
  const [request] = calls;
  assert.ok(request);
  assert.equal(request.url, base.tokenUrl);
  assert.equal(request.init.method, 'POST');
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get('authorization'), `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
  assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
  const form = formOf(request.init);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('scope'), 'tools.read');
  assert.equal(form.get('audience'), 'mcp.example.test');
  assert.equal(form.get('client_id'), null);
  assert.equal(form.get('client_secret'), null);
});

test('MCP OAuth：authStyle=post 把 client_id/client_secret 放 body，不带 Basic 头', async () => {
  const { calls, impl } = fakeFetch(() => tokenResponse({ access_token: 'tok-2', expires_in: 3600 }));
  const oauth = createMcpOAuth({ fetch: impl });
  const result = await oauth.authorization({ ...base, authStyle: 'post' });
  assert.ok(result.ok);
  assert.equal(result.value, 'Bearer tok-2');
  const [request] = calls;
  assert.ok(request);
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get('authorization'), null);
  const form = formOf(request.init);
  assert.equal(form.get('client_id'), 'client-id');
  assert.equal(form.get('client_secret'), 'client-secret');
  assert.equal(form.get('scope'), 'tools.read');
});

test('MCP OAuth：缓存命中只请求一次，force 跳过缓存再取一次', async () => {
  const { calls, impl } = fakeFetch(() => tokenResponse({ access_token: 'tok-3', expires_in: 3600 }));
  const oauth = createMcpOAuth({ fetch: impl });
  const first = await oauth.authorization(base);
  const second = await oauth.authorization(base);
  assert.ok(first.ok && second.ok);
  assert.equal(first.value, second.value);
  assert.equal(calls.length, 1);

  const forced = await oauth.authorization(base, { force: true });
  assert.ok(forced.ok);
  assert.equal(calls.length, 2);
});

test('MCP OAuth：expires_in 提前 60 秒过期；缺省按 300 秒', async () => {
  let clock = 1_000_000;
  const { calls, impl } = fakeFetch(() => tokenResponse({ access_token: 'tok-4', expires_in: 300 }));
  const oauth = createMcpOAuth({ fetch: impl, now: () => clock });
  assert.ok((await oauth.authorization(base)).ok);
  assert.equal(calls.length, 1);

  clock += 239_000; // 300 - 60 = 240 秒有效期，还没到
  assert.ok((await oauth.authorization(base)).ok);
  assert.equal(calls.length, 1);

  clock += 2_000; // 过了 240 秒
  assert.ok((await oauth.authorization(base)).ok);
  assert.equal(calls.length, 2);

  const { calls: defaults, impl: defaultFetch } = fakeFetch(() => tokenResponse({ access_token: 'tok-5' }));
  let later = 5_000_000;
  const oauthDefault = createMcpOAuth({ fetch: defaultFetch, now: () => later });
  assert.ok((await oauthDefault.authorization(base)).ok);
  later += 239_000;
  assert.ok((await oauthDefault.authorization(base)).ok);
  assert.equal(defaults.length, 1);
  later += 2_000;
  assert.ok((await oauthDefault.authorization(base)).ok);
  assert.equal(defaults.length, 2);
});

test('MCP OAuth：失败返回中文错误、含状态码，且不带 client secret', async () => {
  const logged: string[] = [];
  const { impl } = fakeFetch(() => tokenResponse({ error: 'invalid_client', access_token: 'leaked' }, 401));
  const oauth = createMcpOAuth({ fetch: impl, log: (message) => logged.push(message) });
  const result = await oauth.authorization(base);
  assert.ok(!result.ok);
  assert.match(result.error.message, /401/);
  assert.match(result.error.message, /MCP OAuth/);
  assert.ok(!result.error.message.includes('client-secret'));
  assert.ok(!result.error.message.includes('leaked'));
  assert.equal(logged.length, 1);
  assert.match(logged[0] ?? '', /^MCP OAuth：取 token 失败（状态 401）$/);
});

test('MCP OAuth：force 刷新时上游仍 401 → 返回错误（只刷新一次）', async () => {
  const { calls, impl } = fakeFetch((n) =>
    n === 1 ? tokenResponse({ access_token: 'tok-6', expires_in: 3600 }) : tokenResponse({ error: 'nope' }, 401)
  );
  const oauth = createMcpOAuth({ fetch: impl });
  assert.ok((await oauth.authorization(base)).ok);
  const refreshed = await oauth.authorization(base, { force: true });
  assert.ok(!refreshed.ok);
  assert.match(refreshed.error.message, /状态 401/);
  assert.equal(calls.length, 2);
});

test('MCP OAuth：client secret 轮换后不会命中旧 token', async () => {
  const { calls, impl } = fakeFetch((n) => tokenResponse({ access_token: `tok-${n}`, expires_in: 3600 }));
  const oauth = createMcpOAuth({ fetch: impl });
  assert.ok((await oauth.authorization(base)).ok);
  assert.equal(calls.length, 1);

  const rotated = await oauth.authorization({ ...base, clientSecret: 'rotated-secret' });
  assert.ok(rotated.ok);
  assert.equal(rotated.value, 'Bearer tok-2');
  assert.equal(calls.length, 2, 'secret 变了必须重新取 token');

  assert.ok((await oauth.authorization({ ...base, clientSecret: 'rotated-secret' })).ok);
  assert.equal(calls.length, 2, '新 secret 自己可以命中缓存');
});
