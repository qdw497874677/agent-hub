import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
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

test('fresh runs mark only their first assistant text, never child text or unkeyed runs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-first-output-'));
  let run = 0;
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ run_id: `r${++run}`, status: 'started' }));
      return;
    }
    if (req.url?.endsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        { event: 'reasoning.delta', delta: 'thinking' },
        { event: 'tool.started', tool: 'search' },
        { event: 'message.delta', delta: 'child', child_session_id: 'child-1' },
        { event: 'message.delta', delta: 'user', role: 'user' },
        { event: 'message.delta', delta: '' },
        { event: 'message.delta', delta: 'first', ...(run === 2 ? { role: 'assistant' } : {}) },
        { event: 'message.interim', text: 'second', role: 'assistant' },
        { event: 'run.completed' }
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const s = session(hermes.baseUrl, home);
    for (const deliveryId of ['delivery-a', 'delivery-b', undefined]) {
      assert.equal((await s.prompt({ text: 'hi', parts: [], ...(deliveryId ? { deliveryId } : {}) })).ok, true);
      const events = await take(s.events(), (e) => e.kind === 'ended');
      assert.deepEqual(events.filter((e) => e.kind === 'text'), [
        { kind: 'text', delta: 'child', textOrigin: 'other' },
        { kind: 'text', delta: 'user', textOrigin: 'other' },
        { kind: 'text', delta: 'first', ...(run === 2 ? { textOrigin: 'main_assistant' } : {}), ...(deliveryId ? { firstOutputDeliveryId: deliveryId } : {}) },
        { kind: 'text', delta: 'second', textOrigin: 'main_assistant' }
      ]);
      assert.deepEqual(events.at(-1), { kind: 'ended', outcome: 'done', ...(deliveryId ? { deliveryId } : {}) });
    }
  } finally {
    await hermes.close();
  }
});

test('reconnect and reconciliation never mark replayed text', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-first-reconnect-'));
  let streams = 0;
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"run_id":"r1","status":"started"}');
      return;
    }
    if (req.url === '/v1/runs/r1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (++streams === 1) return res.end('data: {"event":"reasoning.delta","delta":"thinking"}\n\n');
      return res.end('data: {"event":"message.delta","delta":"replayed","role":"assistant"}\n\ndata: {"event":"message.delta","delta":"child","subagent_id":"c"}\n\ndata: {"event":"run.completed"}\n\n');
    }
    if (req.url === '/v1/runs/r1') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"running"}');
    res.writeHead(404).end();
  });
  try {
    const s = session(hermes.baseUrl, home);
    assert.equal((await s.prompt({ text: 'hi', parts: [], deliveryId: 'delivery-r' })).ok, true);
    const events = await take(s.events(), (e) => e.kind === 'ended');
    assert.deepEqual(events.filter((e) => e.kind === 'text'), [{ kind: 'text', delta: 'replayed', textOrigin: 'main_assistant' }, { kind: 'text', delta: 'child', textOrigin: 'other' }]);
    assert.deepEqual(events.at(-1), { kind: 'ended', outcome: 'done', deliveryId: 'delivery-r' });

    const resumedHome = await mkdtemp(join(tmpdir(), 'hermes-first-resume-'));
    await writeFile(join(resumedHome, PENDING_FILE), JSON.stringify({ key: 'k', inputHash: 'h', runId: 'r1', at: 1, deliveryId: 'delivery-resumed' }));
    const resumed = session(hermes.baseUrl, resumedHome);
    await resumed.reconcile();
    const resumedEvents = await take(resumed.events(), (e) => e.kind === 'ended');
    assert.deepEqual(resumedEvents.filter((e) => e.kind === 'text'), [{ kind: 'text', delta: 'replayed', textOrigin: 'main_assistant' }, { kind: 'text', delta: 'child', textOrigin: 'other' }]);
    assert.deepEqual(resumedEvents.at(-1), { kind: 'ended', outcome: 'done', deliveryId: 'delivery-resumed' });
  } finally {
    await hermes.close();
  }
});

