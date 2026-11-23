import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { RpcChannel, ServerToWorker } from '@agent-hub/contract';
import { PROJECT_GIT_BUNDLE_MAX_BASE64_BYTES, WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT, createRpcChannel, wsImportProjectGitBundle } from '@agent-hub/contract';
import { createServerGateway, type GatewayHooks, type GatewayOptions } from './server-gateway.ts';
import { serveProjectGitBundleImport } from './worker-fs-rpc.ts';
import type { ProjectGitBundleImportInput, ProjectGitBundleImporter } from './project-git-bundle-import.ts';

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
  /** 网关选项：超时这类要用小值。 */
  readonly gateway?: GatewayOptions;
  /** 模拟 Worker 收到但不回复（聚合超时）。 */
  readonly drop?: (method: string) => boolean;
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
  }, options.gateway ?? {});
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
        if (options.drop?.(method)) return;
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

const bundleInput: ProjectGitBundleImportInput = {
  path: '/work/repo',
  expectedUrl: 'https://git.example.com/o/r.git',
  bundleBase64: 'aGVsbG8=',
  bundleSha256: 'b'.repeat(64),
  tipSha: 'c'.repeat(40),
  ref: `refs/agent-hub/fetch/project-1/${'c'.repeat(40)}`
};

test('项目 Git bundle 导入：未 opt-in 的 Worker 在发送前就拒绝（not_implemented），不回退', async () => {
  const { gateway, connect, stop } = await harness();
  const wire = await connect();
  const outcome = await gateway.importProjectGitBundle('w1', bundleInput);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.error.code, 'not_implemented');
  assert.equal(wire.calls.some((call) => call.method === 'ws.import_project_git_bundle'), false, '未声明能力时不该发任何 RPC');
  await stop(wire);
});

test('项目 Git bundle 导入：凭据没有 git 能力时 forbidden，也不发 RPC', async () => {
  const { gateway, connect, stop } = await harness({ authenticate: async () => ({ ok: true, capabilities: ['files.read'] }) });
  const wire = await connect('w1', { credential: 'c1', capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', bundleInput);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.error.code, 'forbidden');
  assert.equal(wire.calls.some((call) => call.method === 'ws.import_project_git_bundle'), false);
  await stop(wire);
});

test('项目 Git bundle 导入：opt-in 后六个字段原样发出，结果原样返回', async () => {
  const reply = { ref: bundleInput.ref, tipSha: bundleInput.tipSha, alreadyPresent: true };
  const { gateway, connect, stop } = await harness({
    reply: (method) => (method === 'ws.import_project_git_bundle' ? reply : { ok: true })
  });
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', bundleInput);
  assert.deepEqual(outcome, { ok: true, value: reply });
  const calls = wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle');
  assert.deepEqual(calls.map((call) => call.params), [bundleInput]);
  await stop(wire);
});

test('项目 Git bundle 导入：聚合超时只报「结果未知」，不自动重放', async () => {
  const { gateway, connect, stop } = await harness({
    drop: (method) => method === 'ws.import_project_git_bundle',
    gateway: { projectGitBundleTimeoutMs: 20 }
  });
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', bundleInput);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('应当超时');
  assert.equal(outcome.error.code, 'unavailable');
  assert.match(outcome.error.message, /结果未知/);
  assert.match(outcome.error.message, /不要自动重放/);
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 1, '超时后不应自动重发');
  await stop(wire);
});

test('项目 Git bundle 导入：出站参数不合法（SHA / 字段 / ref 绑定）在发送前拒绝，一个字节都不发', async () => {
  const { gateway, connect, stop } = await harness();
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', { ...bundleInput, tipSha: 'C'.repeat(40) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.error.code, 'invalid');
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 0, '参数不合法时不该发任何 RPC');
  await stop(wire);
});

test('项目 Git bundle 导入：超过固定 8 MiB（base64 上限）在发送前拒绝，一个字节都不发', async () => {
  const { gateway, connect, stop } = await harness();
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', {
    ...bundleInput,
    bundleBase64: 'A'.repeat(PROJECT_GIT_BUNDLE_MAX_BASE64_BYTES + 1)
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.error.code, 'invalid');
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 0, '超大 bundle 不该被塞进 WebSocket');
  await stop(wire);
});

test('项目 Git bundle 导入：响应自洽但 ref / tip 不是这次请求的，按「结果未知」处理且不重放', async () => {
  const otherSha = 'e'.repeat(40);
  const { gateway, connect, stop } = await harness({
    reply: (method) =>
      method === 'ws.import_project_git_bundle'
        ? { ref: `refs/agent-hub/fetch/project-2/${otherSha}`, tipSha: otherSha, alreadyPresent: true }
        : { ok: true }
  });
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', bundleInput);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('应当报结果未知');
  assert.equal(outcome.error.code, 'unavailable');
  assert.match(outcome.error.message, /结果未知/);
  assert.match(outcome.error.message, /不要自动重放/);
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 1);
  await stop(wire);
});

