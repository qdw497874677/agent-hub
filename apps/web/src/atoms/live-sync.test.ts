import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntryDto, SessionDto } from '@agent-hub/contract';
import type { Frame, LiveMap } from './live-core.ts';
import { LiveSync } from './live-sync.ts';

const session = { id: 's', status: 'running', lastSeq: 1 } as SessionDto;
const entry = (seq: number, delta: string): JournalEntryDto => ({ seq, at: 0, event: { kind: 'text', delta } });
const frame = (seq: number, delta: string): Frame => ({ sessionId: 's', seq, event: { kind: 'text', delta }, status: 'running' });
function fixture(maxFrames?: number) {
  const requests: { after: number | undefined; resolve: (value: readonly JournalEntryDto[]) => void; reject: () => void }[] = [];
  let live: LiveMap = {};
  let sync: Readonly<Record<string, 'syncing' | 'stale'>> = {};
  let history: Readonly<Record<string, 'loading' | 'loaded' | 'error'>> = {};
  const coordinator = new LiveSync((_id, after) => new Promise((resolve, reject) => { requests.push({ after, resolve, reject }); }), (l, s, h) => { live = l; sync = s; history = h; }, maxFrames);
  return { coordinator, requests, get live() { return live; }, get sync() { return sync; }, get history() { return history; } };
}
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

test('reconnect fences newer and duplicate frames until missing history is installed', async () => {
  const f = fixture();
  f.coordinator.seed([session], { s: [entry(1, 'a')] });
  f.coordinator.open();
  assert.equal(f.requests[0]?.after, 1);
  f.coordinator.frame(frame(3, 'c'));
  f.coordinator.frame(frame(3, 'c'));
  f.requests[0]!.resolve([entry(2, 'b'), entry(3, 'c')]);
  await flush();
  assert.deepEqual(f.live.s?.blocks, [{ kind: 'text', text: 'abc', seq: 3 }]);
  assert.equal(f.sync.s, undefined);
});

test('full history retains its older prefix and replays newer delta', async () => {
  const f = fixture();
  f.coordinator.open();
  f.coordinator.seed([session], { s: [entry(2, 'b')] });
  const load = f.coordinator.loadHistory(session);
  f.coordinator.frame(frame(3, 'c'));
  assert.equal(f.requests[0]?.after, undefined);
  f.requests[0]!.resolve([entry(1, 'a'), entry(2, 'b')]);
  await load;
  assert.deepEqual(f.live.s?.blocks, [{ kind: 'text', text: 'abc', seq: 3 }]);
  assert.equal(f.history.s, 'loaded');
});

test('failed catch-up keeps rows and cursor, retries once, then replays queued frames', async () => {
  const f = fixture();
  f.coordinator.seed([session], { s: [entry(1, 'a')] });
  f.coordinator.open();
  f.coordinator.frame(frame(3, 'c'));
  f.requests[0]!.reject();
  await flush();
  assert.equal(f.sync.s, 'stale');
  assert.equal(f.live.s?.lastSeq, 1);
  f.coordinator.frame(frame(4, 'd'));
  f.coordinator.retrySync('s');
  f.coordinator.retrySync('s');
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1]?.after, 1);
  f.requests[1]!.resolve([entry(2, 'b')]);
  await flush();
  assert.deepEqual(f.live.s?.blocks, [{ kind: 'text', text: 'abcd', seq: 4 }]);
  assert.equal(f.sync.s, undefined);
});

test('old reconnect generation cannot publish or clear the newer generation', async () => {
  const f = fixture();
  f.coordinator.seed([session], { s: [entry(1, 'a')] });
  f.coordinator.open();
  f.coordinator.disconnect();
  f.coordinator.open();
  f.coordinator.frame(frame(3, 'c'));
  f.requests[0]!.resolve([entry(2, 'wrong')]);
  await flush();
  assert.equal(f.sync.s, 'syncing');
  assert.equal(f.live.s?.lastSeq, 1);
  f.requests[1]!.resolve([entry(2, 'b')]);
  await flush();
  assert.deepEqual(f.live.s?.blocks, [{ kind: 'text', text: 'abc', seq: 3 }]);
});

test('same-sequence status frames do not advance the cursor and override completed history', async () => {
  const f = fixture();
  f.coordinator.seed([session], { s: [entry(1, 'a')] });
  f.coordinator.open();
  f.coordinator.frame({ sessionId: 's', seq: 2, event: null, status: 'done' });
  f.requests[0]!.resolve([{ seq: 2, at: 0, event: { kind: 'ended', outcome: 'done' } }]);
  await flush();
  assert.equal(f.live.s?.status, 'done');
  assert.equal(f.live.s?.lastSeq, 2);
  assert.equal(f.live.s?.awaiting, false);
  f.coordinator.frame({ sessionId: 's', seq: 3, event: null, status: 'running' });
  assert.equal(f.live.s?.lastSeq, 2);
  f.coordinator.frame(frame(3, 'b'));
  assert.equal(f.live.s?.lastSeq, 3);
});

