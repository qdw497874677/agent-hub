import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import {
  createPreviewChannel,
  PreviewStreamError,
  type PreviewChannel,
  type PreviewChannelOptions,
  type PreviewStream
} from './preview-channel.ts';

/** 一条帧的宽松形状（测试里只关心字段，不重复 zod 校验）。 */
type Frame = { readonly kind: string; readonly streamId: string } & Record<string, unknown>;

class WorkerClient {
  readonly socket: WebSocket;
  readonly frames: Frame[] = [];

  constructor(url: string, workerId: string) {
    this.socket = new WebSocket(url, { headers: { authorization: `Bearer ahw_${workerId}` } });
    this.socket.on('message', (raw) => {
      this.frames.push(JSON.parse(String(raw)) as Frame);
    });
  }

  async ready(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await once(this.socket, 'open');
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  async take(predicate: (frame: Frame) => boolean, timeoutMs = 2000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.frames.findIndex(predicate);
      if (index >= 0) return this.frames.splice(index, 1)[0]!;
      if (Date.now() > deadline) throw new Error(`等待帧超时，已有：${JSON.stringify(this.frames)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function until<T>(check: () => T | false | null | undefined, what: string, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待${what}超时`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Harness {
  readonly channel: PreviewChannel;
  readonly port: number;
  readonly logs: string[];
  readonly events: string[];
  readonly clients: WorkerClient[];
  connect(workerId?: string): Promise<WorkerClient>;
  close(): Promise<void>;
}

async function harness(overrides: Partial<PreviewChannelOptions> = {}): Promise<Harness> {
  const logs: string[] = [];
  const events: string[] = [];
  const clients: WorkerClient[] = [];
  let channel: PreviewChannel | null = null;

  const server: Server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on('upgrade', (request, socket, head) => {
    if (channel) channel.handleUpgrade(request, socket, head);
    else socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  channel = createPreviewChannel({
    verifyWorker: async (request) => {
      const auth = request.headers.authorization ?? '';
      return auth.startsWith('Bearer ahw_') ? { workerId: auth.slice('Bearer ahw_'.length) } : null;
    },
    onWorkerUp: (workerId) => events.push(`up:${workerId}`),
    onWorkerDown: (workerId) => events.push(`down:${workerId}`),
    onLog: (message) => logs.push(message),
    ...overrides
  });

  return {
    channel,
    port,
    logs,
    events,
    clients,
    async connect(workerId = 'w1'): Promise<WorkerClient> {
      const client = new WorkerClient(`ws://127.0.0.1:${port}/preview`, workerId);
      clients.push(client);
      await client.ready();
      await until(() => channel!.hasWorker(workerId), `机器 ${workerId} 上线`);
      return client;
    },
    async close(): Promise<void> {
      channel?.close();
      for (const client of clients) client.socket.terminate();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

test('open → head → data → end：顺序、ack 与请求体', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const worker = await h.connect('w1');

  const opened = h.channel.open('w1', {
    port: 3000,
    method: 'GET',
    path: '/index.html?x=1',
    headers: [['accept', 'text/plain']]
  });
  const openFrame = await worker.take((frame) => frame.kind === 'preview_open');
  assert.equal(openFrame.port, 3000);
  assert.equal(openFrame.method, 'GET');
  assert.equal(openFrame.path, '/index.html?x=1');
  assert.deepEqual(openFrame.headers, [['accept', 'text/plain']]);
  assert.equal(openFrame.upgrade, undefined);
  const streamId = openFrame.streamId;
  assert.match(streamId, /^[0-9a-f]{16}$/);

  worker.send({
    kind: 'preview_head',
    streamId,
    status: 200,
    statusText: 'OK',
    headers: [['content-type', 'text/plain']]
  });
  const stream = await opened;
  assert.equal(stream.streamId, streamId);

  // head 可能先到也可能后到：onHead 注册时已缓存就立即回调。
  let headStatus = 0;
  stream.onHead((head) => {
    headStatus = head.status;
  });
  await until(() => headStatus === 200, 'head');
  assert.equal(headStatus, 200);

  const chunks: Buffer[] = [];
  let ended = false;
  stream.onData((chunk) => {
    chunks.push(chunk);
  });
  stream.onEnd(() => {
    ended = true;
  });

  worker.send({ kind: 'preview_data', streamId, data: Buffer.from('hello').toString('base64') });
  await until(() => chunks.length === 1, '响应体');
  assert.equal(chunks[0]!.toString('utf8'), 'hello');

  const ack = await worker.take((frame) => frame.kind === 'preview_ack' && frame.streamId === streamId);
  assert.equal(ack.credits, 8);

  stream.write(Buffer.from('body'));
  const body = await worker.take((frame) => frame.kind === 'preview_body' && frame.streamId === streamId);
  assert.equal(Buffer.from(String(body.data), 'base64').toString('utf8'), 'body');
  assert.equal(body.end, false);

  stream.endBody();
  const endBody = await worker.take((frame) => frame.kind === 'preview_body' && frame.streamId === streamId);
  assert.equal(endBody.data, '');
  assert.equal(endBody.end, true);

  worker.send({ kind: 'preview_end', streamId });
  await until(() => ended, '流结束');
  assert.equal(h.channel.streamCount('w1'), 0);
});

test('POST：body 在 head 之前就推给 worker（不会互等）', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const worker = await h.connect('w1');

  const stream = await h.channel.open('w1', {
    port: 3000,
    method: 'POST',
    path: '/submit',
    headers: [['content-type', 'application/json']]
  });
  stream.write(Buffer.from('{"a":1}'));
  stream.endBody();

  const openFrame = await worker.take((frame) => frame.kind === 'preview_open');
  const body = await worker.take((frame) => frame.kind === 'preview_body');
  assert.equal(Buffer.from(String(body.data), 'base64').toString('utf8'), '{"a":1}');
  assert.equal(body.end, false);
  const end = await worker.take((frame) => frame.kind === 'preview_body');
  assert.equal(end.data, '');
  assert.equal(end.end, true);

  let status = 0;
  stream.onHead((head) => {
    status = head.status;
  });
  worker.send({ kind: 'preview_head', streamId: openFrame.streamId, status: 201, statusText: 'Created', headers: [] });
  await until(() => status === 201, 'head 到达');
});

test('head 超时：流收 504 + preview_close，open 不阻塞', async (t) => {
  const h = await harness({ headerTimeoutMs: 50 });
  t.after(() => h.close());
  const worker = await h.connect('w1');

  // open 立刻返回，不等 head。
  const stream = await h.channel.open('w1', { port: 3000, method: 'GET', path: '/', headers: [] });
  const errors: PreviewStreamError[] = [];
  let ended = false;
  stream.onError((error) => errors.push(error));
  stream.onEnd(() => {
    ended = true;
  });

  const openFrame = await worker.take((frame) => frame.kind === 'preview_open');
  await until(() => errors.length === 1, '504');
  assert.equal(errors[0]!.status, 504);
  assert.equal(errors[0]!.code, 'timeout');
  assert.equal(ended, true);

  const close = await worker.take((frame) => frame.kind === 'preview_close');
  assert.equal(close.streamId, openFrame.streamId);
  assert.equal(h.channel.streamCount('w1'), 0);
});

test('worker 断开：所有流（含还没 head 的）error 502 + end，并回调 onWorkerDown', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const worker = await h.connect('w1');

  const pending = await h.channel.open('w1', { port: 3000, method: 'GET', path: '/', headers: [] });
  const pendingErrors: PreviewStreamError[] = [];
  let pendingEnded = false;
  pending.onError((error) => pendingErrors.push(error));
  pending.onEnd(() => {
    pendingEnded = true;
  });
  await worker.take((frame) => frame.kind === 'preview_open');

  const established = await h.channel.open('w1', { port: 3000, method: 'GET', path: '/second', headers: [] });
  const establishedFrame = await worker.take((frame) => frame.kind === 'preview_open' && frame.streamId !== pending.streamId);
  worker.send({
    kind: 'preview_head',
    streamId: establishedFrame.streamId,
    status: 200,
    statusText: 'OK',
    headers: []
  });
  const errors: PreviewStreamError[] = [];
  let ended = false;
  established.onError((error) => errors.push(error));
  established.onEnd(() => {
    ended = true;
  });

  worker.socket.terminate();
  await until(() => pendingErrors.length === 1, '未回头的流失败');
  assert.equal(pendingErrors[0]!.status, 502);
  assert.equal(pendingEnded, true);
  await until(() => ended, '已建流结束');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.status, 502);
  await until(() => h.events.includes('down:w1'), 'onWorkerDown');
});

test('同一 worker 重连：旧连接被关，旧流全部变 502', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const first = await h.connect('w1');

  const opened = h.channel.open('w1', { port: 3000, method: 'GET', path: '/', headers: [] });
  const openFrame = await first.take((frame) => frame.kind === 'preview_open');
  first.send({
    kind: 'preview_head',
    streamId: openFrame.streamId,
    status: 200,
    statusText: 'OK',
    headers: []
  });
  const stream = await opened;
  const errors: PreviewStreamError[] = [];
  stream.onError((error) => errors.push(error));

  const closed = once(first.socket, 'close');
  const second = await h.connect('w1');
  const [code] = (await closed) as [number, string];
  assert.equal(code, 1001);

  await until(() => errors.length === 1, '旧流失败');
  assert.equal(errors[0]!.status, 502);
  assert.equal(h.channel.hasWorker('w1'), true);

  // 新连接正常可用。
  const reopened = h.channel.open('w1', { port: 3001, method: 'GET', path: '/', headers: [] });
  const frame = await second.take((frame) => frame.kind === 'preview_open');
  second.send({ kind: 'preview_head', streamId: frame.streamId, status: 204, statusText: 'No Content', headers: [] });
  const next = await reopened;
  assert.equal(next.streamId, frame.streamId);
});

test('每 worker 并发流上限 32：第 33 条回 429', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const worker = await h.connect('w1');

  const streams: PreviewStream[] = [];
  for (let index = 0; index < 32; index += 1) {
    const opened = h.channel.open('w1', { port: 3000 + index, method: 'GET', path: '/', headers: [] });
    const frame = await worker.take((item) => item.kind === 'preview_open');
    worker.send({ kind: 'preview_head', streamId: frame.streamId, status: 200, statusText: 'OK', headers: [] });
    streams.push(await opened);
  }
  assert.equal(h.channel.streamCount('w1'), 32);

  await assert.rejects(
    h.channel.open('w1', { port: 4000, method: 'GET', path: '/', headers: [] }),
    (error: unknown) => error instanceof PreviewStreamError && error.status === 429
  );

  // 收掉一条之后又能开。
  streams[0]!.close();
  const reopened = h.channel.open('w1', { port: 4000, method: 'GET', path: '/', headers: [] });
  const frame = await worker.take((item) => item.kind === 'preview_open');
  worker.send({ kind: 'preview_head', streamId: frame.streamId, status: 200, statusText: 'OK', headers: [] });
  await reopened;
});

test('非 JSON / 未知流 / 不符合协议的帧都忽略，不影响正常帧', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const worker = await h.connect('w1');

  const opened = h.channel.open('w1', { port: 3000, method: 'GET', path: '/', headers: [] });
  const frame = await worker.take((item) => item.kind === 'preview_open');

  worker.socket.send('这不是 JSON');
  worker.send({ kind: 'preview_nope', streamId: frame.streamId });
  worker.send({ kind: 'preview_data', streamId: 'ffffffffffffffff', data: 'aGk=' });

  // 未知流的合法帧：只记 log，不会把 open 打掉。
  worker.send({
    kind: 'preview_head',
    streamId: frame.streamId,
    status: 200,
    statusText: 'OK',
    headers: []
  });
  const stream = await opened;
  assert.ok(stream);

  await until(() => h.logs.some((line) => line.includes('非 JSON')), '非 JSON 日志');
  await until(() => h.logs.some((line) => line.includes('未知流')), '未知流日志');
});
