import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkConnection, configPath, createMcpClient, main, McpError, parseEndpoint, readCredential,
  readEventPage, readHiddenToken, waitForTurn, writeCredential, type ProjectedEvent, type TtyInput
} from './workbench-mcp.ts';

const TOKEN = 'test-token-never-print';

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('endpoint：HTTPS 默认，HTTP 需显式允许且限受信主机', () => {
  assert.equal(parseEndpoint('https://hub.example/openapi/v1/mcp').protocol, 'https:');
  assert.throws(() => parseEndpoint('http://127.0.0.1:7878/openapi/v1/mcp'), /--allow-http/);
  assert.equal(parseEndpoint('http://127.0.0.1:7878/openapi/v1/mcp', true).hostname, '127.0.0.1');
  assert.equal(parseEndpoint('http://100.110.66.47:17900/mcp', true).hostname, '100.110.66.47');
  assert.throws(() => parseEndpoint('http://evil.example/mcp', true), /受信/);
  assert.throws(() => parseEndpoint('http://127.0.0.1.evil.example/mcp', true), /受信/);
  assert.throws(() => parseEndpoint('http://10.0.0.1.evil.example/mcp', true), /受信/);
  assert.throws(() => parseEndpoint('https://user:pass@hub.example/mcp'), /用户信息/);
  assert.throws(() => parseEndpoint('https://hub.example/not-mcp'), /\/mcp/);
});

test('凭据：0600 原子替换，拒绝过宽权限与 symlink', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'nested', 'workbench-mcp.json');
  writeCredential(path, { endpoint: 'https://hub.example/mcp', token: TOKEN, insecure: false });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readCredential(path).token, TOKEN);
  assert.equal(readCredential(path).url.href, 'https://hub.example/mcp');

  writeCredential(path, { endpoint: 'https://hub.example/mcp', token: 'new-token', insecure: false });
  assert.equal(readCredential(path).token, 'new-token');
  assert.ok(!readFileSync(path, 'utf8').includes(TOKEN), '旧令牌不能留在文件里');

  chmodSync(path, 0o644);
  assert.throws(() => readCredential(path), /权限过宽/);

  const target = join(dir, 'real.json');
  writeFileSync(target, readFileSync(path), { mode: 0o600 });
  chmodSync(target, 0o600);
  const link = join(dir, 'link.json');
  symlinkSync(target, link);
  assert.throws(() => readCredential(link), /symlink/);
});

test('configPath：环境变量与 XDG', () => {
  assert.equal(configPath({ AGENT_HUB_WORKBENCH_MCP_CONFIG: '/x/y.json' }, '/home/u'), '/x/y.json');
  assert.equal(configPath({ XDG_CONFIG_HOME: '/cfg' } as NodeJS.ProcessEnv, '/home/u'), '/cfg/agent-hub/workbench-mcp.json');
  assert.equal(configPath({} as NodeJS.ProcessEnv, '/home/u'), '/home/u/.config/agent-hub/workbench-mcp.json');
});

class FakeTty extends EventEmitter implements TtyInput {
  isTTY = true;
  writes: string[] = [];
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
}
class FakeOut { text = ''; write(value: string): void { this.text += value; } }

test('隐藏录入：只回显星号，支持退格 / Ctrl-C，且不输出令牌', async () => {
  const input = new FakeTty();
  const output = new FakeOut();
  const pending = readHiddenToken('令牌：', { input, output });
  input.emit('data', 'abc');
  input.emit('data', '\x7f');
  input.emit('data', 'd\r');
  assert.equal(await pending, 'abd');
  assert.equal(output.text.includes('abd'), false);
  assert.ok(output.text.includes('*'));
  assert.equal(input.isTTY, true);

  const cancelled = new FakeTty();
  const cancelOut = new FakeOut();
  const waiting = readHiddenToken('令牌：', { input: cancelled, output: cancelOut });
  cancelled.emit('data', '\x03');
  await assert.rejects(waiting, /取消/);

  const pipe = new FakeTty();
  pipe.isTTY = false;
  await assert.rejects(readHiddenToken('令牌：', { input: pipe, output: new FakeOut() }), /TTY/);
});

