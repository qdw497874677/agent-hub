import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
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

/** 可控失败时机的输出流：先扣住写回调，测试决定何时成功或失败。 */
class DeferredWritable extends Writable {
  readonly frames: string[] = [];
  private readonly callbacks: ((error?: Error | null) => void)[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.frames.push(chunk.toString());
    this.callbacks.push(callback);
  }

  release(error?: Error): void {
    const callback = this.callbacks.shift();
    if (callback === undefined) throw new Error('没有待完成的写回调');
    callback(error);
  }
}

function captureProcessErrors(): { readonly errors: unknown[]; restore: () => void } {
  const errors: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    errors.push(error);
  };
  const onRejection = (reason: unknown): void => {
    errors.push(reason);
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  return {
    errors,
    restore: () => {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejection);
    }
  };
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

test('JSON 字符串里的 U+2028 / U+2029 跨 chunk 切分（含多字节被拆开）仍是一帧', async () => {
  const notifications: { readonly method: string; readonly text: string }[] = [];
  const { peer, inbound, received } = makePeer({
    onNotification: (method, params) => {
      notifications.push({ method, text: String(params['text'] ?? '') });
    }
  });
  const pending = peer.request('thread/start', {});
  const request = await received.next();
  const expected = '甲\u2028乙\u2029丙';
  const frames =
    `${JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { text: expected } })}\n` +
    `${JSON.stringify({ jsonrpc: '2.0', id: request['id'], result: { text: expected } })}\n`;
  // 逐字节写：必然会把 U+2028 / U+2029 的三字节 UTF-8 序列拆到不同 chunk 里。
  for (const byte of Buffer.from(frames, 'utf8')) inbound.write(Buffer.from([byte]));
  assert.deepEqual(await pending, { text: expected });
  await waitUntil(() => notifications.length === 1, '通知到达');
  assert.equal(notifications[0]!.method, 'note');
  assert.equal(notifications[0]!.text, expected);
  peer.close();
});

test('CRLF 跨 chunk、EOF 前的无换行尾帧都按整帧处理', async () => {
  const seen: string[] = [];
  const { peer, inbound, received } = makePeer({ onNotification: (method) => seen.push(method) });
  const pending = peer.request('thread/start', {});
  const request = await received.next();
  inbound.write('{"jsonrpc":"2.0","method":"one","params":{}}\r');
  inbound.write('\n{"jsonrpc":"2.0","method":"two","params":{}}\n');
  inbound.write(`{"jsonrpc":"2.0","id":${JSON.stringify(request['id'])}}`);
  inbound.end();
  // 尾帧没有换行，靠 EOF 才交付：它必须先把响应解析出来，再拒绝剩余的挂起请求。
  assert.deepEqual(await pending, null);
  assert.deepEqual(seen, ['one', 'two']);
  peer.close();
});

test('输入 EOF 会立刻拒绝挂起请求', async () => {
  const { peer, inbound } = makePeer();
  const pending = peer.request('model/list', {}, 60_000);
  inbound.end();
  await assert.rejects(pending, /连接已关闭/);
  peer.close();
});

test('输入 EOF 之后新建的请求立即拒绝，且不再写输出', async () => {
  const { peer, inbound, outbound } = makePeer();
  let written = 0;
  outbound.on('data', (chunk: string) => {
    written += chunk.length;
  });
  const pending = peer.request('model/list', {}, 60_000);
  inbound.end();
  await assert.rejects(pending, /连接已关闭/);
  const before = written;
  await assert.rejects(peer.request('model/list', {}, 60_000), /连接已关闭/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(written, before, 'EOF 之后不应该再写任何帧');
});

test('输入流读错误后挂起与新建的请求都立即拒绝', async () => {
  const { peer, inbound } = makePeer();
  const pending = peer.request('model/list', {}, 60_000);
  inbound.destroy(new Error('stdout 坏了'));
  await assert.rejects(pending, /stdout 坏了/);
  // 之后的新请求没有回复路径：立即拒绝，不写、不等超时。
  await assert.rejects(peer.request('model/list', {}, 60_000), /连接已关闭/);
});

test('无法解析的帧只报固定次数，且不影响后续合法帧', async () => {
  let invalidFrames = 0;
  const seen: string[] = [];
  const { peer, inbound } = makePeer({
    onInvalidFrame: () => {
      invalidFrames += 1;
    },
    onNotification: (method) => seen.push(method)
  });
  for (let index = 0; index < 6; index += 1) inbound.write(`{坏帧 ${index}}\n`);
  inbound.write('{"jsonrpc":"2.0","method":"ok","params":{}}\n');
  await waitUntil(() => seen.length === 1, '合法帧到达');
  assert.equal(invalidFrames, 3, '诊断次数要有上限');
  assert.deepEqual(seen, ['ok']);
  peer.close();
});

test('close 之后到达的数据不再派发', async () => {
  const seen: string[] = [];
  const { peer, inbound } = makePeer({ onNotification: (method) => seen.push(method) });
  const pending = peer.request('model/list', {}, 60_000);
  peer.close('会话已结束');
  await assert.rejects(pending, /会话已结束/);
  inbound.write('{"jsonrpc":"2.0","method":"late","params":{}}\n');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, []);
});