test('项目 Git bundle 导入：响应不合协议（bad_result）同样报「结果未知」，不重放', async () => {
  const { gateway, connect, stop } = await harness({
    reply: (method) => (method === 'ws.import_project_git_bundle' ? { ref: bundleInput.ref, tipSha: 'not-a-sha' } : { ok: true })
  });
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', bundleInput);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('应当报结果未知');
  assert.equal(outcome.error.code, 'unavailable');
  assert.match(outcome.error.message, /结果未知/);
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 1);
  await stop(wire);
});

test('项目 Git bundle 导入：对端明确 unknown_method 时诚实报未实现，不回退也不重放', async () => {
  const { gateway, connect, stop } = await harness({
    reply: (method) =>
      method === 'ws.import_project_git_bundle' ? { error: { code: 'unknown_method', message: 'unknown method' } } : { ok: true }
  });
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', bundleInput);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.error.code, 'not_implemented');
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 1);
  await stop(wire);
});

test('项目 Git bundle 导入：等待期间断线按「结果未知」处理，不自动重放', async () => {
  const { gateway, connect, stop } = await harness({ drop: (method) => method === 'ws.import_project_git_bundle' });
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const pending = gateway.importProjectGitBundle('w1', bundleInput);
  await until(() => wire.calls.some((call) => call.method === 'ws.import_project_git_bundle'));
  wire.ws.close();
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('断线应当报结果未知');
  assert.equal(outcome.error.code, 'unavailable');
  assert.match(outcome.error.message, /结果未知/);
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 1);
  await stop(wire);
});

/** 两条内存 RPC 通道直连：验证 Worker 侧 handler 的输入 / 单飞 / 错误翻译。 */
function rpcPair(): { readonly a: RpcChannel; readonly b: RpcChannel } {
  const ends: RpcChannel[] = [];
  ends.push(createRpcChannel({ idPrefix: 'a', timeoutMs: 500, send: (frame) => (queueMicrotask(() => ends[1]?.receive(frame)), true) }));
  ends.push(createRpcChannel({ idPrefix: 'b', timeoutMs: 500, send: (frame) => (queueMicrotask(() => ends[0]?.receive(frame)), true) }));
  return { a: ends[0]!, b: ends[1]! };
}

test('项目 Git bundle 导入（Worker 侧）：注入的导入器收到精确六字段；单飞期间第二个请求 conflict，settle 后才释放', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: ProjectGitBundleImportInput[] = [];
  const importer: ProjectGitBundleImporter = {
    async importBundle(input) {
      seen.push({ ...input });
      await gate;
      return { ok: true, value: { ref: input.ref, tipSha: input.tipSha, alreadyPresent: false } };
    }
  };
  const { a, b } = rpcPair();
  serveProjectGitBundleImport(b, importer);

  const first = a.request(wsImportProjectGitBundle, bundleInput);
  await until(() => seen.length === 1);
  const otherSha = 'd'.repeat(40);
  const second = await a.request(wsImportProjectGitBundle, { ...bundleInput, tipSha: otherSha, ref: `refs/agent-hub/fetch/project-1/${otherSha}` });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.error.code, 'conflict');
  assert.equal(seen.length, 1, '第二个请求不该进入导入器');

  release();
  assert.deepEqual(await first, { ok: true, value: { ref: bundleInput.ref, tipSha: bundleInput.tipSha, alreadyPresent: false } });
  assert.deepEqual(seen[0], bundleInput);
});

test('项目 Git bundle 导入（Worker 侧）：导入器失败只翻译 code，文案固定中性（不回传导入器 message）', async () => {
  const { a, b } = rpcPair();
  serveProjectGitBundleImport(b, {
    async importBundle() {
      return { ok: false, error: { code: 'conflict', message: '工作目录 /secret/path 状态不允许导入' } };
    }
  });
  assert.deepEqual(await a.request(wsImportProjectGitBundle, bundleInput), {
    ok: false,
    error: { code: 'conflict', message: '工作目录状态与项目 Git bundle 导入冲突，未创建 ref' }
  });
});

test('项目 Git bundle 导入（Worker 侧）：导入器抛错也换成固定中性文案，不泄露原始信息', async () => {
  const { a, b } = rpcPair();
  serveProjectGitBundleImport(b, {
    async importBundle() {
      throw new Error('git failed at /home/u/repo: bad object deadbeef');
    }
  });
  const outcome = await a.request(wsImportProjectGitBundle, bundleInput);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('应当失败');
  assert.equal(outcome.error.code, 'failed');
  assert.equal(outcome.error.message, '项目 Git bundle 导入失败（结果未知；先核对 ref，不要自动重放）');
  assert.equal(/deadbeef|\/home\/u\/repo/.test(outcome.error.message), false);
});