test('an internally retried submission cannot mark its first stream', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-first-submit-retry-'));
  let posts = 0;
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/runs') {
      if (++posts === 1) return res.writeHead(503, { 'retry-after': '0.001' }).end();
      return res.writeHead(202, { 'content-type': 'application/json' }).end('{"run_id":"r1","status":"started"}');
    }
    if (req.url === '/v1/runs/r1/events') {
      return res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: {"event":"message.delta","delta":"possibly replayed"}\n\ndata: {"event":"run.completed"}\n\n');
    }
    res.writeHead(404).end();
  });
  try {
    const s = session(hermes.baseUrl, home);
    assert.equal((await s.prompt({ text: 'hi', parts: [], deliveryId: 'delivery-retry' })).ok, true);
    const events = await take(s.events(), (e) => e.kind === 'ended');
    assert.equal(posts, 2);
    assert.deepEqual(events.filter((e) => e.kind === 'text'), [{ kind: 'text', delta: 'possibly replayed' }]);
    assert.deepEqual(events.at(-1), { kind: 'ended', outcome: 'done', deliveryId: 'delivery-retry' });
  } finally {
    await hermes.close();
  }
});

test('a successful idempotency replay response cannot mark its first stream', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-first-header-replay-'));
  let posts = 0;
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/runs') {
      posts++;
      return res.writeHead(202, { 'content-type': 'application/json', 'Idempotency-Replayed': 'true' }).end('{"run_id":"r1","status":"started"}');
    }
    if (req.url === '/v1/runs/r1/events') {
      return res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: {"event":"message.delta","delta":"replayed","role":"assistant"}\n\ndata: {"event":"message.delta","delta":" text","role":"user"}\n\ndata: {"event":"run.completed"}\n\n');
    }
    res.writeHead(404).end();
  });
  try {
    const s = session(hermes.baseUrl, home);
    assert.equal((await s.prompt({ text: 'hi', parts: [], deliveryId: 'delivery-replay' })).ok, true);
    const events = await take(s.events(), (e) => e.kind === 'ended');
    assert.equal(posts, 1);
    assert.deepEqual(events.filter((e) => e.kind === 'text'), [{ kind: 'text', delta: 'replayed', textOrigin: 'main_assistant' }, { kind: 'text', delta: ' text', textOrigin: 'other' }]);
    assert.deepEqual(events.at(-1), { kind: 'ended', outcome: 'done', deliveryId: 'delivery-replay' });
  } finally {
    await hermes.close();
  }
});

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
    // 结束事件先发出，清理持久文件随后异步完成；等待真正的文件状态而不是固定延时。
    const deadline = performance.now() + 5_000;
    const pendingPath = join(home, PENDING_FILE);
    while (await exists(pendingPath) && performance.now() < deadline) await delay(25);
    assert.equal(await exists(pendingPath), false, '有了结局就清掉');
    // 换一条输入 → 新键
    fail = true;
    await session(hermes.baseUrl, home).prompt({ text: 'other', parts: [] });
    assert.notEqual(keys[2], keys[0]);
  } finally {
    await hermes.close();
  }
});

test('确认终态：run.completed 的 ended 带上这次送达的 deliveryId', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-tagged-'));
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"run_id":"r1","status":"started"}');
      return;
    }
    if (req.url === '/v1/runs/r1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"event":"run.completed"}\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const s = session(hermes.baseUrl, home);
    assert.equal((await s.prompt({ text: 'hi', parts: [], deliveryId: 'delivery-1' })).ok, true);
    const ended = (await take(s.events(), (e) => e.kind === 'ended')).find((e) => e.kind === 'ended');
    assert.deepEqual(ended, { kind: 'ended', outcome: 'done', deliveryId: 'delivery-1' });
  } finally {
    await hermes.close();
  }
});