test('buffer overflow triggers a full read before publishing', async () => {
  const f = fixture(1);
  f.coordinator.seed([session], { s: [entry(1, 'a')] });
  f.coordinator.open();
  f.coordinator.frame(frame(2, 'b'));
  f.coordinator.frame(frame(3, 'c'));
  f.requests[0]!.resolve([entry(2, 'b')]);
  await flush();
  assert.equal(f.requests[1]?.after, undefined);
  assert.equal(f.live.s?.lastSeq, 1);
  f.requests[1]!.resolve([entry(1, 'a'), entry(2, 'b'), entry(3, 'c')]);
  await flush();
  assert.equal(f.live.s?.lastSeq, 3);
  assert.equal(f.sync.s, undefined);
});

test('history lifecycle folds prompt after done and approval after ended', async () => {
  const f = fixture();
  f.coordinator.seed([{ ...session, status: 'done' }], { s: [entry(1, 'a')] });
  f.coordinator.open();
  f.requests[0]!.resolve([{ seq: 2, at: 0, event: { kind: 'prompt', text: 'again' } }]);
  await flush();
  assert.equal(f.live.s?.status, 'running');
  assert.equal(f.live.s?.awaiting, true);
  const load = f.coordinator.loadHistory(session);
  f.requests[1]!.resolve([
    entry(1, 'a'),
    { seq: 2, at: 0, event: { kind: 'prompt', text: 'again' } },
    { seq: 3, at: 0, event: { kind: 'ended', outcome: 'done' } },
    { seq: 4, at: 0, event: { kind: 'approval', phase: 'request', id: 'a', title: 'allow' } }
  ]);
  await load;
  assert.equal(f.live.s?.status, 'done');
  assert.equal(f.live.s?.awaiting, false);
});

test('full reconciliation keeps keyed unknown evidence nonterminal until its matching end', async () => {
  for (const marker of [true, false, null]) {
    const f = fixture();
    const prompt: JournalEntryDto = { seq: 1, at: 0, event: { kind: 'prompt', text: 'work' } };
    const unknown: JournalEntryDto = { seq: 2, at: 0, event: { kind: 'ended', outcome: 'interrupted', deliveryId: 'a', outcomeUnknown: marker } as JournalEntryDto['event'] };
    const ended: JournalEntryDto = { seq: 3, at: 0, event: { kind: 'ended', outcome: 'done', deliveryId: 'a' } };
    f.coordinator.seed([session], { s: [prompt] });
    const load = f.coordinator.loadHistory(session);
    assert.equal(f.requests[0]?.after, undefined);
    f.requests[0]!.resolve([prompt, unknown]);
    await load;
    assert.equal(f.live.s?.status, 'running');
    assert.equal(f.live.s?.awaiting, true);
    assert.deepEqual(f.live.s?.uncertainDeliveryIds, ['a']);
    assert.deepEqual(f.live.s?.endedDeliveryIds, []);
    assert.deepEqual(f.live.s?.blocks.map((block) => block.kind), ['prompt']);
    const reload = f.coordinator.loadHistory(session);
    f.requests[1]!.resolve([prompt, unknown, ended]);
    await reload;
    assert.equal(f.live.s?.status, 'done');
    assert.equal(f.live.s?.awaiting, false);
    assert.deepEqual(f.live.s?.uncertainDeliveryIds, []);
    assert.deepEqual(f.live.s?.endedDeliveryIds, ['a']);
  }
});

test('offline full history loads while freshness stays stale until stream reconciliation', async () => {
  const f = fixture();
  const load = f.coordinator.loadHistory(session);
  assert.equal(f.requests.length, 1);
  f.requests[0]!.resolve([entry(1, 'a')]);
  await load;
  assert.equal(f.history.s, 'loaded');
  assert.equal(f.sync.s, 'stale');
  f.coordinator.open();
  assert.equal(f.requests[1]?.after, 1);
  f.requests[1]!.resolve([]);
  await flush();
  assert.equal(f.sync.s, undefined);
});

test('consecutive seed and full load coalesce into a single full read', async () => {
  const f = fixture();
  f.coordinator.open();
  f.coordinator.seed([session], { s: [entry(1, 'a')] });
  const load = f.coordinator.loadHistory(session);
  await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.after, undefined);
  f.requests[0]!.resolve([entry(1, 'a')]);
  await load;
  assert.equal(f.history.s, 'loaded');
});

test('disconnect during a full read preserves the full request on reconnect', async () => {
  const f = fixture();
  f.coordinator.open();
  const load = f.coordinator.loadHistory(session);
  f.coordinator.disconnect();
  f.coordinator.open();
  assert.equal(f.requests[1]?.after, undefined);
  f.requests[0]!.resolve([entry(1, 'old')]);
  await load;
  assert.equal(f.sync.s, 'syncing');
  f.requests[1]!.resolve([entry(1, 'new')]);
  await flush();
  assert.equal(f.history.s, 'loaded');
  assert.deepEqual(f.live.s?.blocks, [{ kind: 'text', text: 'new', seq: 1 }]);
});
