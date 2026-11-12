import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { ServerToWorker } from '@agent-hub/contract';
import { createServerGateway, type GatewayHooks } from './server-gateway.ts';

interface Call {
  readonly method: string;
  readonly params: unknown;
}

interface Wire {
  readonly ws: WebSocket;
  readonly calls: Call[];
  readonly frames: ServerToWorker[];
}

interface HarnessOptions {
  readonly authenticate?: GatewayHooks['authenticate'];
  readonly onTerminalData?: GatewayHooks['onTerminalData'];
  readonly onTerminalExit?: GatewayHooks['onTerminalExit'];
  readonly knownTerminals?: GatewayHooks['knownTerminals'];
  readonly reply?: (method: string, params: unknown) => unknown;
}

async function harness(options: HarnessOptions = {}) {
  let helloSeen = false;
  const gateway = createServerGateway({
    token: null,
    ...(options.authenticate ? { authenticate: options.authenticate } : {}),
    onHello: () => {
      helloSeen = true;
    },
    onEvent: () => {},
    onAgentSession: () => {},
    onOptions: () => {},
    onStatus: () => {},
    onWorkerGone: () => {},
    ...(options.onTerminalData ? { onTerminalData: options.onTerminalData } : {}),
    ...(options.onTerminalExit ? { onTerminalExit: options.onTerminalExit } : {}),
    ...(options.knownTerminals ? { knownTerminals: options.knownTerminals } : {})
  });
  const server: Server = createServer();
  server.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const reply = options.reply ?? ((method: string, params: unknown) => {
    if (method === 'terminal.open') {
      const p = params as { cols: number; rows: number };
      return { cols: p.cols, rows: p.rows, reused: false };
    }
    if (method === 'terminal.list') return { terminals: [] };
    return { ok: true };
  });

  /** 冒充 worker 的裸 WebSocket：hello 之后所有 hub 发来的 rpc 立即回复。 */
  async function connect(workerId = 'w1', hello: Record<string, unknown> = {}): Promise<Wire> {
    const ws = new WebSocket(url);
    const calls: Call[] = [];
    const frames: ServerToWorker[] = [];
    ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as ServerToWorker & { frame?: { rpc: string; id: string; method: string; params: unknown } };
      if (frame.kind === 'rpc' && frame.frame?.rpc === 'call') {
        const { id, method, params } = frame.frame;
        calls.push({ method, params });
        const outcome = reply(method, params);
        ws.send(
          JSON.stringify({
            type: 'rpc',
            frame: 'error' in (outcome as object) ? { rpc: 'reply', id, error: (outcome as { error: unknown }).error } : { rpc: 'reply', id, result: outcome }
          })
        );
        return;
      }
      frames.push(frame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'hello', workerId, label: workerId, origin: 'remote', agents: [], roots: [], sessions: [], ...hello }));
    await until(() => helloSeen);
    return { ws, calls, frames };
  }

  const stop = async (...wires: Wire[]) => {
    for (const wire of wires) wire.ws.close();
    gateway.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { gateway, url, connect, stop };
}

async function until(predicate: () => boolean, message = '等待超时'): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('终端 RPC：open / resize / close / list 都走同一条通道并原样返回结果', async () => {
  const { gateway, connect, stop } = await harness();
  const wire = await connect();
  const opened = await gateway.openTerminal('w1', { terminalId: 's1:1', sessionId: 's1', cols: 120, rows: 40 });
  assert.deepEqual(opened, { ok: true, value: { cols: 120, rows: 40, reused: false } });
  assert.deepEqual(await gateway.resizeTerminal('w1', 's1:1', 100, 30), { ok: true, value: { ok: true } });
  assert.deepEqual(await gateway.closeTerminal('w1', 's1:1'), { ok: true, value: { ok: true } });
  assert.deepEqual(await gateway.listTerminals('w1'), { ok: true, value: [] });

  const methods = wire.calls.map((call) => call.method);
  assert.ok(methods.includes('terminal.open'));
  assert.ok(methods.includes('terminal.resize'));
  assert.ok(methods.includes('terminal.close'));
  assert.ok(methods.includes('terminal.list'));
  const open = wire.calls.find((call) => call.method === 'terminal.open');
  assert.deepEqual(open?.params, { terminalId: 's1:1', sessionId: 's1', cols: 120, rows: 40 });
  await stop(wire);
});