test('状态查询确认终态也带 deliveryId：流断了但 GET 说 completed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-tagged-status-'));
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"run_id":"r2","status":"started"}');
      return;
    }
    if (req.url === '/v1/runs/r2/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end();
      return;
    }
    if (req.url === '/v1/runs/r2') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"completed"}');
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const s = session(hermes.baseUrl, home);
    assert.equal((await s.prompt({ text: 'hi', parts: [], deliveryId: 'delivery-2' })).ok, true);
    const ended = (await take(s.events(), (e) => e.kind === 'ended')).find((e) => e.kind === 'ended');
    assert.deepEqual(ended, { kind: 'ended', outcome: 'done', deliveryId: 'delivery-2' });
  } finally {
    await hermes.close();
  }
});

test('结果未知：精确送达只发诊断，本地仍挡住下一句', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-untagged-'));
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"run_id":"r3","status":"started"}');
      return;
    }
    if (req.url === '/v1/runs/r3/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end();
      return;
    }
    if (req.url === '/v1/runs/r3') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"unknown"}');
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const s = session(hermes.baseUrl, home);
    assert.equal((await s.prompt({ text: 'hi', parts: [], deliveryId: 'delivery-3' })).ok, true);
    const seen = await take(s.events(), (e) => e.kind === 'diagnostic' && e.uncertainDeliveryId === 'delivery-3');
    assert.deepEqual(seen, [{ kind: 'diagnostic', level: 'warn', text: '暂未确认这一轮的结果', uncertainDeliveryId: 'delivery-3' }]);
    // 结局未知不等于停了：这一轮的记录还在，下一句也不能被放进来（fail closed）。
    assert.equal((await readPending(home))?.runId, 'r3');
    const next = await s.prompt({ text: 'again', parts: [] });
    assert.equal(next.ok, false);
    assert.equal(next.ok ? '' : next.error.code, 'conflict');
  } finally {
    await hermes.close();
  }
});

test('没有 deliveryId 的输入行为不变：ended 不带 id', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-unkeyed-'));
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"run_id":"r4","status":"started"}');
      return;
    }
    if (req.url === '/v1/runs/r4/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"event":"run.completed"}\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const s = session(hermes.baseUrl, home);
    assert.equal((await s.prompt({ text: 'hi', parts: [] })).ok, true);
    const ended = (await take(s.events(), (e) => e.kind === 'ended')).find((e) => e.kind === 'ended');
    assert.deepEqual(ended, { kind: 'ended', outcome: 'done' });
  } finally {
    await hermes.close();
  }
});

test('网关进程退出不证明远端停了：那条 ended 不带 deliveryId', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-exit-'));
  const open: ServerResponse[] = [];
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"run_id":"r5","status":"started"}');
      return;
    }
    if (req.url === '/v1/runs/r5/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      open.push(res);
      return;
    }
    res.writeHead(404).end();
  });
  const child = Object.assign(new EventEmitter(), { pid: 1, kill: () => true, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  const s = new HermesSession('s1' as SessionId, { child, endpoint: { baseUrl: hermes.baseUrl, key: 'k', sessionKey: 'ahub-s1' } }, 'm', '', () => undefined, home);
  try {
    assert.equal((await s.prompt({ text: 'hi', parts: [], deliveryId: 'delivery-5' })).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 50)); // 让事件流先连上
    child.emit('exit', 1, null);
    const ended = (await take(s.events(), (e) => e.kind === 'ended')).find((e) => e.kind === 'ended');
    assert.deepEqual(ended, { kind: 'ended', outcome: 'interrupted', reason: 'Hermes 网关退出了（1）' });
  } finally {
    for (const res of open) res.destroy();
    await hermes.close();
  }
});

test('对账结果未知：记录留着，本地闸门挡住下一句', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-reconcile-unknown-'));
  await writeFile(join(home, PENDING_FILE), JSON.stringify({ key: 'k9', inputHash: 'h9', runId: 'r9', at: 1, deliveryId: 'delivery-9' }));
  const hermes = await fakeHermes((req, res) => {
    assert.equal(req.url, '/v1/runs/r9');
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"unknown"}');
  });
  try {
    const s = session(hermes.baseUrl, home);
    await s.reconcile();
    const seen = await take(s.events(), (e) => e.kind === 'diagnostic');
    assert.deepEqual(seen, [{ kind: 'diagnostic', level: 'warn', text: '暂未确认这一轮的结果', uncertainDeliveryId: 'delivery-9' }]);
    const kept = await readPending(home);
    assert.equal(kept?.runId, 'r9');
    assert.equal(kept?.key, 'k9');
    assert.equal(kept?.deliveryId, 'delivery-9');
    const next = await s.prompt({ text: 'next', parts: [] });
    assert.equal(next.ok, false);
    assert.equal(next.ok ? '' : next.error.code, 'conflict');
    assert.equal((await readPending(home))?.runId, 'r9', '未知结局不能被一次失败的提交删掉');
  } finally {
    await hermes.close();
  }
});

