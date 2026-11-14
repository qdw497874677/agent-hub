import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PreviewDownFrame, PreviewUpFrame } from '@agent-hub/contract';
import { createPreviewClient, type PreviewClient } from './preview-client.ts';

/**
 * 预览客户端的行为测试：本地起一个假 hub（ws）+ 一个假上游（http / 裸 tcp），
 * 不碰真实端口（一律 `listen(0)`）、不依赖 hub 服务端实现。
 */

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 等某个已经收到 / 将要收到的帧。 */
function waitForFrame(
  frames: readonly PreviewDownFrame[],
  predicate: (frame: PreviewDownFrame) => boolean,
  label: string,
  timeoutMs = 2_000
): Promise<PreviewDownFrame> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const found = frames.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等不到帧：${label}；已收到 ${frames.map((frame) => frame.kind).join(',')}`));
      }
    };
    const timer = setInterval(tick, 5);
    tick();
  });
}

function dataFrames(frames: readonly PreviewDownFrame[], streamId: string): string[] {
  return frames
    .filter((frame): frame is Extract<PreviewDownFrame, { kind: 'preview_data' }> => frame.kind === 'preview_data' && frame.streamId === streamId)
    .map((frame) => frame.data);
}

function decode(frames: string[]): Buffer {
  return Buffer.concat(frames.map((frame) => Buffer.from(frame, 'base64')));
}

interface FakeHub {
  readonly url: string;
  readonly frames: PreviewDownFrame[];
  readonly ready: Promise<void>;
  readonly authorization: () => string | null;
  send(frame: PreviewUpFrame): void;
  close(): Promise<void>;
}

/** 假 hub：客户端还没连上时把帧排队，连上后按序发出（测试不用关心连接时序）。 */
async function startHub(): Promise<FakeHub> {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const port = (wss.address() as AddressInfo).port;
  const frames: PreviewDownFrame[] = [];
  let header: string | null = null;
  let socket: WebSocket | null = null;
  const queued: string[] = [];
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  wss.on('connection', (next: WebSocket, request: IncomingMessage) => {
    header = request.headers.authorization ?? null;
    socket = next;
    next.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString()) as PreviewDownFrame);
    });
    for (const text of queued.splice(0)) next.send(text);
    markReady();
  });
  return {
    url: `ws://127.0.0.1:${port}/preview`,
    frames,
    ready,
    authorization: () => header,
    send: (frame) => {
      const text = JSON.stringify(frame);
      if (socket === null) queued.push(text);
      else socket.send(text);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      })
  };
}

async function startHttp(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  port: number;
  requests: IncomingMessage[];
  close: () => Promise<void>;
}> {
  const requests: IncomingMessage[] = [];
  const server = createHttpServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

let streamSeq = 0;
const nextStreamId = (): string => (streamSeq += 1).toString(16).padStart(16, '0');

interface OpenOptions {
  method?: string;
  path?: string;
  headers?: Array<[string, string]>;
  upgrade?: { protocol: string | null };
}

function openFrame(port: number, overrides: OpenOptions = {}): PreviewUpFrame {
  return {
    kind: 'preview_open',
    streamId: nextStreamId(),
    port,
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/',
    headers: overrides.headers ?? [['host', 'preview.example:17901']],
    ...(overrides.upgrade !== undefined ? { upgrade: overrides.upgrade } : {})
  };
}

async function stopClient(client: PreviewClient): Promise<void> {
  await client.stop();
}

test('普通 GET：回包、状态头，Host 被改写且原 connection 不透传', async () => {
  const upstream = await startHttp((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'yes' });
    res.end('hello preview');
  });
  const hub = await startHub();
  const client = createPreviewClient({ url: hub.url, credential: 'ahw_test', headerTimeoutMs: 2_000 });
  client.start();
  try {
    await hub.ready;
    assert.equal(hub.authorization(), 'Bearer ahw_test');
    const stream = openFrame(upstream.port, {
      path: '/hello?x=1',
      headers: [
        ['host', 'preview.example:17901'],
        ['connection', 'keep-alive'],
        ['user-agent', 'probe']
      ]
    });
    hub.send(stream);

    const head = await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_head' && frame.streamId === stream.streamId, 'head');
    assert.equal(head.kind, 'preview_head');
    if (head.kind !== 'preview_head') throw new Error('unreachable');
    assert.equal(head.status, 200);
    assert.ok(head.headers.some(([name, value]) => name.toLowerCase() === 'x-upstream' && value === 'yes'));

    await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_end' && frame.streamId === stream.streamId, 'end');
    assert.equal(decode(dataFrames(hub.frames, stream.streamId)).toString(), 'hello preview');

    const seen = upstream.requests[0]!;
    assert.equal(seen.headers.host, `127.0.0.1:${upstream.port}`);
    // node:http 自己会补 Connection（agent:false → close），但调用方原来的 keep-alive 不能透传。
    assert.notEqual(seen.headers.connection, 'keep-alive');
    assert.equal(seen.headers['x-forwarded-host'], 'preview.example:17901');
    assert.equal(seen.headers['x-forwarded-proto'], 'http');
    assert.equal(seen.headers['user-agent'], 'probe');
  } finally {
    await stopClient(client);
    await hub.close();
    await upstream.close();
  }
});

