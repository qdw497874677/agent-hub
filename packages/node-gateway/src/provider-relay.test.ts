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

test('safeSubpath 挡住穿越和绝对地址', () => {
  assert.equal(safeSubpath('/chat/completions?x=1'), '/chat/completions?x=1');
  for (const bad of ['//evil.com/x', '/../x', '/a/./b', '/%2e%2e/x', '/a%2fb', 'http://x', '/a\\b']) assert.equal(safeSubpath(bad), null, bad);
});
