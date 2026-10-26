import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createRpcChannel, type RpcChannel } from './channel.ts';
import { RpcFailure } from './port.ts';
import type { RpcFrame } from './frames.ts';

const echo = { name: 'echo', params: z.object({ n: z.number() }), result: z.object({ n: z.number() }) };
const slow = { name: 'slow', params: z.object({}), result: z.object({}) };

/** 两端直连；drop=true 时吞掉 a→b 的帧，模拟对端不回。 */
function pair(options: { drop?: boolean; timeoutMs?: number } = {}) {
  const sent: RpcFrame[] = [];
  const ends: RpcChannel[] = [];
  ends.push(
    createRpcChannel({
      idPrefix: 'a',
      timeoutMs: options.timeoutMs ?? 1000,
      send: (frame) => {
        sent.push(frame);
        if (!options.drop) queueMicrotask(() => ends[1]!.receive(frame));
        return true;
      }
    })
  );
  ends.push(createRpcChannel({ idPrefix: 'b', send: (frame) => (queueMicrotask(() => ends[0]!.receive(frame)), true) }));
  return { a: ends[0]!, b: ends[1]!, sent };
}

test('rpc：请求-回复按 id 对上；参数 / 结果都按 schema 校验', async () => {
  const { a, b } = pair();
  b.handle(echo, async ({ n }) => ({ n: n * 2 }));
  assert.deepEqual(await a.request(echo, { n: 2 }), { ok: true, value: { n: 4 } });
  assert.equal((await a.request(echo, { n: 'x' } as never)).ok === false, true);
  const bad = await a.request(echo, { n: 'x' } as never);
  assert.equal(!bad.ok && bad.error.code, 'bad_params');
  const unknown = await a.request(slow, {});
  assert.equal(!unknown.ok && unknown.error.code, 'unknown_method');
});

test('rpc：handler 抛 RpcFailure 透传 code，别的错一律 failed', async () => {
  const { a, b } = pair();
  b.handle(echo, async ({ n }) => {
    if (n === 1) throw new RpcFailure('forbidden', '不行');
    throw new Error('boom');
  });
  const forbidden = await a.request(echo, { n: 1 });
  assert.equal(!forbidden.ok && forbidden.error.code, 'forbidden');
  const failed = await a.request(echo, { n: 2 });
  assert.equal(!failed.ok && failed.error.code, 'failed');
});

test('rpc：超时发 cancel；主动取消也发 cancel；对端 handler 的 signal 会被触发', async () => {
  const timed = pair({ drop: true, timeoutMs: 20 });
  const outcome = await timed.a.request(slow, {});
  assert.equal(!outcome.ok && outcome.error.code, 'timeout');
  assert.ok(timed.sent.some((frame) => frame.rpc === 'cancel'));

  const { a, b } = pair();
  let aborted = false;
  b.handle(slow, (_params, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => ((aborted = true), resolve({})))));
  const controller = new AbortController();
  const pending = a.request(slow, {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const cancelled = await pending;
  assert.equal(!cancelled.ok && cancelled.error.code, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aborted, true);
});

test('rpc：通道关了，在途请求以 closed 结束；发不出去也是 closed', async () => {
  const { a } = pair({ drop: true });
  const pending = a.request(slow, {});
  a.close('断线');
  const closed = await pending;
  assert.equal(!closed.ok && closed.error.code, 'closed');
  const dead = createRpcChannel({ send: () => false });
  const unsent = await dead.request(slow, {});
  assert.equal(!unsent.ok && unsent.error.code, 'closed');
});