test('POST body：preview_body 分块写入上游，201 回包透传', async () => {
  const upstream = await startHttp((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'text/plain' });
      res.end(`created:${Buffer.concat(chunks).toString()}`);
    });
  });
  const hub = await startHub();
  const client = createPreviewClient({ url: hub.url, credential: 'ahw_test', headerTimeoutMs: 2_000 });
  client.start();
  try {
    const stream = openFrame(upstream.port, {
      method: 'POST',
      path: '/items',
      headers: [
        ['host', 'preview.example:17901'],
        ['content-length', '6'],
        ['content-type', 'text/plain']
      ]
    });
    hub.send(stream);
    hub.send({ kind: 'preview_body', streamId: stream.streamId, data: Buffer.from('abc').toString('base64'), end: false });
    hub.send({ kind: 'preview_body', streamId: stream.streamId, data: Buffer.from('def').toString('base64'), end: true });

    const head = await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_head' && frame.streamId === stream.streamId, 'head');
    if (head.kind !== 'preview_head') throw new Error('unreachable');
    assert.equal(head.status, 201);
    await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_end' && frame.streamId === stream.streamId, 'end');
    assert.equal(decode(dataFrames(hub.frames, stream.streamId)).toString(), 'created:abcdef');
  } finally {
    await stopClient(client);
    await hub.close();
    await upstream.close();
  }
});

test('404 原样透传', async () => {
  const upstream = await startHttp((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });
  const hub = await startHub();
  const client = createPreviewClient({ url: hub.url, credential: 'ahw_test', headerTimeoutMs: 2_000 });
  client.start();
  try {
    const stream = openFrame(upstream.port, { path: '/missing' });
    hub.send(stream);

    const head = await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_head' && frame.streamId === stream.streamId, 'head');
    if (head.kind !== 'preview_head') throw new Error('unreachable');
    assert.equal(head.status, 404);
    await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_end' && frame.streamId === stream.streamId, 'end');
    assert.equal(decode(dataFrames(hub.frames, stream.streamId)).toString(), 'nope');
  } finally {
    await stopClient(client);
    await hub.close();
    await upstream.close();
  }
});

test('credits：8 帧后暂停，ack 补窗口后继续到结束', async () => {
  const body = Buffer.alloc(1024 * 1024, 0x61);
  const upstream = await startHttp((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    res.end(body);
  });
  const hub = await startHub();
  const client = createPreviewClient({ url: hub.url, credential: 'ahw_test', headerTimeoutMs: 2_000 });
  client.start();
  try {
    const stream = openFrame(upstream.port, { path: '/big' });
    hub.send(stream);

    await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_head' && frame.streamId === stream.streamId, 'head');
    const started = Date.now();
    while (dataFrames(hub.frames, stream.streamId).length < 8 && Date.now() - started < 2_000) await delay(5);
    await delay(120);
    assert.equal(dataFrames(hub.frames, stream.streamId).length, 8, 'credits 用尽后应该停在上限');
    assert.equal(client.activeStreams(), 1);

    hub.send({ kind: 'preview_ack', streamId: stream.streamId, credits: 64 });
    await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_end' && frame.streamId === stream.streamId, 'end');

    const received = decode(dataFrames(hub.frames, stream.streamId));
    assert.equal(received.length, body.length);
    assert.ok(received.equals(body));
  } finally {
    await stopClient(client);
    await hub.close();
    await upstream.close();
  }
});

