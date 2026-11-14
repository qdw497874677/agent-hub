import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { JsonRpcError, JsonRpcPeer } from './jsonrpc.ts';
import type { JsonRpcPeerOptions } from './jsonrpc.ts';

interface LineReader {
  next(): Promise<Record<string, unknown>>;
}

function lineReader(stream: PassThrough): LineReader {
  const queue: Record<string, unknown>[] = [];
  const waiters: ((value: Record<string, unknown>) => void)[] = [];
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter === undefined) queue.push(parsed);
      else waiter(parsed);
      index = buffer.indexOf('\n');
    }
  });
  return {
    next(): Promise<Record<string, unknown>> {
      const value = queue.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise<Record<string, unknown>>((resolve) => {
        waiters.push(resolve);
      });
    }
  };
}

function makePeer(overrides: Partial<JsonRpcPeerOptions> = {}): {
  readonly peer: JsonRpcPeer;
  readonly inbound: PassThrough;
  readonly outbound: PassThrough;
  readonly received: LineReader;
} {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const peer = new JsonRpcPeer({
    input: inbound,
    output: outbound,
    defaultTimeoutMs: 500,
    ...overrides
  });
  return { peer, inbound, outbound, received: lineReader(outbound) };
}

function send(inbound: PassThrough, message: unknown): void {
  inbound.write(`${JSON.stringify(message)}\n`);
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`等不到 ${label}`);
}

test('请求与响应按 id 配对，通知不带 id', async () => {
  const { peer, inbound, received } = makePeer();
  const pending = peer.request('thread/start', { cwd: '/tmp/work' });
  const request = await received.next();
  assert.equal(request['jsonrpc'], '2.0');
  assert.equal(request['method'], 'thread/start');
  assert.deepEqual(request['params'], { cwd: '/tmp/work' });
  assert.equal(typeof request['id'], 'number');

  peer.notify('initialized');
  const notification = await received.next();
  assert.equal(notification['method'], 'initialized');
  assert.equal(notification['id'], undefined);

  send(inbound, { jsonrpc: '2.0', id: request['id'], result: { thread: { id: 'th_1' } } });
  assert.deepEqual(await pending, { thread: { id: 'th_1' } });
  peer.close();
});

test('永远不回应的请求按超时报错', async () => {
  const { peer } = makePeer();
  await assert.rejects(peer.request('thread/start', {}, 50), /没有回应 thread\/start/);
  peer.close();
});

test('错误响应变成带 code 的 JsonRpcError', async () => {
  const { peer, inbound, received } = makePeer();
  const pending = peer.request('thread/resume', { threadId: 'th_missing' });
  const request = await received.next();
  send(inbound, {
    jsonrpc: '2.0',
    id: request['id'],
    error: { code: -32001, message: 'thread not found' }
  });
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof JsonRpcError);
    assert.equal(error.code, -32001);
    assert.match(error.message, /thread not found/);
    return true;
  });
  peer.close();
});

test('服务端发来的 request 交给 onRequest，respond 回到同一个 id', async () => {
  let handler:
    | { readonly method: string; readonly params: Record<string, unknown>; readonly respond: (result: unknown) => void }
    | undefined;
  const { peer, inbound, received } = makePeer({
    onRequest: (method, params, respond) => {
      handler = { method, params, respond };
    }
  });
  send(inbound, {
    jsonrpc: '2.0',
    id: 7,
    method: 'item/commandExecution/requestApproval',
    params: { itemId: 'item_1', command: 'ls' }
  });
  await waitUntil(() => handler !== undefined, 'onRequest 被调用');
  assert.equal(handler!.method, 'item/commandExecution/requestApproval');
  assert.equal(handler!.params['itemId'], 'item_1');
  handler!.respond({ decision: 'accept' });

  const response = await received.next();
  assert.equal(response['id'], 7);
  assert.deepEqual(response['result'], { decision: 'accept' });
  peer.close();
});

test('没有 onRequest 时服务端 request 收到 -32601', async () => {
  const { peer, inbound, received } = makePeer();
  send(inbound, { jsonrpc: '2.0', id: 9, method: 'attestation/generate', params: {} });
  const response = await received.next();
  assert.equal(response['id'], 9);
  assert.equal((response['error'] as Record<string, unknown>)['code'], -32601);
  peer.close();
});

test('close 会把还挂着的请求全部拒绝', async () => {
  const { peer } = makePeer();
  const pending = peer.request('model/list', {}, 10_000);
  peer.close('会话已结束');
  await assert.rejects(pending, /会话已结束/);
});
