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
import { PREVIEW_DOWN_TEXT, createPreviewProxy, type PreviewDestination, type PreviewProxy, type PreviewProxyOptions } from './preview-proxy.ts';

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

test('minimal destinations forward listener identity on HTTP and WebSocket', async (t) => {
  const fake = new FakeChannel();
  const port = await freePort();
  const link: PreviewDestination = { id: 'app-a', workerId: 'w1', port: 3000, hubPort: port, listenerIdentity: 'listener-a' };
  const proxy = createPreviewProxy<PreviewDestination>({ resolve: async () => link, authorize: async () => true, channel: fake });
  t.after(() => proxy.close());
  await proxy.listen(link);
  fake.onOpen = (stream, opened) => {
    if (!opened.upgrade) {
      stream.emitHead({ status: 200, statusText: 'OK', headers: [] });
      stream.emitEnd();
      return;
    }
    const key = opened.headers.find(([name]) => name.toLowerCase() === 'sec-websocket-key')?.[1] ?? '';
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    stream.emitHead({ status: 101, statusText: 'Switching Protocols', headers: [['sec-websocket-accept', accept]] });
  };
  assert.equal((await request(port, '/')).status, 200);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
  t.after(() => socket.terminate());
  await once(socket, 'open');
  assert.deepEqual(fake.calls.map((call) => call.request.listenerIdentity), ['listener-a', 'listener-a']);
});