test('WS 隧道：101 之后双向字节原样转发', async () => {
  let seenHead = '';
  const server = createNetServer((socket) => {
    let buffered = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (chunk: Buffer) => {
      if (!upgraded) {
        buffered = Buffer.concat([buffered, chunk]);
        const end = buffered.indexOf('\r\n\r\n');
        if (end < 0) return;
        seenHead = buffered.subarray(0, end).toString('latin1');
        upgraded = true;
        const rest = buffered.subarray(end + 4);
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        if (rest.length > 0) socket.write(rest);
        return;
      }
      socket.write(chunk);
    });
    socket.on('error', () => undefined);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  const hub = await startHub();
  const client = createPreviewClient({ url: hub.url, credential: 'ahw_test', headerTimeoutMs: 2_000 });
  client.start();
  try {
    const stream = openFrame(port, {
      path: '/socket',
      headers: [
        ['host', 'preview.example:17901'],
        ['upgrade', 'websocket'],
        ['connection', 'Upgrade'],
        ['sec-websocket-key', 'dGhlIHNhbXBsZSBub25jZQ=='],
        ['sec-websocket-version', '13']
      ],
      upgrade: { protocol: 'websocket' }
    });
    hub.send(stream);

    const head = await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_head' && frame.streamId === stream.streamId, '101');
    if (head.kind !== 'preview_head') throw new Error('unreachable');
    assert.equal(head.status, 101);

    assert.match(seenHead, /^GET \/socket HTTP\/1\.1\r\n/);
    const lower = seenHead.toLowerCase();
    assert.ok(lower.includes(`host: 127.0.0.1:${port}`), `上游看到的 host 不对：${seenHead}`);
    assert.ok(lower.includes('upgrade: websocket'));
    assert.ok(lower.includes('x-forwarded-proto: ws'));

    const payload = Buffer.from('ping-through-tunnel');
    hub.send({ kind: 'preview_body', streamId: stream.streamId, data: payload.toString('base64'), end: false });
    await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_data' && frame.streamId === stream.streamId, 'echo');
    assert.equal(decode(dataFrames(hub.frames, stream.streamId)).toString(), 'ping-through-tunnel');

    hub.send({ kind: 'preview_close', streamId: stream.streamId });
    await delay(50);
    assert.equal(client.activeStreams(), 0);
  } finally {
    await stopClient(client);
    await hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('上游拒绝连接：preview_failed refused', async () => {
  // 拿一个刚释放的端口：没有监听者 = 拒绝。
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const hub = await startHub();
  const client = createPreviewClient({ url: hub.url, credential: 'ahw_test', headerTimeoutMs: 2_000 });
  client.start();
  try {
    const stream = openFrame(closedPort);
    hub.send(stream);
    const failed = await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_failed' && frame.streamId === stream.streamId, 'failed');
    if (failed.kind !== 'preview_failed') throw new Error('unreachable');
    assert.equal(failed.code, 'refused');
    assert.equal(client.activeStreams(), 0);
  } finally {
    await stopClient(client);
    await hub.close();
  }
});

test('并发超限：preview_failed forbidden', async () => {
  const upstream = await startHttp((_req, _res) => {
    // 永不回包：流一直占着。
  });
  const hub = await startHub();
  const client = createPreviewClient({ url: hub.url, credential: 'ahw_test', maxStreams: 1, headerTimeoutMs: 5_000 });
  client.start();
  try {
    const first = openFrame(upstream.port, { path: '/hang' });
    hub.send(first);
    await delay(50);
    const second = openFrame(upstream.port, { path: '/second' });
    hub.send(second);

    const failed = await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_failed' && frame.streamId === second.streamId, 'forbidden');
    if (failed.kind !== 'preview_failed') throw new Error('unreachable');
    assert.equal(failed.code, 'forbidden');
    assert.match(failed.message, /预览流太多了/);
  } finally {
    await stopClient(client);
    await hub.close();
    await upstream.close();
  }
});

test('preview_close：中止上游、不再发数据帧', async () => {
  let ticks = 0;
  const upstream = await startHttp((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const timer = setInterval(() => {
      ticks += 1;
      res.write(`tick ${ticks}\n`);
    }, 20);
    res.on('close', () => clearInterval(timer));
  });
  const hub = await startHub();
  const client = createPreviewClient({ url: hub.url, credential: 'ahw_test', headerTimeoutMs: 2_000 });
  client.start();
  try {
    const stream = openFrame(upstream.port, { path: '/stream' });
    hub.send(stream);
    await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_data' && frame.streamId === stream.streamId, 'first data');
    const before = dataFrames(hub.frames, stream.streamId).length;

    hub.send({ kind: 'preview_close', streamId: stream.streamId });
    await delay(150);
    assert.equal(client.activeStreams(), 0);
    assert.equal(dataFrames(hub.frames, stream.streamId).length, before);
    assert.ok(!hub.frames.some((frame) => frame.kind === 'preview_end' && frame.streamId === stream.streamId), 'close 不应补 preview_end');
    const ticksAtClose = ticks;
    await delay(100);
    assert.equal(ticks, ticksAtClose, '上游应该已经断开');
  } finally {
    await stopClient(client);
    await hub.close();
    await upstream.close();
  }
});

test('detect：只有 scanPorts 里的端口才上报，同一会话同一端口只发一次', async () => {
  const hub = await startHub();
  // 假 /proc：只有 5173 在监听；8000 是「输出里写了但根本没起服务」。
  const client = createPreviewClient({ url: hub.url, credential: 'ahw_test', scanPorts: () => [5173] });
  client.start();
  try {
    const ports = await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_ports', 'ports');
    if (ports.kind !== 'preview_ports') throw new Error('unreachable');
    assert.deepEqual(ports.ports, [5173]);

    client.detect('ses_1', '  Local:   http://localhost:5173/');
    client.detect('ses_1', '再写一遍 127.0.0.1:5173 也只报一次');
    client.detect('ses_1', 'not listening http://localhost:8000/');

    const detected = await waitForFrame(hub.frames, (frame) => frame.kind === 'preview_detected', 'detected');
    if (detected.kind !== 'preview_detected') throw new Error('unreachable');
    assert.equal(detected.sessionId, 'ses_1');
    assert.equal(detected.port, 5173);
    assert.equal(detected.label, 'Local:   http://localhost:5173/');

    await delay(80);
    const all = hub.frames.filter((frame) => frame.kind === 'preview_detected');
    assert.equal(all.length, 1, '重复的 detect 不应再发帧');
    assert.ok(!hub.frames.some((frame) => frame.kind === 'preview_detected' && frame.port === 8000), '没监听的端口不该上报');
  } finally {
    await stopClient(client);
    await hub.close();
  }
});
