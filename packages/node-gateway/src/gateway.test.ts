import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { AsyncQueue } from '@agent-hub/contract';
import type { AgentDto } from '@agent-hub/contract';
import {
  CAPABILITY_NAMES,
  available,
  asAgentId,
  asSessionId,
  asTaskId,
  capabilityMatrix,
  type AgentRuntime,
  type Capability,
  type CapabilityName,
  type RuntimeStatus,
  type SessionEvent,
  type StartSpec,
  type WorkerStatus
} from '@agent-hub/domain';
import { createServerGateway, type GatewayHooks } from './server-gateway.ts';
import { connectWorkerLink, type WorkerLink } from './worker-link.ts';
import { createWorkerFiles } from './worker-files.ts';

/** 一个只会把 prompt 回声成 text 再结束的 agent：够验证指令下行、事件上行。 */
function echoRuntime(seen: StartSpec[]): AgentRuntime {
  const all = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, available])) as Record<CapabilityName, Capability>;
  return {
    descriptor: {
      id: asAgentId('echo'),
      label: 'Echo',
      capabilities: capabilityMatrix(all),
      models: [],
      defaultModel: '',
      options: []
    },
    async start(spec) {
      seen.push(spec);
      const queue = new AsyncQueue<SessionEvent>();
      return {
        ok: true,
        value: {
          sessionId: spec.sessionId,
          async prompt({ text }) {
            queue.push({ kind: 'text', delta: text });
            queue.push({ kind: 'ended', outcome: 'done' });
            return { ok: true, value: undefined };
          },
          async interrupt() {},
          events: () => queue,
          async adopt() {},
          options: () => [],
          async changeOption() {
            return { ok: true, value: [] };
          },
          async dispose() {
            queue.close();
          }
        }
      };
    }
  };
}

interface Recorder {
  hooks: GatewayHooks;
  hellos: { worker: WorkerStatus; agents: AgentDto[] }[];
  events: SessionEvent[];
  statuses: RuntimeStatus[];
  refs: string[];
  gone: string[];
  goneReasons: string[];
  helloSessions: (readonly string[])[];
  until(predicate: () => boolean): Promise<void>;
}

