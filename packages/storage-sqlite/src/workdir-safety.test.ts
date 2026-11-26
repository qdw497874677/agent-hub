import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createWorkdirSafety } from './workdir-safety.ts';
import type { WorkdirTerminal } from '@agent-hub/domain';

const terminal = (overrides: Partial<WorkdirTerminal> = {}): WorkdirTerminal => ({
  id: 't1', requestId: 'r1', ownerId: 'u1', projectId: 'p1', workspaceId: 'w1', workerId: 'worker1',
  cwd: '/work/one', epoch: null, state: 'pending', createdAt: 1, updatedAt: 1, ...overrides
});

test('startup drain sees pending null-epoch terminals and durable fences, not ended records', () => {
  let db = new DatabaseSync(':memory:');
  let { safety, terminals } = createWorkdirSafety(db);
  assert.equal(safety.hasOutstanding(), false);
  terminals.create(terminal());
  assert.equal(safety.hasOutstanding(), true);
  terminals.transition('t1', 'pending', null, 'running', 'epoch-1', 2);
  assert.equal(safety.hasOutstanding(), true);
  terminals.transition('t1', 'running', 'epoch-1', 'closing', 'epoch-1', 3);
  assert.equal(safety.hasOutstanding(), true);
  terminals.transition('t1', 'closing', 'epoch-1', 'ended', 'epoch-1', 4);
  assert.equal(safety.hasOutstanding(), false);
  const fence = safety.beginRemoval({ workspaceId: 'w', workerId: null, cwd: '/work' });
  const snapshot = db.serialize(); db.close();
  db = new DatabaseSync(':memory:'); db.deserialize(snapshot);
  ({ safety } = createWorkdirSafety(db));
  assert.equal(safety.hasOutstanding(), true);
  safety.finishRemoval(fence);
  assert.equal(safety.hasOutstanding(), false);
  db.close();
  assert.throws(() => safety.hasOutstanding());
});

test('terminal intents, scoped idempotency, exact epoch CAS and occupancy survive SQLite restart', () => {
  {
    let db = new DatabaseSync(':memory:');
    let { terminals, safety } = createWorkdirSafety(db);
    assert.deepEqual(terminals.create(terminal()), terminal());
    assert.deepEqual(terminals.create(terminal({ id: 'other' })), terminal());
    assert.throws(() => terminals.create(terminal({ cwd: '/other' })), /target conflict/);
    terminals.create(terminal({ id: 't2', ownerId: 'u2', projectId: 'p2' }));
    assert.equal(terminals.transition('t1', 'pending', null, 'pending', 'epoch-1', 2)?.epoch, 'epoch-1');
    assert.equal(terminals.transition('t1', 'pending', null, 'running', 'epoch-1', 3), null);
    assert.throws(() => terminals.transition('t1', 'pending', 'epoch-1', 'running', 'epoch-2', 3), /invalid/);
    assert.equal(terminals.transition('t1', 'pending', 'epoch-1', 'running', 'epoch-1', 3)?.state, 'running');
    let snapshot = db.serialize();
    db.close();
    db = new DatabaseSync(':memory:');
    db.deserialize(snapshot);
    ({ terminals, safety } = createWorkdirSafety(db));
    assert.equal(terminals.listNonEnded().length, 2);
    assert.equal(terminals.listByOwner('u1').length, 1);
    assert.equal(terminals.listByWorkspace('w1').length, 2);
    assert.equal(terminals.listByProject('p1')[0]?.epoch, 'epoch-1');
    assert.throws(() => safety.assertProjectUnoccupied('p1'), /occupied/);
    assert.doesNotThrow(() => safety.assertProjectUnoccupied('unrelated'));
    assert.throws(() => safety.assertUnoccupied({ workspaceId: 'unrelated', workerId: 'worker1', cwd: '/different' }), /occupied/);
    assert.throws(() => safety.assertUnoccupied({ workspaceId: 'unrelated', workerId: null, cwd: '/different' }), /occupied/);
    assert.doesNotThrow(() => safety.assertUnoccupied({ workspaceId: 'unrelated', workerId: 'worker2', cwd: '/different' }));
    assert.throws(() => safety.beginRemoval({ workspaceId: 'unrelated', workerId: 'worker2', cwd: '/different' }), /physical removal deferred/);
    terminals.transition('t1', 'running', 'epoch-1', 'ended', 'epoch-1', 4);
    terminals.transition('t2', 'pending', null, 'ended', null, 4);
    const fence = safety.beginRemoval({ workspaceId: 'w', workerId: 'worker2', cwd: '/different' });
    snapshot = db.serialize();
    db.close();
    db = new DatabaseSync(':memory:');
    db.deserialize(snapshot);
    ({ safety } = createWorkdirSafety(db));
    assert.throws(() => safety.assertNoRemoval({ workspaceId: 'w3', workerId: 'worker3', cwd: '/other' }), /pending anywhere/);
    safety.finishRemoval(fence);
    assert.doesNotThrow(() => safety.assertNoRemoval({ workspaceId: 'w3', workerId: 'worker3', cwd: '/other' }));
    assert.throws(() => safety.assertNoRemoval({ workspaceId: 'w3', workerId: 'worker3', cwd: 'C:\\work' }), /unknown/);
    db.close();
  }
});

test('lease serializes asynchronous admission and removal decisions', async () => {
  const db = new DatabaseSync(':memory:');
  const { safety, terminals } = createWorkdirSafety(db);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const first = safety.runExclusive(async () => { entered(); await waiting; terminals.create(terminal()); });
  await started;
  let fenceStarted = false;
  const second = safety.runExclusive(() => { fenceStarted = true; return safety.beginRemoval({ workspaceId: 'w2', workerId: 'worker2', cwd: '/else' }); });
  await Promise.resolve();
  assert.equal(fenceStarted, false);
  release();
  await first;
  await assert.rejects(second, /physical removal deferred/);
  db.close();
});