test('终端 RPC：离线、凭据没有 sessions、worker 回 unsupported 都折成 {ok:false}，不抛错', async () => {
  const { gateway, connect, stop } = await harness({
    authenticate: async () => ({ ok: true, capabilities: ['files.read'] })
  });
  const offline = await gateway.openTerminal('w1', { terminalId: 's1:1', sessionId: 's1', cols: 80, rows: 24 });
  assert.equal(offline.ok, false);
  assert.equal(offline.ok === false && offline.code, 'unavailable');

  const wire = await connect('w1', { credential: 'c1' });
  const denied = await gateway.openTerminal('w1', { terminalId: 's1:1', sessionId: 's1', cols: 80, rows: 24 });
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.code, 'forbidden');
  assert.equal(wire.calls.some((call) => call.method === 'terminal.list'), false, '没有 sessions 能力时不该对账');
  await stop(wire);
});

test('终端 RPC：worker 报 unsupported 时保留 code（界面据此隐藏页签）', async () => {
  const { gateway, connect, stop } = await harness({
    reply: (method) => (method === 'terminal.open' ? { error: { code: 'unsupported', message: '这台机器没有 node-pty' } } : { ok: true })
  });
  const wire = await connect();
  const opened = await gateway.openTerminal('w1', { terminalId: 's1:1', sessionId: 's1', cols: 80, rows: 24 });
  assert.deepEqual(opened, { ok: false, code: 'unsupported', message: '这台机器没有 node-pty' });
  await stop(wire);
});

test('worker 重连对账：terminal.list 里 hub 不认识的 terminalId 全发 terminal.close', async () => {
  const { connect, stop } = await harness({
    knownTerminals: () => new Set(['s2:1']),
    reply: (method) =>
      method === 'terminal.list'
        ? {
            terminals: [
              { terminalId: 's1:1', sessionId: 's1' },
              { terminalId: 's2:1', sessionId: 's2' }
            ]
          }
        : { ok: true }
  });
  const wire = await connect();
  await until(() => wire.calls.some((call) => call.method === 'terminal.close'));
  const closed = wire.calls.filter((call) => call.method === 'terminal.close');
  assert.deepEqual(closed.map((call) => call.params), [{ terminalId: 's1:1' }]);
  await stop(wire);
});

test('终端帧：worker 的 terminal_data / terminal_exit 按 terminalId 送到回调，输入走 terminal_input', async () => {
  const data: unknown[] = [];
  const exits: unknown[] = [];
  const { gateway, connect, stop } = await harness({
    onTerminalData: (workerId, terminalId, payload) => data.push({ workerId, terminalId, payload }),
    onTerminalExit: (workerId, terminalId, code) => exits.push({ workerId, terminalId, code })
  });
  const wire = await connect();
  wire.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 's1:1', data: 'aGk=' }));
  wire.ws.send(JSON.stringify({ type: 'terminal_exit', terminalId: 's1:1', code: 0 }));
  await until(() => data.length === 1 && exits.length === 1);
  assert.deepEqual(data[0], { workerId: 'w1', terminalId: 's1:1', payload: 'aGk=' });
  assert.deepEqual(exits[0], { workerId: 'w1', terminalId: 's1:1', code: 0 });

  assert.equal(gateway.sendTerminalInput('w1', 's1:1', 'bHM='), true);
  await until(() => wire.frames.some((frame) => frame.kind === 'terminal_input'));
  const input = wire.frames.find((frame) => frame.kind === 'terminal_input') as { terminalId: string; data: string };
  assert.equal(input.terminalId, 's1:1');
  assert.equal(input.data, 'bHM=');
  assert.equal(gateway.sendTerminalInput('offline', 's1:1', 'bHM='), false);
  await stop(wire);
});
