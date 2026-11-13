import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { WebSocket } from 'ws';
import type { Subject } from '@agent-hub/domain';
import { notFound } from '@agent-hub/domain';
import {
  createTerminalBridge,
  loginTokenOf,
  originMatches,
  type TerminalBridge,
  type TerminalBridgeOptions
} from './terminal-bridge.ts';

type Frame = { readonly t: string } & Record<string, unknown>;

const SUBJECT = { kind: 'user' } as unknown as Subject;

interface FakeGateway {
  readonly calls: {
    open: Array<{ workerId: string; terminalId: string; sessionId: string; cols: number; rows: number; cwd?: string }>;
    resize: Array<{ workerId: string; terminalId: string; cols: number; rows: number }>;
    close: Array<{ workerId: string; terminalId: string }>;
    input: Array<{ workerId: string; terminalId: string; data: string }>;
  };
  readonly gateway: TerminalBridgeOptions['gateway'];
}

function fakeGateway(): FakeGateway {
  const calls: FakeGateway['calls'] = { open: [], resize: [], close: [], input: [] };
  return {
    calls,
    gateway: {
      async openTerminal(workerId, input) {
        calls.open.push({ workerId, ...input });
        return { ok: true as const, value: { cols: input.cols, rows: input.rows, reused: false } };
      },
      async resizeTerminal(workerId, terminalId, cols, rows) {
        calls.resize.push({ workerId, terminalId, cols, rows });
        return { ok: true as const };
      },
      async closeTerminal(workerId, terminalId) {
        calls.close.push({ workerId, terminalId });
        return { ok: true as const };
      },
      sendTerminalInput(workerId, terminalId, data) {
        calls.input.push({ workerId, terminalId, data });
        return true;
      }
    }
  };
}

interface Harness extends FakeGateway {
  readonly port: number;
  readonly bridge: TerminalBridge;
  readonly logs: string[];
  readonly sockets: WebSocket[];
  close(): Promise<void>;
}

