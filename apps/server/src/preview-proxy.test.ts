import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { WebSocket } from 'ws';
import type { PreviewLink, PreviewLinkId, SessionId } from '@agent-hub/domain';
import {
  PreviewStreamError,
  type PreviewChannel,
  type PreviewHead,
  type PreviewOpenRequest,
  type PreviewStream
} from './preview-channel.ts';
import { PREVIEW_DOWN_TEXT, createPreviewProxy, type PreviewProxy, type PreviewProxyOptions } from './preview-proxy.ts';

class FakeStream implements PreviewStream {
  readonly streamId: string;
  private head: PreviewHead | null = null;
  private readonly headCallbacks: Array<(head: PreviewHead) => void> = [];
  private readonly dataCallbacks: Array<(chunk: Buffer) => boolean | void> = [];
  private readonly endCallbacks: Array<() => void> = [];
  private readonly errorCallbacks: Array<(error: PreviewStreamError) => void> = [];
  private readonly pendingChunks: Buffer[] = [];
  private endPending = false;
  private errorPending: PreviewStreamError | null = null;
  readonly written: Array<{ data: string; end: boolean }> = [];
  readonly acks: number[] = [];
  bodyEnded = false;
  closed = false;
  /** 测试用：worker 收到 hub 写入的字节时回调（WS 回显隧道）。 */
  onWrite: ((chunk: Buffer, end: boolean) => void) | null = null;

  constructor(streamId: string) {
    this.streamId = streamId;
  }

  onHead(callback: (head: PreviewHead) => void): void {
    this.headCallbacks.push(callback);
    if (this.head !== null) callback(this.head);
  }

  onData(callback: (chunk: Buffer) => boolean | void): void {
    this.dataCallbacks.push(callback);
    while (this.pendingChunks.length > 0) callback(this.pendingChunks.shift()!);
  }

  onEnd(callback: () => void): void {
    this.endCallbacks.push(callback);
    if (this.endPending) {
      this.endPending = false;
      callback();
    }
  }

  onError(callback: (error: PreviewStreamError) => void): void {
    this.errorCallbacks.push(callback);
    if (this.errorPending !== null) {
      const error = this.errorPending;
      this.errorPending = null;
      callback(error);
    }
  }

  write(chunk: Buffer | Uint8Array | string, end = false): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    this.written.push({ data: buffer.toString('utf8'), end });
    this.onWrite?.(buffer, end);
  }

  endBody(): void {
    this.bodyEnded = true;
  }

  ack(credits: number): void {
    this.acks.push(credits);
  }

  close(): void {
    this.closed = true;
  }

  emitHead(head: PreviewHead): void {
    this.head = head;
    for (const callback of this.headCallbacks) callback(head);
  }

  emitData(chunk: string | Buffer): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (this.dataCallbacks.length === 0) {
      this.pendingChunks.push(buffer);
      return;
    }
    for (const callback of this.dataCallbacks) callback(buffer);
  }

  emitEnd(): void {
    if (this.endCallbacks.length === 0) {
      this.endPending = true;
      return;
    }
    for (const callback of this.endCallbacks) callback();
  }

  emitError(error: PreviewStreamError): void {
    if (this.errorCallbacks.length === 0) {
      this.errorPending = error;
      return;
    }
    for (const callback of this.errorCallbacks) callback(error);
  }
}

interface OpenCall {
  readonly workerId: string;
  readonly request: PreviewOpenRequest;
  readonly stream: FakeStream;
}

class FakeChannel implements PreviewChannel {
  readonly calls: OpenCall[] = [];
  readonly streams: FakeStream[] = [];
  onOpen: ((stream: FakeStream, request: PreviewOpenRequest) => void) | null = null;
  failure: PreviewStreamError | null = null;
  private counter = 0;

  handleUpgrade(): void {
    throw new Error('假通道没有 WS 入口');
  }

  async open(workerId: string, request: PreviewOpenRequest): Promise<PreviewStream> {
    if (this.failure !== null) throw this.failure;
    this.counter += 1;
    const stream = new FakeStream(this.counter.toString(16).padStart(16, '0'));
    this.calls.push({ workerId, request, stream });
    this.streams.push(stream);
    this.onOpen?.(stream, request);
    return stream;
  }

  hasWorker(): boolean {
    return true;
  }

  streamCount(): number {
    return this.streams.length;
  }

  close(): void {}
}

