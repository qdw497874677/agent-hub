import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { createProviderRelay } from './provider-relay.ts';
import { safeSubpath } from './provider-proxy.ts';

const SECRET = 'sk-upstream-secret';

test('本机中继：令牌、剥凭据头、注入真 key、SSE、413、关掉后 404', async () => {
  const seen: IncomingHttpHeaders[] = [];
  const upstream = createServer((request, response) => {
    seen.push(request.headers);
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'leak=1' });
      response.write('data: 1\n\n');
      setTimeout(() => response.end('data: [DONE]\n\n'), 10);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as { port: number }).port;
  const relay = createProviderRelay({ limits: { maxRequestBytes: 1024, headersTimeoutMs: 5000, totalTimeoutMs: 10_000 } });
  try {
    const anthropic = await relay.open('s2', { baseUrl: `http://127.0.0.1:${port}`, apiKey: SECRET, protocol: 'anthropic' });
    const session = await relay.open('s1', { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, protocol: 'openai-chat' });
    assert.match(session.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/r\//);
    const post = (url: string, token: string, body = '{}', extra: Record<string, string> = {}) =>
      fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }, body });

    const wrong = await post(`${session.baseUrl}/chat/completions`, 'nope');
    assert.equal(wrong.status, 401);
    await wrong.text();

    const good = await post(`${session.baseUrl}/chat/completions`, session.token, '{}', { cookie: 'c=1', 'x-api-key': 'other', 'proxy-authorization': 'x' });
    assert.equal(good.status, 200);
    assert.equal(good.headers.get('set-cookie'), null);
    assert.match(await good.text(), /\[DONE\]/);
    const last = seen.at(-1)!;
    assert.equal(last.authorization, `Bearer ${SECRET}`);
    assert.equal(last.cookie, undefined);
    assert.equal(last['x-api-key'], undefined);
    assert.equal(last['proxy-authorization'], undefined);

    const viaAnthropic = await fetch(`${anthropic.baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': anthropic.token }, body: '{}' });
    assert.equal(viaAnthropic.status, 200);
    await viaAnthropic.text();
    assert.equal(seen.at(-1)!['x-api-key'], SECRET);
    assert.equal(seen.at(-1)!.authorization, undefined);

    const big = await post(`${session.baseUrl}/chat/completions`, session.token, 'x'.repeat(4096));
    assert.equal(big.status, 413);
    await big.text();

    relay.close('s1');
    const gone = await post(`${session.baseUrl}/chat/completions`, session.token);
    assert.equal(gone.status, 404);
    await gone.text();
  } finally {
    await relay.stop();
    upstream.closeAllConnections();
    upstream.close();
  }
});

test('update：热更新后新请求立刻用新的 extra，不重开端口', async () => {
  const bodies: string[] = [];
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as { port: number }).port;
  const relay = createProviderRelay({ limits: { maxRequestBytes: 4096, headersTimeoutMs: 5000, totalTimeoutMs: 10_000 } });
  try {
    const session = await relay.open('s1', {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: SECRET,
      protocol: 'openai-chat',
      models: [{ id: 'm', extra: { temperature: 0.1 } }]
    });
    const post = async () => {
      const response = await fetch(`${session.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [] })
      });
      await response.text();
    };
    await post();
    assert.equal(JSON.parse(bodies.at(-1)!).temperature, 0.1);

    relay.update('s1', { models: [{ id: 'm', extra: { temperature: 0.9, reasoning: { effort: 'high' } } }] });
    await post();
    const updated = JSON.parse(bodies.at(-1)!) as Record<string, unknown>;
    assert.equal(updated['temperature'], 0.9);
    assert.deepEqual(updated['reasoning'], { effort: 'high' });
    assert.match(session.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/r\//);

    // 没有这个会话：静默忽略，不影响别的会话
    relay.update('nope', { models: [] });
    await post();
    assert.equal((JSON.parse(bodies.at(-1)!) as Record<string, unknown>)['temperature'], 0.9);
  } finally {
    await relay.stop();
    upstream.closeAllConnections();
    upstream.close();
  }
});

test('safeSubpath 挡住穿越和绝对地址', () => {
  assert.equal(safeSubpath('/chat/completions?x=1'), '/chat/completions?x=1');
  for (const bad of ['//evil.com/x', '/../x', '/a/./b', '/%2e%2e/x', '/a%2fb', 'http://x', '/a\\b']) assert.equal(safeSubpath(bad), null, bad);
});