type Call = { method: string; params: Record<string, unknown>; auth: string | undefined; accept: string | undefined };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; destroy?: boolean; delayMs?: number };
type Handler = (call: Call) => Reply;

function rpc(result: unknown): unknown {
  return { jsonrpc: '2.0', id: 1, result };
}

async function fakeServer(t: TestContext, handler: Handler): Promise<{ url: string; calls: Call[] }> {
  const calls: Call[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string; params?: Record<string, unknown> };
      const call = { method: payload.method, params: payload.params ?? {}, auth: req.headers.authorization, accept: req.headers.accept };
      calls.push(call);
      const reply = handler(call);
      if (reply.destroy) {
        res.socket?.destroy();
        return;
      }
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
        res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs); else send();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('没有监听地址');
  return { url: `http://127.0.0.1:${address.port}`, calls };
}

function clientFor(url: string, token = TOKEN) {
  return createMcpClient({ endpoint: parseEndpoint(`${url}/mcp`, true), token, requestTimeoutMs: 2_000 });
}
const toolsReply = (names: string[] = ['events', 'get_session']): Reply => ({ body: rpc({ tools: names.map((name) => ({ name })) }) });
const arg = (call: Call, key: string): unknown =>
  (call.params['arguments'] as Record<string, unknown> | undefined)?.[key];
const pageReply = (events: ProjectedEvent[], nextAfter: number): Reply =>
  ({ body: rpc({ structuredContent: { events, nextAfter } }) });
const ended = (turn: number, outcome = 'done'): ProjectedEvent =>
  ({ seq: turn, turn, event: { kind: 'ended', outcome } });

test('check：ok / 401 / 缺工具 / 不可达分类', async (t) => {
  const ok = await fakeServer(t, () => toolsReply());
  const good = await checkConnection(clientFor(ok.url));
  assert.equal(good.ok, true);
  assert.deepEqual(good.tools, ['events', 'get_session']);
  assert.match(ok.calls[0]?.accept ?? '', /application\/json/);
  assert.match(ok.calls[0]?.accept ?? '', /text\/event-stream/);
  assert.equal(ok.calls[0]?.auth, `Bearer ${TOKEN}`);

  const denied = await fakeServer(t, () => ({ status: 401, body: { error: 'nope' }, headers: { 'www-authenticate': 'Bearer realm="agent-hub"' } }));
  const auth = await checkConnection(clientFor(denied.url));
  assert.equal(auth.kind, 'auth');
  assert.match(auth.message ?? '', /401/);

  const partial = await fakeServer(t, () => toolsReply(['events']));
  const missing = await checkConnection(clientFor(partial.url));
  assert.equal(missing.kind, 'missing-tools');
  assert.deepEqual(missing.missing, ['get_session']);

  const unreachable = createMcpClient({ endpoint: parseEndpoint('http://127.0.0.1:1/mcp', true), token: TOKEN, requestTimeoutMs: 500 });
  const result = await checkConnection(unreachable);
  assert.equal(result.kind, 'unreachable');

  const notFound = await fakeServer(t, () => ({ status: 404, body: 'no such endpoint' }));
  assert.equal((await checkConnection(clientFor(notFound.url))).kind, 'protocol');
});

test('check：不跟随重定向', async (t) => {
  const redirect = await fakeServer(t, () => ({ status: 307, headers: { location: 'http://127.0.0.1:9/mcp' }, body: '' }));
  const client = clientFor(redirect.url);
  await assert.rejects(client.listTools(), (error: McpError) => error.kind === 'redirect');
  assert.equal(redirect.calls.length, 1);
});