test('对账未取得 run id 的精确送达：只报告未知，保留提交占位，不自动提交', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-reconcile-held-'));
  const pending = { key: 'held-key', inputHash: 'held-hash', runId: null, at: 1, deliveryId: 'held-delivery' };
  await writeFile(join(home, PENDING_FILE), JSON.stringify(pending));
  let requests = 0;
  const hermes = await fakeHermes((_req, res) => { requests++; res.writeHead(500).end(); });
  try {
    const s = session(hermes.baseUrl, home);
    await s.reconcile();
    assert.deepEqual(await take(s.events(), (e) => e.kind === 'diagnostic'), [
      { kind: 'diagnostic', level: 'warn', text: '暂未确认这一轮的结果', uncertainDeliveryId: 'held-delivery' }
    ]);
    assert.deepEqual(await readPending(home), pending);
    const other = await s.prompt({ text: 'different', parts: [], deliveryId: 'other' });
    assert.equal(other.ok ? '' : other.error.code, 'conflict');
    await s.interrupt();
    assert.deepEqual(await readPending(home), pending);
    assert.equal(requests, 0);
  } finally {
    await hermes.close();
  }
});

test('对账不认识的状态保留记录和闸门，按原送达归属报告未知', async () => {
  for (const [statusBody, deliveryId] of [
    ['{"status":"new-status"}', 'original'],
    ['{"status":null}', undefined]
  ] as const) {
    const home = await mkdtemp(join(tmpdir(), 'hermes-reconcile-novel-'));
    const pending = { key: 'k', inputHash: 'h', runId: 'r', at: 1, ...(deliveryId ? { deliveryId } : {}) };
    await writeFile(join(home, PENDING_FILE), JSON.stringify(pending));
    const requests: string[] = [];
    const hermes = await fakeHermes((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(statusBody);
    });
    try {
      const s = session(hermes.baseUrl, home);
      await s.reconcile();
      const seen = await take(s.events(), (e) => e.kind === (deliveryId ? 'diagnostic' : 'ended'));
      assert.deepEqual(seen, deliveryId
        ? [{ kind: 'diagnostic', level: 'warn', text: '暂未确认这一轮的结果', uncertainDeliveryId: deliveryId }]
        : [{ kind: 'ended', outcome: 'interrupted', reason: UNKNOWN_OUTCOME_REASON, outcomeUnknown: true }]);
      assert.deepEqual(await readPending(home), pending);
      const next = await s.prompt({ text: 'different', parts: [], deliveryId: 'other' });
      assert.equal(next.ok ? '' : next.error.code, 'conflict');
      assert.deepEqual(requests, ['GET /v1/runs/r']);
    } finally {
      await hermes.close();
    }
  }
});

test('对账查不到状态：精确报告未知，重启后真实终态仍归属原送达', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-reconcile-missing-'));
  await writeFile(join(home, PENDING_FILE), JSON.stringify({ key: 'k', inputHash: 'h', runId: 'r', at: 1, deliveryId: 'original' }));
  let available = false;
  let posts = 0;
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST') posts++;
    if (!available) return res.writeHead(503).end();
    return res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"completed"}');
  });
  try {
    const first = session(hermes.baseUrl, home);
    await first.reconcile();
    assert.deepEqual(await take(first.events(), (e) => e.kind === 'diagnostic'), [
      { kind: 'diagnostic', level: 'warn', text: '暂未确认这一轮的结果', uncertainDeliveryId: 'original' }
    ]);
    assert.equal((await first.prompt({ text: 'wrong turn', parts: [], deliveryId: 'other' })).ok, false);
    assert.equal(posts, 0);
    available = true;
    const resumed = session(hermes.baseUrl, home);
    await resumed.reconcile();
    assert.deepEqual(await take(resumed.events(), (e) => e.kind === 'ended'), [
      { kind: 'ended', outcome: 'done', deliveryId: 'original' }
    ]);
    assert.equal(await readPending(home), null);
  } finally {
    await hermes.close();
  }
});