test('bound listener rejects a different resolved id for HTTP and WebSocket', async (t) => {
  const fake = new FakeChannel();
  const port = await freePort();
  const bound: PreviewDestination = { id: 'app-a', workerId: 'w1', port: 3000, hubPort: port };
  let beforeCalled = false;
  const proxy = createPreviewProxy<PreviewDestination>({
    resolve: async () => ({ ...bound, id: 'app-b' }), authorize: async () => true, channel: fake,
    beforeAuthorize: () => { beforeCalled = true; }
  });
  t.after(() => proxy.close());
  await proxy.listen(bound);
  assert.equal((await request(port, '/')).status, 404);
  const status = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`);
    ws.on('unexpected-response', (_request, response) => { resolve(response.statusCode ?? 0); response.resume(); });
    ws.on('error', reject);
  });
  assert.equal(status, 404);
  assert.equal(fake.calls.length, 0);
  assert.equal(beforeCalled, false);
});

test('beforeAuthorize can complete HTTP response without authorizing or opening', async (t) => {
  let authorized = false;
  const { fake, port } = await setup(t, {
    beforeAuthorize: (_request, response) => { response.writeHead(302, { location: '/' }); response.end(); },
    authorize: async () => { authorized = true; return true; }
  });
  const response = await request(port, '/launch');
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/');
  assert.equal(authorized, false);
  assert.equal(fake.calls.length, 0);
});

test('a lookup pending when its listener closes cannot open a stream', async (t) => {
  const fake = new FakeChannel();
  const port = await freePort();
  const link: PreviewDestination = { id: 'app-a', workerId: 'w1', port: 3000, hubPort: port };
  let release!: (link: PreviewDestination) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const lookup = new Promise<PreviewDestination>((resolve) => { release = resolve; });
  const proxy = createPreviewProxy<PreviewDestination>({
    resolve: async () => { entered(); return lookup; }, authorize: async () => true, channel: fake
  });
  t.after(() => proxy.close());
  await proxy.listen(link);
  const pending = request(port, '/').catch(() => null);
  await started;
  await proxy.unlisten(link.id);
  release(link);
  await pending;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.length, 0);
});

test('exclusivePorts preserves the first listener and reports collision', async (t) => {
  const fake = new FakeChannel();
  const port = await freePort();
  const link: PreviewDestination = { id: 'app-a', workerId: 'w1', port: 3000, hubPort: port };
  const conflicts: string[] = [];
  const proxy = createPreviewProxy<PreviewDestination>({
    resolve: async () => link, authorize: async () => true, channel: fake,
    exclusivePorts: true, onConflict: (id) => conflicts.push(id)
  });
  t.after(() => proxy.close());
  await proxy.listen(link);
  await proxy.listen({ ...link, id: 'app-b' });
  assert.deepEqual(conflicts, ['app-b']);
  assert.deepEqual(proxy.listening(), [{ linkId: 'app-a', hubPort: port }]);
});

test('exclusivePorts strips CORS and proxy request headers and denies framing', async (t) => {
  const fake = new FakeChannel();
  const port = await freePort();
  const link: PreviewDestination = { id: 'app-a', workerId: 'w1', port: 3000, hubPort: port };
  const proxy = createPreviewProxy<PreviewDestination>({
    resolve: async () => link, authorize: async () => true, channel: fake, exclusivePorts: true
  });
  t.after(() => proxy.close());
  await proxy.listen(link);
  fake.onOpen = (stream) => {
    stream.emitHead({ status: 200, statusText: 'OK', headers: [
      ['access-control-allow-origin', '*'], ['access-control-allow-credentials', 'true'],
      ['content-security-policy', "default-src 'self'; frame-ancestors *"]
    ] });
    stream.emitEnd();
  };
  const response = await request(port, '/', { headers: { 'proxy-custom': 'private' } });
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
  assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.match(String(response.headers['content-security-policy']), /default-src 'self'/);
  assert.equal(fake.calls[0]!.request.headers.some(([name]) => name.startsWith('proxy-')), false);
});

test('exclusivePorts denies service worker scripts and disables upstream caching', async (t) => {
  const fake = new FakeChannel();
  const port = await freePort();
  const link: PreviewDestination = { id: 'app-a', workerId: 'w1', port: 3000, hubPort: port };
  let permitted = true;
  let resolved = true;
  const proxy = createPreviewProxy<PreviewDestination>({
    resolve: async () => resolved ? link : null,
    authorize: async () => permitted,
    channel: fake,
    exclusivePorts: true
  });
  t.after(() => proxy.close());
  await proxy.listen(link);
  fake.onOpen = (stream) => {
    stream.emitHead({ status: 200, statusText: 'OK', headers: [
      ['cache-control', 'public, max-age=86400'], ['expires', 'Wed, 21 Oct 2037 07:28:00 GMT']
    ] });
    stream.emitEnd();
  };
  const serviceWorkerHeaders: Record<string, string>[] = [
    { 'service-worker': 'script' },
    { 'sec-fetch-dest': 'serviceworker' }
  ];
  for (const headers of serviceWorkerHeaders) {
    const denied = await request(port, '/worker.js', { headers });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['cache-control'], 'no-store');
  }
  assert.equal(fake.calls.length, 0);
  const forwarded = await request(port, '/');
  assert.equal(forwarded.status, 200);
  assert.equal(forwarded.headers['cache-control'], 'no-store');
  assert.equal(forwarded.headers.expires, undefined);
  permitted = false;
  const redirect = await request(port, '/');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers['cache-control'], 'no-store');
  resolved = false;
  const missing = await request(port, '/');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['cache-control'], 'no-store');
});

test('legacy proxy leaves service worker requests and cache headers unchanged', async (t) => {
  const { fake, port } = await setup(t);
  fake.onOpen = (stream) => {
    stream.emitHead({ status: 200, statusText: 'OK', headers: [
      ['cache-control', 'public, max-age=120'], ['expires', 'Wed, 21 Oct 2037 07:28:00 GMT']
    ] });
    stream.emitEnd();
  };
  const response = await request(port, '/worker.js', { headers: { 'service-worker': 'script' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'public, max-age=120');
  assert.equal(response.headers.expires, 'Wed, 21 Oct 2037 07:28:00 GMT');
  assert.equal(fake.calls.length, 1);
});

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
    headers: {
      accept: 'text/plain',
      cookie: 'hub_login=abc',
      authorization: 'Bearer hub-secret',
      'proxy-authorization': 'Basic abc',
      connection: 'keep-alive'
    }
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
  // Hub 的登录凭据不能漏给上游 dev server。
  assert.equal(forwarded.get('cookie'), undefined);
  assert.equal(forwarded.get('authorization'), undefined);
  assert.equal(forwarded.get('proxy-authorization'), undefined);
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

test('回环来源也不再免鉴权：连 127.0.0.1、无 cookie → 302 到登录页', async (t) => {
  const { port } = await setup(t, {
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

test('公开分享：带有效 share、无 cookie 也放行，不查 cookie', async (t) => {
  const calls: string[] = [];
  const { fake, port } = await setup(t, {
    authorize: async () => {
      calls.push('cookie');
      return false;
    },
    matchShare: async (_link, token) => {
      calls.push(`share:${token}`);
      return token === 'pvs_good';
    },
  });
  fake.onOpen = (stream) => {
    stream.emitHead({ status: 200, statusText: 'OK', headers: [['content-type', 'text/plain']] });
    stream.emitData('shared');
    stream.emitEnd();
  };

  const response = await request(port, '/index.html?share=pvs_good');
  assert.equal(response.status, 200);
  assert.equal(response.body, 'shared');
  assert.deepEqual(calls, ['share:pvs_good']);
  // 分享令牌只给 hub 用，转发给上游前要删掉；其余参数原样保留。
  assert.equal(fake.calls[0]!.request.path, '/index.html');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
});

test('分享令牌不转发上游：按 & 删 share 段，其余参数与编码原样保留', async (t) => {
  const { fake, port } = await setup(t, {
    matchShare: async (_link, token) => token === 'pvs_good'
  });
  fake.onOpen = (stream) => {
    stream.emitHead({ status: 200, statusText: 'OK', headers: [['content-type', 'text/plain']] });
    stream.emitEnd();
  };

  const response = await request(port, '/path?share=pvs_good&a=1&b=%2Fkeep&empty=');
  assert.equal(response.status, 200);
  assert.equal(fake.calls[0]!.request.path, '/path?a=1&b=%2Fkeep&empty=');

  const only = await request(port, '/only?share=pvs_good');
  assert.equal(only.status, 200);
  assert.equal(fake.calls[1]!.request.path, '/only');

  // 上游自己设了 referrer-policy 也要覆盖成 no-referrer（#213/#221）。
  fake.onOpen = (stream) => {
    stream.emitHead({
      status: 200,
      statusText: 'OK',
      headers: [
        ['content-type', 'text/plain'],
        ['referrer-policy', 'same-origin'],
        // 上游想在 hub 的 origin 上写 cookie：必须在出口丢掉。
        ['set-cookie', 'upstream=1; Path=/']
      ]
    });
    stream.emitEnd();
  };
  const kept = await request(port, '/keep', { headers: { cookie: 'hub_login=abc' } });
  assert.equal(kept.headers['referrer-policy'], 'no-referrer');
  assert.equal(kept.headers['set-cookie'], undefined);
});

test('公开分享：令牌不对/过期仍能靠 cookie 进来，最终才 302', async (t) => {
  const { fake, port } = await setup(t, {
    authorize: async (request) => String(request.headers.cookie ?? '').includes('hub_login=ok'),
    matchShare: async () => false,
  });
  fake.onOpen = (stream) => {
    stream.emitHead({ status: 200, statusText: 'OK', headers: [['content-type', 'text/plain']] });
    stream.emitData('cooked');
    stream.emitEnd();
  };

  // share 失效但 cookie 有效：照常放行，share 前缀不会把人挡在外面。
  const withCookie = await request(port, '/?share=pvs_expired', { headers: { cookie: 'hub_login=ok' } });
  assert.equal(withCookie.status, 200);
  assert.equal(withCookie.body, 'cooked');

  // 两个都不行：还是 302 到登录页。
  const anonymous = await request(port, '/?share=pvs_expired');
  assert.equal(anonymous.status, 302);
  assert.ok(String(anonymous.headers.location ?? '').startsWith('/login?next='));
});

test('公开分享：没有 share 时 cookie 鉴权行为不变', async (t) => {
  const { fake, port } = await setup(t, {
    authorize: async (request) => String(request.headers.cookie ?? '').includes('hub_login=ok'),
    matchShare: async () => {
      throw new Error('无 share 时不该调用');
    },
  });
  fake.onOpen = (stream) => {
    stream.emitHead({ status: 200, statusText: 'OK', headers: [['content-type', 'text/plain']] });
    stream.emitData('cookie-only');
    stream.emitEnd();
  };

  const response = await request(port, '/app', { headers: { cookie: 'hub_login=ok' } });
  assert.equal(response.status, 200);
  assert.equal(response.body, 'cookie-only');
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

  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket?share=pvs_x&v=1`);
  t.after(() => socket.terminate());
  await once(socket, 'open');

  const call = fake.calls[0]!;
  assert.deepEqual(call.request.upgrade, { protocol: null });
  // upgrade 与 HTTP 一样删掉 share，其余查询串原样。
  assert.equal(call.request.path, '/socket?v=1');
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

test('WS 101 响应：动态 Connection 字段与 set-cookie 不进握手，协商结果保留', async (t) => {
  const { fake, port } = await setup(t);
  fake.onOpen = (stream, openRequest) => {
    const key = openRequest.headers.find(([name]) => name.toLowerCase() === 'sec-websocket-key')?.[1] ?? '';
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    stream.emitHead({
      status: 101,
      statusText: 'Switching Protocols',
      headers: [
        ['upgrade', 'websocket'],
        ['connection', 'Upgrade, x-dynamic-response'],
        ['x-dynamic-response', 'must-not-leak'],
        ['sec-websocket-accept', accept],
        ['sec-websocket-protocol', 'graphql-ws'],
        ['set-cookie', 'ws=1; Path=/']
      ]
    });
  };

  let handshake: IncomingHttpHeaders = {};
  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`, ['graphql-ws']);
  socket.on('upgrade', (response) => {
    handshake = response.headers;
  });
  t.after(() => socket.terminate());
  await once(socket, 'open');

  assert.equal(handshake['sec-websocket-protocol'], 'graphql-ws');
  assert.equal(typeof handshake['sec-websocket-accept'], 'string');
  assert.equal(handshake['x-dynamic-response'], undefined);
  assert.equal(handshake['set-cookie'], undefined);
  assert.equal(handshake.connection, 'Upgrade');
  assert.equal(handshake.upgrade, 'websocket');
});

test('正常请求 / WS 升级：同一批合成头的剥离结果一致', async (t) => {
  const { fake, port } = await setup(t);
  fake.onOpen = (stream, openRequest) => {
    if (openRequest.upgrade === undefined) {
      stream.emitHead({
        status: 200,
        statusText: 'OK',
        headers: [
          ['content-type', 'text/plain'],
          ['set-cookie', 'upstream=1; Path=/'],
          ['connection', 'keep-alive, x-dynamic-response'],
          ['x-dynamic-response', 'must-not-leak']
        ]
      });
      stream.emitData('plain');
      stream.emitEnd();
      return;
    }
    const key = openRequest.headers.find(([name]) => name.toLowerCase() === 'sec-websocket-key')?.[1] ?? '';
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
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

  // 客户端塞进来的合成头：凭据 / 只对当前连接有意义的头 / proxy-*。
  const leaked: Record<string, string> = {
    cookie: 'hub_login=abc',
    authorization: 'Bearer hub-secret',
    'proxy-authorization': 'Basic abc',
    expect: '100-continue',
    te: 'trailers',
    'proxy-connection': 'keep-alive'
  };
  // 普通头：名字会被 Node 规范化成小写，值必须原样过去。
  const kept = { 'X-Case-Probe': 'MiXeD', 'user-agent': 'parity-fixture' };

  const httpResponse = await request(port, '/plain', {
    headers: { ...leaked, ...kept, connection: 'keep-alive, x-dynamic-hop', 'x-dynamic-hop': 'must-not-leak' }
  });
  assert.equal(httpResponse.status, 200);
  assert.equal(httpResponse.body, 'plain');
  // 上游的 set-cookie 不落到 hub 的 origin 上；Connection 点名的响应头同样是逐跳的。
  assert.equal(httpResponse.headers['set-cookie'], undefined);
  assert.equal(httpResponse.headers['x-dynamic-response'], undefined);

  // ws 客户端自己会写 Connection/Upgrade，浏览器侧真正的动态 token 由上面的 HTTP 请求覆盖。
  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { ...leaked, ...kept } });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  socket.send('ping');
  const [message] = (await once(socket, 'message')) as [Buffer];
  assert.equal(String(message), 'pong');

  assert.equal(fake.calls.length, 2);
  const forwardedOf = (index: number): Map<string, string> =>
    new Map(fake.calls[index]!.request.headers.map(([name, value]) => [name.toLowerCase(), value]));
  const httpForwarded = forwardedOf(0);
  const wsForwarded = forwardedOf(1);

  for (const name of Object.keys(leaked)) {
    assert.equal(httpForwarded.get(name), undefined, `HTTP 不该转发 ${name}`);
    assert.equal(wsForwarded.get(name), undefined, `WS 不该转发 ${name}`);
  }
  // Connection 里点名的字段同样是逐跳的。
  assert.equal(httpForwarded.get('x-dynamic-hop'), undefined);
  for (const [name, value] of Object.entries(kept)) {
    assert.equal(httpForwarded.get(name.toLowerCase()), value);
    assert.equal(wsForwarded.get(name.toLowerCase()), value);
  }

  // 升级必需的 connection/upgrade 必须保留并改写成固定值。
  assert.equal(wsForwarded.get('connection'), 'Upgrade');
  assert.equal(wsForwarded.get('upgrade'), 'websocket');
  assert.equal(wsForwarded.get('sec-websocket-key')?.length, 24);
  // 两种入口的 Host / X-Forwarded-* 语义一致，只有协议不同。
  assert.equal(httpForwarded.get('host'), '127.0.0.1:3000');
  assert.equal(wsForwarded.get('host'), '127.0.0.1:3000');
  assert.equal(httpForwarded.get('x-forwarded-proto'), 'http');
  // 端口模式下 hub 的 `proto` 默认就是 http（升级请求也一样），这里只验证没改默认值。
  assert.equal(wsForwarded.get('x-forwarded-proto'), 'http');
  assert.equal(httpForwarded.get('x-forwarded-host'), `127.0.0.1:${port}`);
  assert.equal(wsForwarded.get('x-forwarded-host'), `127.0.0.1:${port}`);
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
