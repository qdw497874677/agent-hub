import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { asSessionId } from '@agent-hub/domain';
import type { PromptInput, SessionEvent } from '@agent-hub/domain';
import { PiSession } from './pi-runtime.ts';

/**
 * 假 Pi RPC agent：读 stdin 的 JSONL，按脚本回 `response` 和 `agent_settled`。
 * `mode=silent` 只回 ack（进程随后退出）→ 模拟进程在轮中死掉、没有 settled 的情况。
 */
function fakePi(body: string): string {
  return `
process.stdin.setEncoding('utf8');
let buf = '';
const out = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    ${body}
  }
});
`;
}

const TURN = `
    if (msg.type === 'prompt') {
      out({ id: msg.id, type: 'response', success: true, data: { disposition: 'started' } });
      out({ type: 'agent_settled', aborted: false });
      return;
    }
    out({ id: msg.id, type: 'response', success: true, data: {} });
`;

const DIES_MID_TURN = `
    if (msg.type === 'prompt') {
      out({ id: msg.id, type: 'response', success: true, data: { disposition: 'started' } });
      setTimeout(() => process.exit(3), 20);
      return;
    }
    out({ id: msg.id, type: 'response', success: true, data: {} });
`;

/** 启动后立刻报一次 settled（空闲的轮，不属于任何 prompt）。 */
const IDLE_SETTLED = `
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => undefined);
process.stdout.write(JSON.stringify({ type: 'agent_settled', aborted: false }) + '\\n');
`;

/** ack 之后关掉 stdout，进程继续活着：事件流断了不等于进程退出。 */
const DETACH = `
    if (msg.type === 'prompt') {
      out({ id: msg.id, type: 'response', success: true, data: { disposition: 'started' } });
      process.stdout.end();
      setInterval(() => undefined, 1000);
      return;
    }
    out({ id: msg.id, type: 'response', success: true, data: {} });
`;

/** settled 比 prompt 的 ack 先到（启动 / 恢复 / 上一条轮次的迟到通知）：不能认给这条 prompt。 */
const STALE_SETTLED = `
    if (msg.type === 'prompt') {
      out({ type: 'agent_settled', aborted: false });
      out({ id: msg.id, type: 'response', success: true, data: { disposition: 'started' } });
      out({ type: 'agent_settled', aborted: false });
      return;
    }
    out({ id: msg.id, type: 'response', success: true, data: {} });
`;

/**
 * 第一条 prompt 被扩展命令直接吃掉（handled，Pi 不为它跑 agent，没有 settled），
 * 之后来的 settled 是扩展自己触发的后台输出；第二条开始才是真的开一轮。
 */
const HANDLED_THEN_TURN = `
    globalThis.__prompts = (globalThis.__prompts ?? 0) + 1;
    if (msg.type === 'prompt') {
      if (globalThis.__prompts === 1) {
        out({ id: msg.id, type: 'response', success: true, data: { disposition: 'handled' } });
        out({ type: 'agent_settled', aborted: false });
        return;
      }
      out({ id: msg.id, type: 'response', success: true, data: { disposition: 'started' } });
      out({ type: 'agent_settled', aborted: false });
      return;
    }
    out({ id: msg.id, type: 'response', success: true, data: {} });
`;

/** Pi 当时在 streaming：这条被排进后台（queued），随后那次 settled 归属说不清。 */
const QUEUED = `
    if (msg.type === 'prompt') {
      out({ id: msg.id, type: 'response', success: true, data: { disposition: 'queued' } });
      out({ type: 'agent_settled', aborted: false });
      return;
    }
    out({ id: msg.id, type: 'response', success: true, data: {} });
`;

/** 没见过的 disposition / 老版本 Pi 不带这一项：不能当 started 认。 */
const UNKNOWN_DISPOSITION = `
    if (msg.type === 'prompt') {
      out({ id: msg.id, type: 'response', success: true, data: { disposition: 'mystery' } });
      out({ type: 'agent_settled', aborted: false });
      return;
    }
    out({ id: msg.id, type: 'response', success: true, data: {} });
`;