test('没有送达 id 的未知结果保留旧标记并带结构化字段', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-unknown-legacy-'));
  await writeFile(join(home, PENDING_FILE), JSON.stringify({ key: 'k', inputHash: 'h', runId: 'r', at: 1 }));
  const hermes = await fakeHermes((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"unknown"}'));
  try {
    const s = session(hermes.baseUrl, home);
    await s.reconcile();
    assert.deepEqual(await take(s.events(), (e) => e.kind === 'ended'), [
      { kind: 'ended', outcome: 'interrupted', reason: UNKNOWN_OUTCOME_REASON, outcomeUnknown: true }
    ]);
    assert.equal((await readPending(home))?.runId, 'r');
  } finally {
    await hermes.close();
  }
});

test('流返回 unknown 且没有送达 id 时仍能给旧 Hub 展示', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-stream-legacy-'));
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST') return res.writeHead(202, { 'content-type': 'application/json' }).end('{"run_id":"r","status":"started"}');
    if (req.url?.endsWith('/events')) return res.writeHead(200, { 'content-type': 'text/event-stream' }).end();
    return res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"unknown"}');
  });
  try {
    const s = session(hermes.baseUrl, home);
    assert.equal((await s.prompt({ text: 'one', parts: [] })).ok, true);
    assert.deepEqual(await take(s.events(), (e) => e.kind === 'ended'), [
      { kind: 'ended', outcome: 'interrupted', reason: UNKNOWN_OUTCOME_REASON, outcomeUnknown: true }
    ]);
    assert.equal((await readPending(home))?.runId, 'r');
  } finally {
    await hermes.close();
  }
});

test('事件流重连耗尽：精确未知诊断，不结束或重新提交', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-exhausted-'));
  let streams = 0;
  let posts = 0;
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST') {
      posts++;
      return res.writeHead(202, { 'content-type': 'application/json' }).end('{"run_id":"r","status":"started"}');
    }
    if (req.url?.endsWith('/events')) {
      streams++;
      return res.writeHead(200, { 'content-type': 'text/event-stream' }).end();
    }
    return res.writeHead(503).end();
  });
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== undefined && ms >= 1000 && ms <= 10000) return originalTimeout(callback, 0, ...args);
    return originalTimeout(callback, ms, ...args);
  }) as typeof setTimeout);
  try {
    const s = session(hermes.baseUrl, home);
    assert.equal((await s.prompt({ text: 'one', parts: [], deliveryId: 'd' })).ok, true);
    assert.deepEqual(await take(s.events(), (e) => e.kind === 'diagnostic'), [
      { kind: 'diagnostic', level: 'warn', text: '暂未确认这一轮的结果', uncertainDeliveryId: 'd' }
    ]);
    assert.equal(streams, 20);
    assert.equal(posts, 1);
    assert.equal((await readPending(home))?.deliveryId, 'd');
    assert.equal((await s.prompt({ text: 'other', parts: [], deliveryId: 'other' })).ok, false);
  } finally {
    t.mock.restoreAll();
    await hermes.close();
  }
});

test('对账确认终态（老记录没有 deliveryId）：只记诊断并清记录', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-reconcile-legacy-'));
  await writeFile(join(home, PENDING_FILE), JSON.stringify({ key: 'k1', inputHash: 'h', runId: 'r9', at: 1 }));
  const hermes = await fakeHermes((req, res) => {
    assert.equal(req.url, '/v1/runs/r9');
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"completed"}');
  });
  try {
    const s = session(hermes.baseUrl, home);
    await s.reconcile();
    const seen = await take(s.events(), (e) => e.kind === 'diagnostic');
    assert.equal(seen.find((e) => e.kind === 'ended'), undefined);
    assert.equal(await exists(join(home, PENDING_FILE)), false);
  } finally {
    await hermes.close();
  }
});