async function harness(overrides: Partial<TerminalBridgeOptions> = {}): Promise<Harness> {
  const fake = fakeGateway();
  const logs: string[] = [];
  const sockets: WebSocket[] = [];
  let bridge: TerminalBridge | null = null;
  let port = 0;

  const server: Server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on('upgrade', (request, socket, head) => {
    if (bridge) bridge.attach(request, socket, head);
    else socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  const host = `127.0.0.1:${port}`;

  bridge = createTerminalBridge({
    gateway: fake.gateway,
    target: async (_subject, sessionId) =>
      sessionId === 's1' ? { ok: true, value: { workerId: 'w1', root: '/tmp/demo' } } : { ok: false, error: notFound('会话不存在') },
    authenticate: async (token) => (token === 'good' ? SUBJECT : null),
    hostAllowed: (value) => value === host,
    log: (message) => logs.push(message),
    onSocket: (_sessionId, socket) => sockets.push(socket),
    heartbeatMs: 60_000,
    slowCheckMs: 60_000,
    ...overrides
  });

  return {
    calls: fake.calls,
    gateway: fake.gateway,
    port,
    bridge,
    logs,
    sockets,
    async close() {
      bridge?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

class Reader {
  readonly frames: Frame[] = [];
  constructor(socket: WebSocket) {
    socket.on('message', (data) => {
      this.frames.push(JSON.parse(String(data)) as Frame);
    });
  }
  async next(timeoutMs = 2000): Promise<Frame> {
    const started = Date.now();
    for (;;) {
      const frame = this.frames.shift();
      if (frame) return frame;
      if (Date.now() - started > timeoutMs) throw new Error('等待终端帧超时');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function open(port: number, cookie: string, options: { origin?: string } = {}): Promise<{ socket: WebSocket; reader: Reader; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/s1/terminal?cols=100&rows=30`, {
      headers: { Cookie: cookie },
      ...(options.origin ? { origin: options.origin } : {})
    });
    // ready 可能在 open 的同一个 tick 到达：监听必须在 open 之前挂好。
    const reader = new Reader(socket);
    // close 可能在帧之后立刻到达：同样提前挂好。
    const closed = new Promise<number>((done) => socket.once('close', (code) => done(code)));
    socket.once('open', () => resolve({ socket, reader, closed }));
    socket.once('error', reject);
  });
}

/** 直接发原始升级请求，拿响应头文本（失败时服务端会 end）。 */
function rawUpgrade(port: number, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    socket.on('error', reject);
    socket.setTimeout(700, () => {
      socket.destroy();
      resolve(text);
    });
    socket.on('close', () => resolve(text));
    const lines = [
      'GET /api/sessions/s1/terminal HTTP/1.1',
      `Host: ${headers.Host ?? `127.0.0.1:${port}`}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='
    ];
    for (const [name, value] of Object.entries(headers)) if (name !== 'Host') lines.push(`${name}: ${value}`);
    lines.push('', '');
    socket.write(lines.join('\r\n'));
  });
}

test('Origin：缺 Origin 只接受回环来源，有 Origin 必须与 Host 同源', () => {
  assert.equal(originMatches(undefined, 'hub.test', '127.0.0.1'), true);
  assert.equal(originMatches(undefined, 'hub.test', '::1'), true);
  assert.equal(originMatches(undefined, 'hub.test', '::ffff:127.0.0.1'), true);
  assert.equal(originMatches(undefined, 'hub.test', '10.0.0.5'), false);
  assert.equal(originMatches('http://hub.test', 'hub.test', '10.0.0.5'), true);
  assert.equal(originMatches('http://evil.test', 'hub.test', '10.0.0.5'), false);
  assert.equal(originMatches('not a url', 'hub.test', '127.0.0.1'), false);
});

test('cookie：两种名字都认，两个都在时必须一致', () => {
  assert.equal(loginTokenOf('hub_login=good'), 'good');
  assert.equal(loginTokenOf('__Host-hub_login=good'), 'good');
  assert.equal(loginTokenOf('a=1; hub_login=good; b=2'), 'good');
  assert.equal(loginTokenOf('hub_login=bad; __Host-hub_login=good'), '');
  assert.equal(loginTokenOf('hub_login=good; __Host-hub_login=good'), 'good');
  assert.equal(loginTokenOf('other=good'), '');
  assert.equal(loginTokenOf(undefined), '');
});

test('握手：Host / Origin / cookie / session.read 四步，按顺序拒绝', async () => {
  const world = await harness();
  try {
    const host = `127.0.0.1:${world.port}`;
    assert.match(await rawUpgrade(world.port, { Host: 'evil.test', Cookie: 'hub_login=good' }), /^HTTP\/1\.1 403 /);
    assert.match(await rawUpgrade(world.port, { Origin: 'http://evil.test', Cookie: 'hub_login=good' }), /^HTTP\/1\.1 403 /);
    // 缺 Origin + 回环：Origin 这步放行，卡在 cookie 上 → 401。
    assert.match(await rawUpgrade(world.port, {}), /^HTTP\/1\.1 401 /);
    assert.match(await rawUpgrade(world.port, { Cookie: 'hub_login=bad' }), /^HTTP\/1\.1 401 /);
    assert.match(await rawUpgrade(world.port, { Cookie: 'hub_login=good', Origin: `http://${host}` }), /^HTTP\/1\.1 101 /);
  } finally {
    await world.close();
  }
});

test('握手：不存在的会话返回 404', async () => {
  const world = await harness();
  try {
    const text = await rawUpgrade(world.port, { Cookie: '__Host-hub_login=good' });
    // rawUpgrade 固定请求 s1；换个会话 id 走 target 的 not_found 分支。
    assert.match(text, /^HTTP\/1\.1 101 /);
    const missing = await new Promise<string>((resolve, reject) => {
      const socket = connect(world.port, '127.0.0.1');
      let out = '';
      socket.on('data', (chunk) => {
        out += chunk.toString('utf8');
      });
      socket.on('error', reject);
      socket.on('close', () => resolve(out));
      socket.write(
        'GET /api/sessions/nope/terminal HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${world.port}\r\n` +
          'Cookie: hub_login=good\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
      );
    });
    assert.match(missing, /^HTTP\/1\.1 404 /);
  } finally {
    await world.close();
  }
});

test('第二个窗口被拒，旧的终端保持可用', async () => {
  const world = await harness();
  try {
    const first = await open(world.port, 'hub_login=good');
    assert.deepEqual(await first.reader.next(), { t: 'ready', terminalId: 's1:1' });

    const second = await open(world.port, 'hub_login=good');
    assert.deepEqual(await second.reader.next(), { t: 'error', message: '这个终端已在另一个窗口打开' });
    assert.equal(await second.closed, 1008);

    world.bridge.onWorkerData('w1', 's1:1', 'aGk=');
    assert.deepEqual(await first.reader.next(), { t: 'data', d: 'aGk=' });
    assert.equal(first.socket.readyState, WebSocket.OPEN);
    assert.equal(world.calls.open.length, 1);
    // hub 自己算好的工作目录随 open 下发：worker 不必再查本进程的会话表（已结束的会话也能开）。
    assert.equal(world.calls.open[0]!.cwd, '/tmp/demo');
    first.socket.close();
  } finally {
    await world.close();
  }
});

test('复用还活着的终端：ready 之后补发最近的输出', async () => {
  const fake = fakeGateway();
  const world = await harness({
    gateway: {
      ...fake.gateway,
      async openTerminal(_workerId: string, input: { cols: number; rows: number }) {
        return { ok: true as const, value: { cols: input.cols, rows: input.rows, reused: true, scrollback: 'aGk=' } };
      }
    }
  });
  try {
    const { reader } = await open(world.port, 'hub_login=good');
    assert.deepEqual(await reader.next(), { t: 'ready', terminalId: 's1:1' });
    assert.deepEqual(await reader.next(), { t: 'data', d: 'aGk=' });
  } finally {
    await world.close();
  }
});

test('会话结束：浏览器收到 exit，worker 收到 terminal.close', async () => {
  const world = await harness();
  try {
    const { reader, closed } = await open(world.port, '__Host-hub_login=good');
    assert.deepEqual(await reader.next(), { t: 'ready', terminalId: 's1:1' });

    world.bridge.closeSession('s1');
    assert.deepEqual(await reader.next(), { t: 'exit', code: 0 });
    assert.equal(await closed, 1000);
    assert.deepEqual(world.calls.close, [{ workerId: 'w1', terminalId: 's1:1' }]);
    assert.equal(world.bridge.knownTerminals('w1').size, 0);
  } finally {
    await world.close();
  }
});

test('机器离线：浏览器收到 error 机器离线', async () => {
  const world = await harness();
  try {
    const { reader, closed } = await open(world.port, 'hub_login=good');
    await reader.next();

    world.bridge.closeWorker('w1');
    assert.deepEqual(await reader.next(), { t: 'error', message: '机器离线' });
    assert.equal(await closed, 1011);
  } finally {
    await world.close();
  }
});

test('慢客户端：积压超过 4MB 持续 5 秒就关掉', async () => {
  let clock = 1_000_000;
  const world = await harness({ now: () => clock });
  try {
    const { socket, reader, closed } = await open(world.port, 'hub_login=good');
    await reader.next();
    const serverSocket = world.sockets[0];
    assert.ok(serverSocket, '应该拿到服务端 WebSocket');
    Object.defineProperty(serverSocket, 'bufferedAmount', { configurable: true, get: () => 5 * 1024 * 1024 });

    world.bridge.checkSlowClients();
    assert.equal(socket.readyState, WebSocket.OPEN, '刚开始积压还不关');
    clock += 5_100;
    world.bridge.checkSlowClients();
    assert.equal(await closed, 1008);
    assert.ok(world.logs.some((line) => line.includes('终端输出太慢')));
  } finally {
    await world.close();
  }
});

test('浏览器输入与 resize 转给 worker；心跳 ping 回 pong', async () => {
  const world = await harness();
  try {
    const { socket, reader } = await open(world.port, 'hub_login=good');
    await reader.next();

    socket.send(JSON.stringify({ t: 'input', d: 'bHM=' }));
    socket.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }));
    socket.send(JSON.stringify({ t: 'ping' }));
    assert.deepEqual(await reader.next(), { t: 'pong' });

    const started = Date.now();
    while (world.calls.resize.length === 0 && Date.now() - started < 2000) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(world.calls.input, [{ workerId: 'w1', terminalId: 's1:1', data: 'bHM=' }]);
    assert.deepEqual(world.calls.resize, [{ workerId: 'w1', terminalId: 's1:1', cols: 120, rows: 40 }]);
    assert.deepEqual([...world.bridge.knownTerminals()], ['s1:1']);
    socket.close();
  } finally {
    await world.close();
  }
});

test('会话刚派下来（not_ready）：短暂重试后正常开会话终端', async () => {
  const world = await harness();
  let attempts = 0;
  const gateway: TerminalBridgeOptions['gateway'] = {
    ...world.gateway,
    async openTerminal(_workerId, input) {
      attempts += 1;
      if (attempts < 3) return { ok: false as const, code: 'not_ready', message: '会话不在这台机器上运行' };
      return { ok: true as const, value: { cols: input.cols, rows: input.rows, reused: false } };
    }
  };
  const retrying = await harness({ gateway, openRetryMs: 5_000 });
  try {
    const { socket, reader } = await open(retrying.port, 'hub_login=good');
    assert.deepEqual(await reader.next(5_000), { t: 'ready', terminalId: 's1:1' });
    assert.equal(attempts, 3);
    socket.close();
  } finally {
    await retrying.close();
    await world.close();
  }
});