const NO_DISPOSITION = `
    if (msg.type === 'prompt') {
      out({ id: msg.id, type: 'response', success: true });
      out({ type: 'agent_settled', aborted: false });
      return;
    }
    out({ id: msg.id, type: 'response', success: true, data: {} });
`;

async function nextEnded(session: PiSession): Promise<SessionEvent> {
  const iterator = session.events()[Symbol.asyncIterator]();
  return nextFrom(iterator);
}

async function nextFrom(iterator: AsyncIterator<SessionEvent>): Promise<SessionEvent> {
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error('事件流提前结束，没等到 ended');
    if (next.value.kind === 'ended') return next.value;
  }
}

/**
 * 在 `ms` 内等一条 ended；超时返回 null，但**保留**已经挂上的 next()，
 * 下次调用继续用它，避免把随后到达的事件吞进一个没人等的 promise。
 */
function endedReader(events: AsyncIterator<SessionEvent>): (ms: number) => Promise<SessionEvent | null> {
  let pending = events.next();
  return async (ms) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return null;
      const raced = await Promise.race([
        pending.then((next) => ({ kind: 'next' as const, next })),
        new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' as const }), left))
      ]);
      if (raced.kind === 'timeout') return null;
      pending = events.next();
      if (raced.next.done) return null;
      if (raced.next.value.kind === 'ended') return raced.next.value;
    }
  };
}

/** #269/2：送达号是端口上的可选字段，测试里显式带上，等 domain 补字段后类型不用改。 */
function keyed(text: string, deliveryId: string): PromptInput & { readonly deliveryId: string } {
  return { text, parts: [], deliveryId };
}