test('对账确认终态（带 deliveryId）：补一条 tagged ended 并清记录', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-reconcile-tagged-'));
  await writeFile(join(home, PENDING_FILE), JSON.stringify({ key: 'k2', inputHash: 'h2', runId: 'r10', at: 1, deliveryId: 'delivery-10' }));
  const hermes = await fakeHermes((req, res) => {
    assert.equal(req.url, '/v1/runs/r10');
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"failed"}');
  });
  try {
    const s = session(hermes.baseUrl, home);
    await s.reconcile();
    const ended = (await take(s.events(), (e) => e.kind === 'ended')).find((e) => e.kind === 'ended');
    assert.deepEqual(ended, { kind: 'ended', outcome: 'failed', reason: 'Hermes 报告失败', deliveryId: 'delivery-10' });
    assert.equal(await exists(join(home, PENDING_FILE)), false);
  } finally {
    await hermes.close();
  }
});

test('对账未知后点停：只有查实终态才收掉；停失败 / 状态仍未知都继续挡着', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-reconcile-cancel-'));
  await writeFile(join(home, PENDING_FILE), JSON.stringify({ key: 'k11', inputHash: 'h11', runId: 'r11', at: 1, deliveryId: 'delivery-11' }));
  let status = 'unknown';
  let stopOk = false;
  let stops = 0;
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/runs/r11/stop') {
      stops += 1;
      res.writeHead(stopOk ? 200 : 500, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"run_id":"r12","status":"started"}');
      return;
    }
    if (req.url === '/v1/runs/r12/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"event":"run.completed"}\n\n');
      return;
    }
    if (req.url === '/v1/runs/r11') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status }));
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const s = session(hermes.baseUrl, home);
    await s.reconcile();
    await take(s.events(), (e) => e.kind === 'diagnostic' && e.uncertainDeliveryId === 'delivery-11');

    // stop 失败：查状态还是 unknown → 记录和闸门都留着
    await s.interrupt();
    assert.equal(stops, 1);
    assert.equal((await readPending(home))?.runId, 'r11');
    assert.equal((await readPending(home))?.deliveryId, 'delivery-11');
    const blocked1 = await s.prompt({ text: 'after cancel', parts: [], deliveryId: 'delivery-12' });
    assert.equal(blocked1.ok ? '' : blocked1.error.code, 'conflict');

    // stop 只是 ack、状态仍未知 → 同样不算停
    stopOk = true;
    await s.interrupt();
    assert.equal(stops, 2);
    assert.equal((await readPending(home))?.runId, 'r11');
    const blocked2 = await s.prompt({ text: 'after cancel', parts: [], deliveryId: 'delivery-12' });
    assert.equal(blocked2.ok ? '' : blocked2.error.code, 'conflict');

    // 查到同一个 run 已 cancelled：补一条带 deliveryId 的 ended，清记录、放开闸门
    status = 'cancelled';
    await s.interrupt();
    assert.equal(stops, 3);
    const ended = (await take(s.events(), (e) => e.kind === 'ended')).find((e) => e.kind === 'ended');
    assert.deepEqual(ended, { kind: 'ended', outcome: 'stopped', deliveryId: 'delivery-11' });
    assert.equal(await exists(join(home, PENDING_FILE)), false);
    const next = await s.prompt({ text: 'after cancel', parts: [], deliveryId: 'delivery-12' });
    assert.equal(next.ok, true);
    const nextEnded = (await take(s.events(), (e) => e.kind === 'ended')).find((e) => e.kind === 'ended');
    assert.deepEqual(nextEnded, { kind: 'ended', outcome: 'done', deliveryId: 'delivery-12' });
  } finally {
    await hermes.close();
  }
});