test('close 与延迟的写失败、输入 EOF / 读错误竞态时原始原因只交付一次', async (t) => {
  const processErrors = captureProcessErrors();
  t.after(() => processErrors.restore());

  for (const inputFailure of ['end', 'error'] as const) {
    const inbound = new PassThrough();
    const output = new DeferredWritable();
    const peer = new JsonRpcPeer({ input: inbound, output, defaultTimeoutMs: 60_000 });

    const pending = peer.request('model/list');
    let settlements = 0;
    void pending.then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      }
    );
    assert.equal(output.frames.length, 1);

    // 先显式关闭，再让输出写失败，同时输入 EOF / 读错误：多条终态路径只允许第一条生效。
    peer.close('原始关闭原因');
    if (inputFailure === 'end') inbound.end();
    else inbound.destroy(new Error('原始读错误'));
    output.release(new Error('EPIPE 原始错误'));
    await assert.rejects(pending, /原始关闭原因/);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(settlements, 1, `${inputFailure}: 挂起请求只能结算一次`);
    const framesBefore = output.frames.length;
    await assert.rejects(peer.request('model/list'), /连接已关闭/);
    assert.equal(output.frames.length, framesBefore, `${inputFailure}: 关闭后不再写任何帧`);
  }
  assert.deepEqual(processErrors.errors, [], '终态竞态不应留下未捕获异常 / 未处理的拒绝');
});

test('输出写失败立即终结连接，后续请求不再写', async (t) => {
  const processErrors = captureProcessErrors();
  t.after(() => processErrors.restore());
  const output = new DeferredWritable();
  const peer = new JsonRpcPeer({ input: new PassThrough(), output, defaultTimeoutMs: 60_000 });

  const pending = peer.request('model/list');
  assert.equal(output.frames.length, 1);
  output.release(new Error('EPIPE 原始错误'));

  // 固定诊断、不抄底层错误文本；且不等到 60s 超时。
  await assert.rejects(pending, /codex 连接写入失败/);
  const framesBefore = output.frames.length;
  await assert.rejects(peer.request('model/list'), /连接已关闭/);
  assert.equal(output.frames.length, framesBefore, '输出失败后不再写任何帧');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(processErrors.errors, [], '输出流的 error 事件必须有人接住');
});

test('输出流已结束或已销毁时请求立即拒绝而不是挂到超时', { timeout: 2_000 }, async () => {
  const endedOutput = new PassThrough();
  endedOutput.end();
  const endedPeer = new JsonRpcPeer({ input: new PassThrough(), output: endedOutput, defaultTimeoutMs: 60_000 });
  await assert.rejects(endedPeer.request('model/list'), /codex 连接写入失败/);

  const destroyedOutput = new PassThrough();
  destroyedOutput.destroy();
  const destroyedPeer = new JsonRpcPeer({
    input: new PassThrough(),
    output: destroyedOutput,
    defaultTimeoutMs: 60_000
  });
  await assert.rejects(destroyedPeer.request('model/list'), /codex 连接写入失败/);
});

test('输出流的 error 事件终结连接，不会变成未捕获异常', async (t) => {
  const processErrors = captureProcessErrors();
  t.after(() => processErrors.restore());
  const output = new PassThrough();
  const peer = new JsonRpcPeer({ input: new PassThrough(), output, defaultTimeoutMs: 60_000 });

  const pending = peer.request('model/list');
  output.destroy(new Error('pipe 坏了'));
  await assert.rejects(pending, /codex 连接写入失败/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(processErrors.errors, []);
});