test('pi runtime: history lookup is unkeyed and cannot report a later prompt as the settled turn', async (t) => {
  const body = `
    if (msg.type === 'prompt') {
      globalThis.count = (globalThis.count ?? 0) + 1;
      out({ id: msg.id, type: 'response', success: true, data: { disposition: 'started' } });
      out({ type: 'agent_settled', aborted: false });
      if (globalThis.pending) { globalThis.pending(); globalThis.pending = null; }
      return;
    }
    if (msg.type === 'get_fork_messages') {
      const snapshot = globalThis.count;
      const respond = () => out({ id: msg.id, type: 'response', success: true, data: { messages: [{ entryId: 'entry-' + snapshot }] } });
      if (snapshot === 1) { globalThis.pending = respond; process.stderr.write('lookup-started\\n'); }
      else respond();
      return;
    }
    out({ id: msg.id, type: 'response', success: true, data: {} });`;
  const child = spawn(process.execPath, ['-e', fakePi(body)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const refs: Array<[string, string | undefined]> = [];
  const session = new PiSession(asSessionId('s-refs'), child, [], undefined, (ref, id) => refs.push([ref, id]));
  t.after(() => child.kill('SIGKILL'));
  const lookupStarted = new Promise<void>((resolve) => child.stderr.once('data', () => resolve()));
  assert.ok((await session.prompt(keyed('one', 'd1'))).ok);
  await lookupStarted;
  assert.ok((await session.prompt(keyed('two', 'd2'))).ok);
  const iterator = session.events()[Symbol.asyncIterator]();
  assert.equal((await nextFrom(iterator)).kind, 'ended');
  assert.equal((await nextFrom(iterator)).kind, 'ended');
  assert.deepEqual(refs, [['entry-2', undefined]]);
});

test('pi runtime: agent_settled 是这一轮的确切终态 → ended 带回同一个 deliveryId；无 key 的轮不带', async (t) => {
  const child = spawn(process.execPath, ['-e', fakePi(TURN)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = new PiSession(asSessionId('s-keyed'), child, []);
  t.after(() => {
    child.kill('SIGKILL');
  });

  assert.ok((await session.prompt(keyed('hi', 'd-pi-1'))).ok);
  assert.deepEqual(await nextEnded(session), { kind: 'ended', outcome: 'done', deliveryId: 'd-pi-1' });

  // 第二条没带 key：settled 仍到，但不能凭空给一个 deliveryId
  assert.ok((await session.prompt({ text: 'again', parts: [] })).ok);
  const bare = await nextEnded(session);
  assert.equal(bare.kind, 'ended');
  assert.equal('deliveryId' in bare, false);
});

test('pi runtime: 空闲的 agent_settled（不是任何 prompt 的终态）不挂 deliveryId', async (t) => {
  const child = spawn(process.execPath, ['-e', IDLE_SETTLED], { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = new PiSession(asSessionId('s-idle'), child, []);
  t.after(() => {
    child.kill('SIGKILL');
  });

  const idle = await nextEnded(session);
  assert.equal(idle.kind, 'ended');
  assert.equal('deliveryId' in idle, false);
});

test('pi runtime: 轮中进程退出（没有 settled）→ 这条 failed ended 仍精确带回 deliveryId', async (t) => {
  const child = spawn(process.execPath, ['-e', fakePi(DIES_MID_TURN)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = new PiSession(asSessionId('s-died'), child, []);
  t.after(() => {
    child.kill('SIGKILL');
  });

  assert.ok((await session.prompt(keyed('hi', 'd-pi-2'))).ok);
  const ended = await nextEnded(session);
  assert.ok(ended.kind === 'ended');
  assert.equal(ended.outcome, 'failed');
  assert.equal(ended.deliveryId, 'd-pi-2');
});

test('pi runtime: stdout 断了但进程还活着 → 不推 ended；真实退出才挂这一轮的 key', async (t) => {
  const child = spawn(process.execPath, ['-e', fakePi(DETACH)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = new PiSession(asSessionId('s-detach'), child, []);
  t.after(() => {
    child.kill('SIGKILL');
  });

  const nextEnded = endedReader(session.events()[Symbol.asyncIterator]());
  assert.ok((await session.prompt(keyed('hi', 'd-pi-3'))).ok);
  // 旧实现会把「读不到 JSONL 了」当成进程退出，立刻推 ended 并挂上 key。
  assert.equal(await nextEnded(300), null, 'stdout 断了不等于进程退出');

  child.kill('SIGKILL');
  const ended = await nextEnded(5000);
  assert.ok(ended && ended.kind === 'ended');
  assert.equal(ended.outcome, 'failed');
  // 进程确实退出了，且这一轮是唯一在飞的一条：key 精确挂给它。
  assert.equal(ended.deliveryId, 'd-pi-3');
});

test('pi runtime: ack 之前到的 settled 不认给这条 prompt（启动 / 恢复的迟到通知）', async (t) => {
  const child = spawn(process.execPath, ['-e', fakePi(STALE_SETTLED)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = new PiSession(asSessionId('s-stale'), child, []);
  t.after(() => {
    child.kill('SIGKILL');
  });

  const nextEnded = endedReader(session.events()[Symbol.asyncIterator]());
  assert.ok((await session.prompt(keyed('hi', 'd-pi-4'))).ok);

  const stale = await nextEnded(2000);
  assert.ok(stale && stale.kind === 'ended');
  assert.equal('deliveryId' in stale, false, 'ack 之前的 settled 不能替这条 prompt 收尾');

  const real = await nextEnded(2000);
  assert.ok(real && real.kind === 'ended');
  assert.equal(real.deliveryId, 'd-pi-4');
});

test('pi runtime: disposition=handled → 立刻报这条投递的终态，不等 settled；后续 prompt 允许', async (t) => {
  const child = spawn(process.execPath, ['-e', fakePi(HANDLED_THEN_TURN)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = new PiSession(asSessionId('s-handled'), child, []);
  t.after(() => {
    child.kill('SIGKILL');
  });

  assert.ok((await session.prompt(keyed('/ext', 'd-pi-6'))).ok);
  // handled 不跑 agent，没有 settled：终态只能现在就报，而且要带这条投递的 key。
  const handledEnd = await nextEnded(session);
  assert.ok(handledEnd.kind === 'ended');
  assert.equal(handledEnd.outcome, 'done');
  assert.equal(handledEnd.deliveryId, 'd-pi-6');

  // 扩展命令自己触发的后台 settled 随后到：与 d-pi-6 无关，也不能替下一条收尾。
  const background = await nextEnded(session);
  assert.ok(background.kind === 'ended');
  assert.equal('deliveryId' in background, false, '扩展的后台 settled 不能挂 key');

  // handled 没占用「这一轮在飞」：下一条 prompt 必须允许。
  assert.ok((await session.prompt(keyed('next', 'd-pi-7'))).ok);
  const next = await nextEnded(session);
  assert.ok(next.kind === 'ended');
  assert.equal(next.deliveryId, 'd-pi-7');
});

test('pi runtime: disposition=queued 的 keyed 投递不按到达顺序认 settled，进程退出才收尾', async (t) => {
  const child = spawn(process.execPath, ['-e', fakePi(QUEUED)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = new PiSession(asSessionId('s-queued'), child, []);
  t.after(() => {
    child.kill('SIGKILL');
  });

  const nextEnded = endedReader(session.events()[Symbol.asyncIterator]());
  assert.ok((await session.prompt(keyed('hi', 'd-pi-5'))).ok);

  // 这条被排进后台的那一轮结束后同样会 settled，但说不清哪条才是它的终态：不能挂 key。
  const untagged = await nextEnded(2000);
  assert.ok(untagged && untagged.kind === 'ended');
  assert.equal('deliveryId' in untagged, false, 'queued 的 keyed 投递不能按到达顺序认 settled');

  // 压着的这条没解掉之前，不再叠下一条。
  assert.equal((await session.prompt(keyed('again', 'd-pi-5b'))).ok, false);

  child.kill('SIGKILL');
  const ended = await nextEnded(5000);
  assert.ok(ended && ended.kind === 'ended');
  assert.equal(ended.outcome, 'failed');
  assert.equal(ended.deliveryId, 'd-pi-5', '进程退出是还能确认的终态');
});

test('pi runtime: 没见过的 disposition 不当成 started —— settled 不挂 key，退出才收尾', async (t) => {
  const child = spawn(process.execPath, ['-e', fakePi(UNKNOWN_DISPOSITION)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = new PiSession(asSessionId('s-unknown'), child, []);
  t.after(() => {
    child.kill('SIGKILL');
  });

  const nextEnded = endedReader(session.events()[Symbol.asyncIterator]());
  assert.ok((await session.prompt(keyed('hi', 'd-pi-8'))).ok);

  const untagged = await nextEnded(2000);
  assert.ok(untagged && untagged.kind === 'ended');
  assert.equal('deliveryId' in untagged, false, 'disposition 不认识就不能当 started 认 settled');

  child.kill('SIGKILL');
  const ended = await nextEnded(5000);
  assert.ok(ended && ended.kind === 'ended');
  assert.equal(ended.deliveryId, 'd-pi-8');
});

test('pi runtime: 老版本 Pi 不带 disposition 的 keyed 应答也不猜 settled，退出才收尾', async (t) => {
  const child = spawn(process.execPath, ['-e', fakePi(NO_DISPOSITION)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = new PiSession(asSessionId('s-legacy'), child, []);
  t.after(() => {
    child.kill('SIGKILL');
  });

  const nextEnded = endedReader(session.events()[Symbol.asyncIterator]());
  assert.ok((await session.prompt(keyed('hi', 'd-pi-9'))).ok);

  const untagged = await nextEnded(2000);
  assert.ok(untagged && untagged.kind === 'ended');
  assert.equal('deliveryId' in untagged, false);

  child.kill('SIGKILL');
  const ended = await nextEnded(5000);
  assert.ok(ended && ended.kind === 'ended');
  assert.equal(ended.deliveryId, 'd-pi-9');
});