test('并发提交只放行一条', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-concurrent-'));
  let posts = 0;
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/runs') {
      posts += 1;
      setTimeout(() => {
        if (res.writableEnded) return;
        res.writeHead(202, { 'content-type': 'application/json' }).end('{"run_id":"r12","status":"started"}');
      }, 50);
      return;
    }
    if (req.url === '/v1/runs/r12/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"event":"run.completed"}\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const s = session(hermes.baseUrl, home);
    const [a, b] = await Promise.all([
      s.prompt({ text: 'one', parts: [], deliveryId: 'd-one' }),
      s.prompt({ text: 'two', parts: [], deliveryId: 'd-two' })
    ]);
    assert.equal([a, b].filter((r) => r.ok).length, 1);
    const rejected = [a, b].find((r) => !r.ok);
    assert.equal(rejected?.ok === false ? rejected.error.code : '', 'conflict');
    assert.equal(posts, 1, '提交窗口只能有一条在飞');
    await take(s.events(), (e) => e.kind === 'ended');
  } finally {
    await hermes.close();
  }
});

test('提交结果未知：点停也不丢记录，只放同一条、同一条送达重发', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-submit-unknown-'));
  const keys: string[] = [];
  let posts = 0;
  const hermes = await fakeHermes((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/runs') {
      posts += 1;
      keys.push(String(req.headers['idempotency-key']));
      if (posts === 1) {
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"code":"boom"}}');
        return;
      }
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"run_id":"r13","status":"started"}');
      return;
    }
    if (req.url === '/v1/runs/r13/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"event":"message.delta","delta":"possibly replayed"}\n\ndata: {"event":"run.completed"}\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const s = session(hermes.baseUrl, home);
    const first = await s.prompt({ text: 'one', parts: [], deliveryId: 'd-one' });
    assert.equal(first.ok, false);
    assert.equal(first.ok ? '' : first.error.code, 'unavailable');
    assert.ok(keys[0]);
    const kept = await readPending(home);
    assert.equal(kept?.runId, null);
    assert.equal(kept?.deliveryId, 'd-one');
    // 用户点停：没有 run id 就没有「停掉」的证据，记录和预约都留着
    await s.interrupt();
    assert.equal((await readPending(home))?.key, kept?.key);
    assert.equal((await readPending(home))?.deliveryId, 'd-one');
    assert.equal(posts, 1);
    const blocked = await s.prompt({ text: 'two', parts: [] });
    assert.equal(blocked.ok ? '' : blocked.error.code, 'conflict');
    assert.equal(posts, 1, '没确认的提交之后不能发别的内容');
    // 同一条文字、换 deliveryId：不能把结局记到另一条送达上
    const wrongOwner = await s.prompt({ text: 'one', parts: [], deliveryId: 'd-two' });
    assert.equal(wrongOwner.ok ? '' : wrongOwner.error.code, 'conflict');
    assert.equal((await readPending(home))?.deliveryId, 'd-one');
    assert.equal(posts, 1);
    // 「worker」重启后也只能原样重发同一个键、同一条送达
    const restarted = session(hermes.baseUrl, home);
    await restarted.reconcile();
    const wrongOwnerAfterRestart = await restarted.prompt({ text: 'one', parts: [], deliveryId: 'd-two' });
    assert.equal(wrongOwnerAfterRestart.ok ? '' : wrongOwnerAfterRestart.error.code, 'conflict');
    assert.equal((await readPending(home))?.deliveryId, 'd-one');
    const retry = await restarted.prompt({ text: 'one', parts: [], deliveryId: 'd-one' });
    assert.equal(retry.ok, true);
    assert.equal(keys[1], keys[0], '同一条重发要沿用幂等键');
    const events = await take(restarted.events(), (e) => e.kind === 'ended');
    assert.deepEqual(events.filter((e) => e.kind === 'text'), [{ kind: 'text', delta: 'possibly replayed' }]);
    const ended = events.find((e) => e.kind === 'ended');
    assert.deepEqual(ended, { kind: 'ended', outcome: 'done', deliveryId: 'd-one' });
  } finally {
    await hermes.close();
  }
});
