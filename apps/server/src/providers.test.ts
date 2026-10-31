import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { createProvider, ok, systemSubject, type WorkerCommand } from '@agent-hub/domain';
import { createSqliteProviders } from '@agent-hub/storage-sqlite';
import { createProviderRelay } from '@agent-hub/node-gateway';
import { serve } from '@hono/node-server';
import { RELAY_PATH, createProviderWiring } from './providers.ts';

const SECRET = 'sk-real-upstream-key';

/** 假上游：记下收到的头，回一段 SSE。 */
async function fakeUpstream() {
  const seen: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      seen.push({ url: request.url ?? '', headers: request.headers, body });
      if (request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ data: [{ id: 'm-1' }] }));
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"a":1}\n\n');
      setTimeout(() => response.end('data: [DONE]\n\n'), 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/v1`, seen, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

async function setup(routing: 'direct' | 'hub', upstream: string) {
  const providers = createSqliteProviders(new DatabaseSync(':memory:'), randomBytes(32));
  const deps = { providers, audit: null, now: () => Date.now() };
  const created = await createProvider(deps, systemSubject('test'), { scope: 'hub', slug: 'gw', name: 'GW', protocol: 'openai-chat', baseUrl: upstream, models: [{ id: 'm-1' }], routing, enabled: true, apiKey: SECRET });
  assert.ok(created.ok);
  const host = new Map<string, string>([['s1', 'w1']]);
  const wiring = createProviderWiring({
    deps,
    projectTeam: async () => null,
    userTeam: async () => null,
    hostOf: (sessionId) => host.get(sessionId) ?? null,
    testFromWorker: async () => ok({ ok: true, status: 200, message: 'ok', models: [] }),
    log: () => undefined
  });
  const app = new Hono();
  app.all(`${RELAY_PATH}/:handle/*`, (c) => wiring.relay(c));
  return { wiring, app, host, providers, provider: created.value };
}

const start = (model: string): WorkerCommand => ({
  kind: 'start_session',
  sessionId: 's1' as never,
  workerId: 'w1',
  taskId: 't1' as never,
  agentId: 'pi',
  workspaceRoot: '/tmp',
  origin: { kind: 'fresh' } as never,
  resume: null,
  options: { model }
});

test('不选 hub 模型：指令原样放行', async () => {
  const { wiring } = await setup('direct', 'http://127.0.0.1:9/v1');
  const result = await wiring.grantFor(start('cliproxy/x'));
  assert.ok(result.ok);
  assert.equal(result.value.kind === 'start_session' && result.value.provider, undefined);
});

test('direct：只给选中的提供商，带真 key（交给 worker 中继）', async () => {
  const { wiring } = await setup('direct', 'http://127.0.0.1:9/v1');
  const result = await wiring.grantFor(start('hub-gw/m-1'));
  assert.ok(result.ok && result.value.kind === 'start_session');
  assert.equal(result.value.provider?.via, 'direct');
  assert.equal(result.value.provider?.apiKey, SECRET);
  assert.equal(wiring.activeHandles(), 0);
});

test('没有的提供商 / 停用：启动失败，不静默换模型', async () => {
  const { wiring, providers, provider } = await setup('direct', 'http://127.0.0.1:9/v1');
  assert.equal((await wiring.grantFor(start('hub-nope/m-1'))).ok, false);
  await providers.save({ ...provider, enabled: false });
  assert.equal((await wiring.grantFor(start('hub-gw/m-1'))).ok, false);
});

test('via hub：真 key 不下发；中转剥掉来路凭据、注入真 key、SSE 透传、记用量', async () => {
  const upstream = await fakeUpstream();
  try {
    const { wiring, app, providers, provider } = await setup('hub', upstream.url);
    const result = await wiring.grantFor(start('hub-gw/m-1'));
    assert.ok(result.ok && result.value.kind === 'start_session');
    const grant = result.value.provider!;
    assert.equal(grant.via, 'hub');
    assert.ok(grant.baseUrl.startsWith(`${RELAY_PATH}/`));
    assert.notEqual(grant.apiKey, SECRET);
    assert.ok(!JSON.stringify(result.value).includes(SECRET));

    const response = await app.fetch(new Request(`http://hub${grant.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${grant.apiKey}`, 'content-type': 'application/json', cookie: 'x=1' }, body: '{"model":"m-1"}' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.match(await response.text(), /\[DONE\]/);
    const last = upstream.seen.at(-1)!;
    assert.equal(last.url, '/v1/chat/completions');
    assert.equal(last.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(last.headers.cookie, undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const usage = await providers.usage(provider.id);
    assert.equal(usage.requests, 1);
    assert.equal(usage.sessions, 1);
  } finally {
    await upstream.close();
  }
});

test('via hub：每个请求复查——令牌错、会话换了机器、提供商停用、会话结束都拒绝', async () => {
  const upstream = await fakeUpstream();
  try {
    const { wiring, app, host, providers, provider } = await setup('hub', upstream.url);
    const result = await wiring.grantFor(start('hub-gw/m-1'));
    assert.ok(result.ok && result.value.kind === 'start_session');
    const grant = result.value.provider!;
    const call = async (token = grant.apiKey) => {
      const response = await app.fetch(new Request(`http://hub${grant.baseUrl}/models`, { headers: { authorization: `Bearer ${token}` } }));
      await response.text();
      return response;
    };
    assert.equal((await call('wrong')).status, 401);
    host.set('s1', 'w2');
    assert.equal((await call()).status, 403);
    host.set('s1', 'w1');
    await providers.save({ ...provider, enabled: false });
    assert.equal((await call()).status, 403);
    await providers.save({ ...provider, enabled: true });
    assert.equal((await call()).status, 200);
    wiring.revoke('s1');
    assert.equal((await call()).status, 404);
    // 路径穿越：不许到达上游
    const hits = upstream.seen.length;
    const again = await wiring.grantFor(start('hub-gw/m-1'));
    assert.ok(again.ok && again.value.kind === 'start_session');
    const bad = await app.fetch(new Request(`http://hub${again.value.provider!.baseUrl}/%2e%2e/x`, { headers: { authorization: `Bearer ${again.value.provider!.apiKey}` } }));
        assert.ok([400, 404].includes(bad.status));
    assert.equal(upstream.seen.length, hits);
  } finally {
    await upstream.close();
  }
});

test('两种模式端到端：agent → worker 本机中继 →（hub 中转）→ 上游，agent 从不见真 key', async () => {
  const upstream = await fakeUpstream();
  const { wiring, app } = await setup('hub', upstream.url);
  const hub = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((resolve) => hub.once('listening', resolve));
  const hubUrl = `http://127.0.0.1:${(hub.address() as { port: number }).port}`;
  const relay = createProviderRelay();
  try {
    const granted = await wiring.grantFor(start('hub-gw/m-1'));
    assert.ok(granted.ok && granted.value.kind === 'start_session');
    const grant = granted.value.provider!;
    for (const mode of ['hub', 'direct'] as const) {
      const upstreamOf = mode === 'hub' ? { baseUrl: hubUrl + grant.baseUrl, apiKey: grant.apiKey } : { baseUrl: upstream.url, apiKey: SECRET };
      const session = await relay.open(`agent-${mode}`, { ...upstreamOf, protocol: 'openai-chat' });
      assert.ok(session.baseUrl.startsWith('http://127.0.0.1:'));
      const response = await fetch(`${session.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: '{"model":"m-1","stream":true}' });
      assert.equal(response.status, 200, mode);
      assert.match(await response.text(), /\[DONE\]/);
      assert.equal(upstream.seen.at(-1)!.headers.authorization, `Bearer ${SECRET}`);
    }
  } finally {
    await relay.stop();
    (hub as unknown as { closeAllConnections(): void }).closeAllConnections();
    hub.close();
    await upstream.close();
  }
});

test('换提供商要新开会话；同一提供商里换模型可以', async () => {
  const { wiring } = await setup('direct', 'http://127.0.0.1:9/v1');
  assert.equal(wiring.optionAllowed('hub-gw/m-1', 'model', 'hub-gw/m-2').ok, true);
  assert.equal(wiring.optionAllowed('hub-gw/m-1', 'model', 'cliproxy/x').ok, false);
  assert.equal(wiring.optionAllowed('cliproxy/x', 'model', 'hub-gw/m-1').ok, false);
  assert.equal(wiring.optionAllowed('a/b', 'model', 'c/d').ok, true);
  assert.equal(wiring.optionAllowed('hub-gw/m-1', 'thinking', 'high').ok, true);
});
