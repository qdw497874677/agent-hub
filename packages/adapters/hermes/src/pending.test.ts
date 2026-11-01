import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import type { SessionEvent, SessionId } from '@agent-hub/domain';
import { HermesSession, PENDING_FILE, UNKNOWN_OUTCOME_REASON, readPending } from './hermes-runtime.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
async function fakeHermes(handler: Handler) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
function session(baseUrl: string, home: string) {
  const child = Object.assign(new EventEmitter(), { pid: 1, kill: () => true, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  return new HermesSession('s1' as SessionId, { child, endpoint: { baseUrl, key: 'k', sessionKey: 'ahub-s1' } }, 'm', '', () => undefined, home);
}
async function take(events: AsyncIterable<SessionEvent>, until: (e: SessionEvent) => boolean): Promise<SessionEvent[]> {
  const seen: SessionEvent[] = [];
  for await (const event of events) {
    seen.push(event);
    if (until(event)) break;
  }
  return seen;
}
const exists = (path: string) => access(path).then(() => true, () => false);

test('幂等键：没确认收到就断了，重发同一条沿用同一个键；换一条就换键', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-pending-'));
  const keys: string[] = [];
  let fail = true;
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST') {
      keys.push(String(req.headers['idempotency-key']));
      if (fail) return res.writeHead(500).end('{"error":{"code":"boom"}}');
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"run_id":"r1","status":"started"}');
      return;
    }
    if (req.url?.endsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: {"event":"run.completed"}\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"completed"}');
  });
  try {
    // 「worker」一：提交失败（5xx，不知道收没收到），记下的键留着
    const first = session(hermes.baseUrl, home);
    assert.equal((await first.prompt({ text: 'hi', parts: [] })).ok, false);
    assert.equal((await readPending(home))?.runId, null);
    // 「worker」二（新进程、新会话对象）：同一条输入 → 同一个键
    fail = false;
    const second = session(hermes.baseUrl, home);
    assert.equal((await second.prompt({ text: 'hi', parts: [] })).ok, true);
    assert.equal(keys[1], keys[0]);
    await take(second.events(), (e) => e.kind === 'ended');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await exists(join(home, PENDING_FILE)), false, '有了结局就清掉');
    // 换一条输入 → 新键
    fail = true;
    await session(hermes.baseUrl, home).prompt({ text: 'other', parts: [] });
    assert.notEqual(keys[2], keys[0]);
  } finally {
    await hermes.close();
  }
});

test('对账：重启前那一轮结果未知 → 诊断 + 交给人的 interrupted；已完成 → 只记诊断', async () => {
  for (const [status, expectEnded] of [['unknown', true], ['completed', false]] as const) {
    const home = await mkdtemp(join(tmpdir(), 'hermes-reconcile-'));
    await writeFile(join(home, PENDING_FILE), JSON.stringify({ key: 'k1', inputHash: 'h', runId: 'r9', at: 1 }));
    const hermes = await fakeHermes((req, res) => {
      assert.equal(req.url, '/v1/runs/r9');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status }));
    });
    try {
      const s = session(hermes.baseUrl, home);
      await s.reconcile();
      assert.equal(await exists(join(home, PENDING_FILE)), false);
      const seen = await take(s.events(), (e) => (expectEnded ? e.kind === 'ended' : e.kind === 'diagnostic'));
      const ended = seen.find((e) => e.kind === 'ended');
      if (expectEnded) assert.deepEqual(ended, { kind: 'ended', outcome: 'interrupted', reason: UNKNOWN_OUTCOME_REASON });
      else assert.equal(ended, undefined);
    } finally {
      await hermes.close();
    }
  }
});