test('wait：四种 outcome 都算目标轮次结束', async (t) => {
  for (const outcome of ['done', 'stopped', 'interrupted', 'failed']) {
    const server = await fakeServer(t, () => pageReply([ended(1, outcome)], 2));
    const result = await waitForTurn(clientFor(server.url), { sessionId: 's1', turn: 1, timeoutMs: 1_000, sleep: async () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, outcome);
    assert.equal(arg(server.calls[0]!, 'sinceTurn'), 1);
  }
});

test('wait：旧轮次 / 其他轮次的 ended 不结束目标轮次', async (t) => {
  let call = 0;
  const server = await fakeServer(t, () => {
    call += 1;
    if (call === 1) return pageReply([ended(0, 'done'), ended(2, 'failed')], 3);
    return pageReply([ended(1, 'stopped')], 4);
  });
  const result = await waitForTurn(clientFor(server.url), { sessionId: 's1', turn: 1, timeoutMs: 1_000, sleep: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'stopped');
  assert.deepEqual(server.calls.map((entry) => arg(entry, 'after')), [0, 3]);
});

test('wait：空页也按 nextAfter 前进，游标不回头', async (t) => {
  let call = 0;
  const server = await fakeServer(t, () => {
    call += 1;
    if (call === 1) return pageReply([], 0);
    if (call === 2) return pageReply([], 4);
    return pageReply([ended(1)], 5);
  });
  const waits: number[] = [];
  const result = await waitForTurn(clientFor(server.url), {
    sessionId: 's1', turn: 1, timeoutMs: 2_000,
    sleep: async (ms) => { waits.push(ms); }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(server.calls.map((entry) => arg(entry, 'after')), [0, 0, 4]);
  assert.ok(waits.length >= 1, '同游标空页应退避，避免空转');
});

test('wait：单轮长等待只发一次请求', async (t) => {
  const server = await fakeServer(t, () => ({ ...pageReply([ended(1)], 2), delayMs: 60 }));
  const started = Date.now();
  const result = await waitForTurn(clientFor(server.url), { sessionId: 's1', turn: 1, timeoutMs: 1_000 });
  assert.equal(result.ok, true);
  assert.equal(server.calls.length, 1);
  assert.ok(Date.now() - started >= 50);
});

test('wait：断线后从同一 cursor 有界恢复，不重发 prompt', async (t) => {
  let call = 0;
  const server = await fakeServer(t, () => {
    call += 1;
    if (call === 1) return { destroy: true };
    return pageReply([ended(1)], 4);
  });
  const result = await waitForTurn(clientFor(server.url), {
    sessionId: 's1', turn: 1, timeoutMs: 2_000,
    sleep: async () => {}
  });
  assert.equal(result.ok, true);
  assert.equal(server.calls.length, 2);
  assert.deepEqual(server.calls.map((entry) => arg(entry, 'after')), [0, 0]);
  assert.equal(server.calls.some((entry) => entry.method === 'tools/call' && entry.params['name'] !== 'events'), false);
});

test('wait：瞬时错误有界重试，cursor 不变', async (t) => {
  const server = await fakeServer(t, () => ({ status: 503, body: 'down' }));
  const result = await waitForTurn(clientFor(server.url), {
    sessionId: 's1', turn: 1, timeoutMs: 2_000,
    maxTransientRetries: 2, sleep: async () => {}
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'unreachable');
  assert.equal(server.calls.length, 3);
  assert.deepEqual(server.calls.map((entry) => arg(entry, 'after')), [0, 0, 0]);
});

test('wait：deadline 与注入时间', async (t) => {
  const server = await fakeServer(t, () => pageReply([], 0));
  let clock = 0;
  const result = await waitForTurn(clientFor(server.url), {
    sessionId: 's1', turn: 1, timeoutMs: 1_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'deadline');
  assert.match(result.message ?? '', /1000ms/);
});

test('wait：401 立即失败不重试；nextAfter 回退是协议错误', async (t) => {
  const denied = await fakeServer(t, () => ({ status: 401, body: {} }));
  const auth = await waitForTurn(clientFor(denied.url), { sessionId: 's1', turn: 1, timeoutMs: 1_000, sleep: async () => {} });
  assert.equal(auth.kind, 'auth');
  assert.equal(denied.calls.length, 1);

  const regressed = await fakeServer(t, () => pageReply([], 3));
  const protocol = await waitForTurn(clientFor(regressed.url), { sessionId: 's1', turn: 1, after: 5, timeoutMs: 1_000, sleep: async () => {} });
  assert.equal(protocol.kind, 'protocol');
  assert.match(protocol.message ?? '', /回退/);

  const stuck = await fakeServer(t, () => pageReply([ended(1)], 7));
  const notAdvanced = await waitForTurn(clientFor(stuck.url), { sessionId: 's1', turn: 1, after: 7, timeoutMs: 1_000, sleep: async () => {} });
  assert.equal(notAdvanced.kind, 'protocol');
  assert.match(notAdvanced.message ?? '', /未前进/);
});

test('事件契约：只接受 structuredContent { events, nextAfter }', async (t) => {
  const missing = await fakeServer(t, () => ({ body: rpc({ content: [{ type: 'text', text: '{"events":[]}' }] }) }));
  const result = await waitForTurn(clientFor(missing.url), { sessionId: 's1', turn: 1, timeoutMs: 1_000, sleep: async () => {} });
  assert.equal(result.kind, 'protocol');
  assert.match(result.message ?? '', /structuredContent/);
  assert.throws(() => readEventPage({ events: [] }), /nextAfter/);
  assert.deepEqual(readEventPage({ events: [], nextAfter: 0 }), { events: [], nextAfter: 0 });
});

test('凭据不泄漏：服务端回显的令牌在错误文本里被抹掉', async (t) => {
  const server = await fakeServer(t, () => ({ status: 500, body: `server saw ${TOKEN}` }));
  const client = clientFor(server.url);
  await assert.rejects(client.listTools(), (error: McpError) => {
    assert.equal(error.kind, 'http');
    assert.equal(error.message.includes(TOKEN), false);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });

  const secret = 'a"b\\c';
  const escaped = await fakeServer(t, () => ({ status: 500, body: JSON.stringify({ echo: secret }) }));
  await assert.rejects(clientFor(escaped.url, secret).listTools(), (error: McpError) => {
    assert.equal(error.message.includes(JSON.stringify(secret).slice(1, -1)), false);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
});

test('login 命令行不接受内联令牌', async () => {
  const out = new FakeOut();
  const err = new FakeOut();
  const code = await main(['login', 'https://hub.example/mcp', '--token', 'inline-secret'], { out, err, input: new FakeTty() });
  assert.equal(code, 2);
  assert.equal(out.text.includes('inline-secret'), false);
  assert.equal(err.text.includes('inline-secret'), false);
  assert.match(err.text, /需要一个端点/);
});

test('main --json：JSON 转义后也不泄漏令牌', async (t) => {
  const secret = 'tok"en\\secret';
  const server = await fakeServer(t, () => pageReply([
    { seq: 1, turn: 1, event: { kind: 'text', text: `echo ${secret}` } },
    ended(1)
  ], 3));
  const path = join(tempDir(t), 'config.json');
  writeCredential(path, { endpoint: `${server.url}/mcp`, token: secret, insecure: true });
  const previous = process.env['AGENT_HUB_WORKBENCH_MCP_CONFIG'];
  process.env['AGENT_HUB_WORKBENCH_MCP_CONFIG'] = path;
  t.after(() => {
    if (previous === undefined) delete process.env['AGENT_HUB_WORKBENCH_MCP_CONFIG'];
    else process.env['AGENT_HUB_WORKBENCH_MCP_CONFIG'] = previous;
  });
  const out = new FakeOut();
  const err = new FakeOut();
  const code = await main(['wait', 's1', '1', '--json'], { out, err, input: new FakeTty() });
  assert.equal(code, 0);
  assert.equal(out.text.includes(secret), false);
  assert.match(out.text, /\[REDACTED\]/);
  assert.equal(err.text, '');
});