function makeLink(hubPort: number, port = 3000): PreviewLink {
  return {
    id: 'pv_00000001' as PreviewLinkId,
    sessionId: 'sess-1' as SessionId,
    workerId: 'w1',
    port,
    hubPort,
    label: 'Vite',
    source: 'manual',
    state: 'ready',
    createdAt: 0,
    lastSeenAt: 0
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Setup {
  readonly fake: FakeChannel;
  readonly proxy: PreviewProxy;
  readonly link: PreviewLink;
  readonly port: number;
  readonly logs: string[];
}

async function setup(t: TestContext, overrides: Partial<PreviewProxyOptions> = {}): Promise<Setup> {
  const fake = new FakeChannel();
  const port = await freePort();
  const link = makeLink(port);
  const logs: string[] = [];
  const proxy = createPreviewProxy({
    resolve: async (hubPort) => (hubPort === link.hubPort ? link : null),
    authorize: async () => true,
    channel: fake,
    onLog: (message) => logs.push(message),
    ...overrides
  });
  t.after(async () => {
    await proxy.close();
  });
  await proxy.listen(link);
  return { fake, proxy, link, port, logs };
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

/** 造一条服务端发往浏览器的文本帧（FIN + opcode 1，未掩码），给假 worker 用。 */
function unmaskedTextFrame(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([0x81, body.length & 0x7f]), body]);
}

interface SimpleResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
        agent: false
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

test('GET 正常：改 Host、补 x-forwarded-*、删逐跳头、剥 x-frame-options', async (t) => {
  const { fake, port } = await setup(t);
  fake.onOpen = (stream) => {
    stream.emitHead({
      status: 200,
      statusText: 'OK',
      headers: [
        ['content-type', 'text/plain'],
        ['x-frame-options', 'DENY']
      ]
    });
    stream.emitData('hello');
    stream.emitEnd();
  };

  const response = await request(port, '/index.html?x=1', {
    headers: { accept: 'text/plain', cookie: 'hub_login=abc', connection: 'keep-alive' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, 'hello');
  assert.equal(response.headers['x-frame-options'], undefined);
  assert.equal(response.headers['content-type'], 'text/plain');

  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0]!;
  assert.equal(call.workerId, 'w1');
  assert.equal(call.request.port, 3000);
  assert.equal(call.request.method, 'GET');
  assert.equal(call.request.path, '/index.html?x=1');
  assert.equal(call.request.upgrade, undefined);

  const forwarded = new Map(call.request.headers.map(([name, value]) => [name.toLowerCase(), value]));
  assert.equal(forwarded.get('host'), '127.0.0.1:3000');
  assert.equal(forwarded.get('x-forwarded-proto'), 'http');
  assert.match(forwarded.get('x-forwarded-for') ?? '', /127\.0\.0\.1/);
  assert.equal(forwarded.get('cookie'), 'hub_login=abc');
  assert.equal(forwarded.get('connection'), undefined);
  assert.equal(forwarded.get('keep-alive'), undefined);

  // 无请求体时也要告诉 worker「body 结束了」。
  assert.equal(fake.streams[0]!.bodyEnded, true);
});

test('上游 404 原样透传', async (t) => {
  const { fake, port } = await setup(t);
  fake.onOpen = (stream) => {
    stream.emitHead({
      status: 404,
      statusText: 'Not Found',
      headers: [['content-type', 'text/plain']]
    });
    stream.emitData('nope');
    stream.emitEnd();
  };

  const response = await request(port, '/missing');
  assert.equal(response.status, 404);
  assert.equal(response.body, 'nope');
});

test('CSP 里的 frame-ancestors 被剥掉，其余指令保留', async (t) => {
  const { fake, port } = await setup(t);
  fake.onOpen = (stream) => {
    stream.emitHead({
      status: 200,
      statusText: 'OK',
      headers: [
        ['content-type', 'text/html'],
        ['content-security-policy', "default-src 'self'; frame-ancestors 'none'; script-src 'self'"]
      ]
    });
    stream.emitEnd();
  };

  const response = await request(port, '/');
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-security-policy'], "default-src 'self'; script-src 'self'");
  // HTML 默认不被缓存（不然预览会一直看到旧页面）。
  assert.equal(response.headers['cache-control'], 'no-cache');
});

test('未登录：非回环请求 302 到登录页并带上原地址', async (t) => {
  const { port } = await setup(t, {
    isLoopback: () => false,
    authorize: async () => false
  });

  const response = await request(port, '/private');
  assert.equal(response.status, 302);
  const location = String(response.headers.location ?? '');
  assert.ok(location.startsWith('/login?next='), location);
  assert.equal(
    decodeURIComponent(location.slice('/login?next='.length)),
    `http://127.0.0.1:${port}/private`
  );
});

test('上游起不来：502 中文文案；超时 504', async (t) => {
  const { fake, port } = await setup(t);
  fake.failure = new PreviewStreamError(502, '机器不在线');

  const down = await request(port, '/');
  assert.equal(down.status, 502);
  assert.equal(down.body, PREVIEW_DOWN_TEXT);
  assert.equal(down.headers['content-type'], 'text/plain; charset=utf-8');

  fake.failure = new PreviewStreamError(504, '等 head 超时');
  const timeout = await request(port, '/');
  assert.equal(timeout.status, 504);
  assert.match(timeout.body, /预览超时/);
});

test('POST：请求体在 head 之前推给 worker，head 到了才回响应', async (t) => {
  const { fake, port } = await setup(t);
  fake.onOpen = () => {};

  const pending = request(port, '/submit', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'content-length': '5' },
    body: 'hello'
  });

  const stream = await until(() => fake.streams[0], '预览流建立');
  await until(() => stream.bodyEnded, '请求体推完');
  assert.equal(stream.written.map((item) => item.data).join(''), 'hello');
  assert.equal(stream.acks.length, 0);

  stream.emitHead({ status: 200, statusText: 'OK', headers: [['content-type', 'text/plain']] });
  stream.emitData('ok');
  stream.emitEnd();

  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.body, 'ok');
});