function recorder(token: string | null): Recorder {
  const r: Recorder = {
    hellos: [],
    events: [],
    statuses: [],
    refs: [],
    gone: [],
    goneReasons: [],
    helloSessions: [],
    hooks: {
      token,
      onHello: (worker, agents, sessions) => {
        r.hellos.push({ worker, agents });
        r.helloSessions.push(sessions);
      },
      onEvent: (_worker, _id, event) => r.events.push(event),
      onAgentSession: (_worker, _id, ref) => r.refs.push(ref),
      onOptions: () => {},
      onStatus: (_worker, _id, status) => r.statuses.push(status),
      onWorkerGone: (id, reason) => {
        r.gone.push(id);
        r.goneReasons.push(reason);
      }
    },
    async until(predicate) {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('等待超时');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };
  return r;
}

async function harness(token: string | null, options: Parameters<typeof createServerGateway>[1] = {}) {
  const rec = recorder(token);
  const gateway = createServerGateway(rec.hooks, options);
  const server: Server = createServer();
  server.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stop = async (...links: (WorkerLink | undefined)[]) => {
    for (const link of links) await link?.close();
    gateway.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  };
  return { rec, gateway, url, server, stop };
}

const start = (sessionId: string, workerId: string) =>
  ({
    kind: 'start_session',
    sessionId: asSessionId(sessionId),
    workerId,
    taskId: asTaskId('t1'),
    agentId: 'echo',
    workspaceRoot: '/tmp',
    origin: { kind: 'derive' },
    resume: null,
    options: { model: 'm-1' }
  }) as const;

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const brief = (workers: WorkerStatus[]) => workers.map((w) => `${w.workerId}:${w.state}`);

test('握手：worker 带着 agent 清单、机器信息上线；断开后留在列表里标离线', async () => {
  const { rec, gateway, url, stop } = await harness('t0k');
  const link = connectWorkerLink({
    url,
    token: 't0k',
    workerId: 'w1',
    label: '笔记本',
    origin: 'remote',
    reconnect: false,
    host: { hostname: 'box', platform: 'linux', arch: 'x64' },
    roots: ['/home/me'],
    runtimes: [echoRuntime([])]
  });
  await rec.until(() => rec.hellos.length === 1);
  assert.equal(rec.hellos[0]?.agents[0]?.id, 'echo');
  const [status] = await gateway.gateway.status();
  assert.equal(status?.state, 'online');
  assert.equal(status?.hostname, 'box');
  assert.deepEqual(status?.agentIds, ['echo']);
  assert.deepEqual(status?.roots, ['/home/me']);
  await link.close();
  await rec.until(() => rec.gone.length === 1);
  assert.deepEqual(brief(gateway.workers()), ['w1:offline']);
  await stop();
});

test('token 不对的 worker 被拒、不重连，也不会出现在列表里', async () => {
  const { rec, gateway, url, stop } = await harness('right');
  let closed = false;
  const link = connectWorkerLink({ url, token: 'wrong', workerId: 'w1', label: 'x', runtimes: [], onClose: () => (closed = true) });
  await rec.until(() => closed);
  assert.equal(rec.hellos.length, 0);
  assert.deepEqual(gateway.workers(), []);
  await stop(link);
});

test('管理员断开：worker 收到 4403 后不再重连，列表里标离线并写明原因；不在线的断不了', async () => {
  const { rec, gateway, url, stop } = await harness('t0k');
  let closed = false;
  const link = connectWorkerLink({
    url,
    token: 't0k',
    workerId: 'w1',
    label: 'x',
    runtimes: [],
    initialBackoffMs: 10,
    onClose: () => (closed = true)
  });
  await rec.until(() => rec.hellos.length === 1);
  assert.equal(gateway.disconnect('w1'), true);
  await rec.until(() => closed);
  assert.deepEqual(rec.goneReasons, ['管理员断开']);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(rec.hellos.length, 1, '不该重连');
  assert.deepEqual(brief(gateway.workers()), ['w1:offline']);
  assert.equal(gateway.disconnect('w1'), false);
  assert.equal(gateway.disconnect('nope'), false);
  await stop(link);
});

test('start + prompt 连发：worker 串行执行，事件与状态回到 server，模型只走 options', async () => {
  const { rec, gateway, url, stop } = await harness(null);
  const seen: StartSpec[] = [];
  const link = connectWorkerLink({ url, token: '', workerId: 'w1', label: 'x', runtimes: [echoRuntime(seen)] });
  await rec.until(() => rec.hellos.length === 1);

  const sessionId = asSessionId('s1');
  assert.equal((await gateway.gateway.dispatch(start('s1', 'w1'))).ok, true);
  await gateway.gateway.dispatch({ kind: 'prompt', parts: [], sessionId, text: '你好' });

  await rec.until(() => rec.statuses.includes('ended'));
  assert.deepEqual(seen[0]?.options, { model: 'm-1' });
  assert.deepEqual(
    rec.events.map((event) => event.kind),
    ['text', 'ended']
  );
  assert.deepEqual(rec.statuses, ['running', 'ended']);

  link.notifyAgentSessionRef('s1', 'agent-ref-1');
  await rec.until(() => rec.refs.length === 1);
  assert.equal(rec.refs[0], 'agent-ref-1');
  await stop(link);
});

test('两台 worker：会话按落点路由，后续指令跟着会话走，不是发给第一台', async () => {
  const { rec, gateway, url, stop } = await harness(null);
  const seenA: StartSpec[] = [];
  const seenB: StartSpec[] = [];
  const a = connectWorkerLink({ url, token: '', workerId: 'A', label: 'A', runtimes: [echoRuntime(seenA)] });
  await rec.until(() => rec.hellos.length === 1);
  const b = connectWorkerLink({ url, token: '', workerId: 'B', label: 'B', origin: 'remote', runtimes: [echoRuntime(seenB)] });
  await rec.until(() => rec.hellos.length === 2);

  assert.ok((await gateway.gateway.dispatch(start('on-b', 'B'))).ok);
  assert.ok((await gateway.gateway.dispatch(start('on-a', 'A'))).ok);
  await rec.until(() => rec.statuses.filter((s) => s === 'running').length === 2);
  assert.deepEqual(seenB.map((spec) => spec.sessionId), ['on-b']);
  assert.deepEqual(seenA.map((spec) => spec.sessionId), ['on-a']);
  assert.equal(gateway.workers().find((w) => w.workerId === 'B')?.sessionCount, 1);

  // 落点不存在 / 不在线 → 明确报错，而不是悄悄换一台
  const nowhere = await gateway.gateway.dispatch(start('x', 'C'));
  assert.equal(nowhere.ok, false);

  // B 掉线：A 上的会话照常收指令，B 上的报不可用
  await b.close();
  await rec.until(() => rec.gone.includes('B'));
  assert.ok((await gateway.gateway.dispatch({ kind: 'prompt', parts: [], sessionId: asSessionId('on-a'), text: 'hi' })).ok);
  const toGone = await gateway.gateway.dispatch({ kind: 'prompt', parts: [], sessionId: asSessionId('on-b'), text: 'hi' });
  assert.equal(toGone.ok, false);
  assert.deepEqual(brief(gateway.workers()), ['A:online', 'B:offline']);
  await stop(a);
});

test('断线重连：worker 自动重连、重新 hello、报上还活着的会话，期间的事件补发', async () => {
  const rec = recorder(null);
  const server: Server = createServer();
  let gateway = createServerGateway(rec.hooks);
  server.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let opens = 0;
  // 只说话不结束的 agent：会话要在断线期间一直活着，重连时才有东西可「接回」。
  const queue = new AsyncQueue<SessionEvent>();
  const notify = (text: string) => queue.push({ kind: 'text', delta: text });
  const runtime = echoRuntime([]);
  runtime.start = async (spec) => {
    const started = await echoRuntime([]).start(spec);
    if (!started.ok) return started;
    return { ok: true, value: { ...started.value, events: () => queue, dispose: async () => queue.close() } };
  };
  const link = connectWorkerLink({
    url,
    token: '',
    workerId: 'w1',
    label: 'x',
    initialBackoffMs: 20,
    runtimes: [runtime],
    onOpen: () => (opens += 1)
  });
  await rec.until(() => rec.hellos.length === 1);
  assert.ok((await gateway.gateway.dispatch(start('live', 'w1'))).ok);
  await rec.until(() => rec.statuses.includes('running'));

  // server 重启：旧网关全断，换一个新的
  gateway.close();
  await rec.until(() => rec.gone.length === 1);
  gateway = createServerGateway(rec.hooks);
  notify('断线期间说的话'); // worker 这时还没连上：事件先攒着
  await rec.until(() => opens === 2 && rec.hellos.length === 2);
  assert.deepEqual(rec.helloSessions.at(-1), ['live']);
  await rec.until(() => rec.events.some((event) => event.kind === 'text'));
  assert.equal(gateway.workers()[0]?.state, 'online');
  // hello 报的清单不直接改路由：领域核对过落点后才 adopt
  assert.equal((await gateway.gateway.dispatch({ kind: 'interrupt', sessionId: asSessionId('live') })).ok, false);
  gateway.adopt('w1', ['live']);
  // 接回的会话可以直接收指令，不需要再 start 一次
  assert.ok((await gateway.gateway.dispatch({ kind: 'interrupt', sessionId: asSessionId('live') })).ok);
  await link.close();
  gateway.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test('心跳：worker 不回 pong 就被判离线', async () => {
  const { rec, gateway, url, stop } = await harness(null, { heartbeatMs: 40 });
  // 半开连接：TCP 还在、对面已经不响应了。autoPong:false 就是「不回 pong」。
  const mute = new WebSocket(url, { autoPong: false });
  await new Promise((resolve) => mute.once('open', resolve));
  mute.send(JSON.stringify({ type: 'hello', workerId: 'mute', label: 'x', origin: 'remote', agents: [] }));
  await rec.until(() => rec.hellos.length === 1);
  await rec.until(() => rec.gone.includes('mute'));
  assert.match(rec.goneReasons.at(-1) ?? '', /心跳/);
  assert.equal(gateway.workers()[0]?.state, 'offline');
  mute.terminate();
  await stop();
});

test('目录浏览走 worker：从 roots 起步；roots 外的目录拒并说明怎么放开；不在线时报不可用', async () => {
  const { rec, gateway, url, stop } = await harness(null);
  const base = await mkdtemp(join(tmpdir(), 'wf-'));
  await mkdir(join(base, 'root', 'app'), { recursive: true });
  const root = join(base, 'root');
  const link = connectWorkerLink({ url, token: '', workerId: 'w1', label: 'x', runtimes: [], files: createWorkerFiles({ roots: [root], enforced: true }) });
  await rec.until(() => rec.hellos.length === 1);
  assert.deepEqual(rec.hellos[0]?.worker.roots, [root]);
  const top = await gateway.gateway.listDirectories('w1', '');
  assert.ok(top.ok);
  assert.equal(top.value.path, root);
  assert.deepEqual(top.value.entries.map((e) => [e.name, e.path, e.isGit]), [['app', join(root, 'app'), false]]);
  assert.equal(typeof top.value.entries[0]?.modifiedAt, 'number');
  const missing = await gateway.gateway.listDirectories('w1', join(root, 'nope'));
  assert.ok(missing.ok && !missing.value.exists);
  const outside = await gateway.gateway.listDirectories('w1', base);
  assert.ok(!outside.ok && /WORKER_ROOTS/.test(outside.error.message) && /worker\.env/.test(outside.error.message));
  assert.equal((await gateway.gateway.listDirectories('ghost', '/')).ok, false);
  // 新建文件夹走同一条通道：在 roots 里能建，roots 外和带斜杠的名字都拒
  const made = await gateway.gateway.makeDirectory('w1', root, 'fresh');
  assert.deepEqual(made, { ok: true, value: { path: join(root, 'fresh') } });
  const escaped = await gateway.gateway.makeDirectory('w1', base, 'evil');
  assert.ok(!escaped.ok && /不在允许/.test(escaped.error.message));
  const nested = await gateway.gateway.makeDirectory('w1', root, 'a/b');
  assert.ok(!nested.ok && /斜杠/.test(nested.error.message));
  await stop(link);
  await rm(base, { recursive: true, force: true });
});

test('文件走 worker：@ 清单、附件落盘与回读都在那台机器上；软链接逃不出 roots', async () => {
  const { rec, gateway, url, stop } = await harness(null);
  const base = await mkdtemp(join(tmpdir(), 'wf-'));
  const root = join(base, 'proj');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), 'hi');
  await writeFile(join(root, 'src', 'a.ts'), 'x');
  await writeFile(join(base, 'secret.txt'), 'no');
  await symlink(join(base, 'secret.txt'), join(root, 'leak.txt'));
  const link = connectWorkerLink({
    url,
    token: '',
    workerId: 'w1',
    label: 'x',
    runtimes: [echoRuntime([])],
    files: createWorkerFiles({ roots: [root], enforced: true })
  });
  await rec.until(() => rec.hellos.length === 1);
  const listed = await gateway.gateway.listFiles('w1', root, 100);
  assert.ok(listed.ok);
  assert.ok(listed.value.files.includes('README.md') && listed.value.files.includes('src/a.ts'));
  assert.equal((await gateway.gateway.listFiles('w1', base, 100)).ok, false);
  const leak = await gateway.gateway.readFile('w1', join(root, 'leak.txt'), 1000);
  assert.ok(!leak.ok, '软链接指向 roots 外');

  // 附件：随 prompt 发到 worker，worker 先落盘再交给 agent
  assert.ok((await gateway.gateway.dispatch({ ...start('s1', 'w1'), workspaceRoot: root })).ok);
  await rec.until(() => rec.statuses.includes('running'));
  const attachment = join(root, '.agent-hub', 'attachments', 's1', '1-0-note.txt');
  await gateway.gateway.dispatch({
    kind: 'prompt', sessionId: asSessionId('s1'), text: 'hi',
    parts: [{ kind: 'file', name: 'note.txt', mimeType: 'text/plain', data: Buffer.from('hello').toString('base64'), path: attachment }]
  });
  await waitFor(async () => (await readFile(attachment, 'utf8').catch(() => '')) === 'hello');
  const back = await gateway.gateway.readFile('w1', attachment, 1000);
  assert.ok(back.ok && back.value !== null && Buffer.from(back.value).toString() === 'hello');
  const tooBig = await gateway.gateway.readFile('w1', attachment, 2);
  assert.ok(!tooBig.ok);
  const gone = await gateway.gateway.readFile('w1', join(root, 'none.txt'), 1000);
  assert.deepEqual(gone, { ok: true, value: null });
  await stop(link);
  await rm(base, { recursive: true, force: true });
});

test('roots 外的目录不能开会话：worker 直接以失败结束并说明原因', async () => {
  const { rec, gateway, url, stop } = await harness(null);
  const base = await mkdtemp(join(tmpdir(), 'wf-'));
  const link = connectWorkerLink({
    url, token: '', workerId: 'w1', label: 'x', runtimes: [echoRuntime([])],
    files: createWorkerFiles({ roots: [join(base, 'only')], enforced: true })
  });
  await rec.until(() => rec.hellos.length === 1);
  await gateway.gateway.dispatch({ ...start('s2', 'w1'), workspaceRoot: '/etc' });
  await rec.until(() => rec.events.some((event) => event.kind === 'ended'));
  const ended = rec.events.find((event) => event.kind === 'ended');
  assert.ok(ended?.kind === 'ended' && /WORKER_ROOTS/.test(ended.reason ?? ''));
  await stop(link);
  await rm(base, { recursive: true, force: true });
});

test('还没托管的会话：dispatch 返回 unavailable 而不是抛错或乱发', async () => {
  const { gateway, stop } = await harness(null);
  const result = await gateway.gateway.dispatch({ kind: 'interrupt', sessionId: asSessionId('s') });
  assert.equal(result.ok, false);
  await stop();
});

/** 直接用裸 WebSocket 说 hello，等它被接受或被关掉。 */
async function rawHello(url: string, hello: Record<string, unknown>): Promise<{ socket: WebSocket; closed: Promise<number> }> {
  const socket = new WebSocket(url);
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(JSON.stringify({ type: 'hello', label: 'x', agents: [], ...hello }));
  return { socket, closed };
}

test('本机身份要凭口令：自称 local 答不上口令按 remote；在线的本机 id 不能被别人顶掉', async () => {
  const rec = recorder(null);
  const gateway = createServerGateway({ ...rec.hooks, localSecret: 's3cret' });
  const server: Server = createServer();
  server.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const real = await rawHello(url, { workerId: 'local-1', origin: 'local', localSecret: 's3cret' });
  await rec.until(() => rec.hellos.length === 1);
  assert.equal(rec.hellos[0]?.worker.origin, 'local');

  const spoof = await rawHello(url, { workerId: 'other', origin: 'local' });
  await rec.until(() => rec.hellos.length === 2);
  assert.equal(rec.hellos[1]?.worker.origin, 'remote');

  const hijack = await rawHello(url, { workerId: 'local-1', origin: 'local', localSecret: 'guess' });
  assert.equal(await hijack.closed, 4409);
  assert.equal(gateway.workers().find((w) => w.workerId === 'local-1')?.state, 'online');

  // 真本机重连（新连接先于旧 close 到达）照样能顶掉旧连接
  const again = await rawHello(url, { workerId: 'local-1', origin: 'local', localSecret: 's3cret' });
  await rec.until(() => rec.hellos.length === 3);
  assert.equal(await real.closed, 1006);

  for (const s of [spoof.socket, again.socket]) s.terminate();
  gateway.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test('路由只由 start / adopt 建立：别的 Worker 报 running 改不了道，帧带着发送方', async () => {
  const { rec, gateway, url, stop } = await harness(null);
  const seen: string[] = [];
  const a = await rawHello(url, { workerId: 'a', origin: 'remote' });
  const b = await rawHello(url, { workerId: 'b', origin: 'remote' });
  await rec.until(() => rec.hellos.length === 2);
  const commands: string[] = [];
  a.socket.on('message', (raw) => commands.push(`a:${JSON.parse(raw.toString()).kind}`));
  b.socket.on('message', (raw) => commands.push(`b:${JSON.parse(raw.toString()).kind}`));
  assert.ok((await gateway.gateway.dispatch(start('s1', 'a'))).ok);
  rec.hooks.onStatus = (worker, id, status) => seen.push(`${worker}:${id}:${status}`);
  b.socket.send(JSON.stringify({ type: 'status', sessionId: 's1', status: 'running' }));
  await rec.until(() => seen.length === 1);
  assert.equal(seen[0], 'b:s1:running');
  // b 也不能报「结束」把 a 的路由划掉
  b.socket.send(JSON.stringify({ type: 'status', sessionId: 's1', status: 'ended' }));
  await rec.until(() => seen.length === 2);
  assert.ok((await gateway.gateway.dispatch({ kind: 'interrupt', sessionId: asSessionId('s1') })).ok);
  await rec.until(() => commands.includes('a:interrupt'));
  assert.ok(!commands.some((c) => c.startsWith('b:')));
  a.socket.terminate();
  b.socket.terminate();
  await stop();
});

test('连上不说 hello 的连接会被关掉', async () => {
  const { url, stop } = await harness(null, { helloTimeoutMs: 50 });
  const socket = new WebSocket(url);
  const code = await new Promise<number>((resolve) => socket.once('close', (c) => resolve(c)));
  assert.equal(code, 4408);
  await stop();
});

test('同一会话重复 start：旧 agent 被收掉，旧的结束不会把新会话报成 ended', async () => {
  const { rec, gateway, url, stop } = await harness(null);
  const disposed: string[] = [];
  const all = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, available])) as Record<CapabilityName, Capability>;
  let generation = 0;
  const runtime: AgentRuntime = {
    descriptor: { id: asAgentId('echo'), label: 'Echo', capabilities: capabilityMatrix(all), models: [], defaultModel: '', options: [] },
    async start(spec) {
      const name = `g${++generation}`;
      const queue = new AsyncQueue<SessionEvent>();
      return {
        ok: true,
        value: {
          sessionId: spec.sessionId,
          async prompt({ text }) {
            queue.push({ kind: 'text', delta: `${name}:${text}` });
            return { ok: true, value: undefined };
          },
          async interrupt() {},
          events: () => queue,
          async adopt() {},
          options: () => [],
          async changeOption() {
            return { ok: true, value: [] };
          },
          async dispose() {
            disposed.push(name);
            queue.close(); // 旧 agent 的事件流随之结束，走到 finally
          }
        }
      };
    }
  };
  const link = connectWorkerLink({ url, token: '', workerId: 'w1', label: 'x', runtimes: [runtime] });
  await rec.until(() => rec.hellos.length === 1);

  await gateway.gateway.dispatch(start('s1', 'w1'));
  await rec.until(() => rec.statuses.length === 1);
  await gateway.gateway.dispatch(start('s1', 'w1'));
  await rec.until(() => rec.statuses.length === 2);
  await gateway.gateway.dispatch({ kind: 'prompt', parts: [], sessionId: asSessionId('s1'), text: '在吗' });
  await rec.until(() => rec.events.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(disposed, ['g1']);
  assert.deepEqual(rec.statuses, ['running', 'running']);
  assert.deepEqual(rec.events, [{ kind: 'text', delta: 'g2:在吗' }]);
  await stop(link);
});