test('上游一直不回 head：proxy 侧超时 → 504 页并关流', async (t) => {
  const { fake, port } = await setup(t, { headerTimeoutMs: 50 });
  // 不注册 onOpen：worker 一直不回 preview_head。
  const response = await request(port, '/');
  assert.equal(response.status, 504);
  assert.match(response.body, /预览超时/);
  assert.equal(fake.streams[0]!.closed, true);
});

test('HEAD：头照发，不下发 body', async (t) => {
  const { fake, port } = await setup(t);
  fake.onOpen = (stream) => {
    stream.emitHead({
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'text/plain'], ['content-length', '5']]
    });
    stream.emitData('hello');
    stream.emitEnd();
  };

  const response = await request(port, '/', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-length'], '5');
  assert.equal(response.body, '');
  assert.equal(fake.streams[0]!.closed, true);
});

test('WS upgrade：101 原样回写，双向桥接', async (t) => {
  const { fake, port } = await setup(t);
  fake.onOpen = (stream, openRequest) => {
    const key = openRequest.headers.find(([name]) => name.toLowerCase() === 'sec-websocket-key')?.[1] ?? '';
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    // 假 worker 不会解析帧：收到浏览器数据就回一条合法的（未掩码）文本帧。
    stream.onWrite = () => stream.emitData(unmaskedTextFrame('pong'));
    stream.emitHead({
      status: 101,
      statusText: 'Switching Protocols',
      headers: [
        ['upgrade', 'websocket'],
        ['connection', 'Upgrade'],
        ['sec-websocket-accept', accept]
      ]
    });
  };

  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
  t.after(() => socket.terminate());
  await once(socket, 'open');

  const call = fake.calls[0]!;
  assert.deepEqual(call.request.upgrade, { protocol: null });
  const forwarded = new Map(call.request.headers.map(([name, value]) => [name.toLowerCase(), value]));
  assert.equal(forwarded.get('upgrade'), 'websocket');
  assert.equal(forwarded.get('sec-websocket-extensions'), undefined);

  socket.send('ping');
  const [message] = (await once(socket, 'message')) as [Buffer];
  assert.equal(String(message), 'pong');
  // 浏览器 → worker 的原始帧确实被转发下去了（浏览器发的帧是掩码的，这里只看条数）。
  assert.equal(fake.streams[0]!.written.length, 1);
  assert.equal(fake.streams[0]!.written[0]!.end, false);
});

test('端口被占：EADDRINUSE 走 onConflict，不抛', async (t) => {
  const port = await freePort();
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

  const link = makeLink(port);
  const conflicts: string[] = [];
  const proxy = createPreviewProxy({
    resolve: async () => link,
    authorize: async () => true,
    channel: new FakeChannel(),
    onConflict: (linkId) => conflicts.push(linkId)
  });
  t.after(async () => {
    await proxy.close();
  });

  await proxy.listen(link);
  assert.deepEqual(conflicts, [link.id]);
  assert.deepEqual(proxy.listening(), []);
});
