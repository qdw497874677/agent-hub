import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteMachineObserve, MACHINE_OBSERVE_ID_MAX_BYTES, MACHINE_OBSERVE_RETENTION_MS } from './observe-machine.ts';

test('connection lifecycle is immutable, deduplicated and survives adapter restart', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let store = createSqliteMachineObserve(db);
    const event = { connectionId: 'c', workerId: 'w', origin: 'remote' as const, enrollment: { enrolledBy: 'u', createdAt: 1 }, at: 100 };
    store.append({ ...event, kind: 'disconnected' });
    assert.equal(store.byId('c'), null);
    store.append({ ...event, kind: 'connected', ...{ label: 'secret' } });
    store.append({ ...event, workerId: 'other', kind: 'connected', at: 101 });
    store = createSqliteMachineObserve(db);
    store.append({ ...event, origin: 'local', enrollment: null, kind: 'disconnected', at: 102 });
    store.append({ ...event, enrollment: { enrolledBy: 'u', createdAt: 2 }, kind: 'disconnected', at: 102 });
    assert.equal(store.byId('c')?.disconnectedAt, null);
    store.append({ ...event, kind: 'disconnected', at: 103 });
    store.append({ ...event, kind: 'disconnected', at: 104 });
    assert.equal(store.byId('c')?.disconnectedAt, 103);
    assert.doesNotMatch(JSON.stringify(store.byId('c')), /secret/);
    assert.equal(store.list({ bindings: [{ origin: 'local' }], since: 0, limit: 10 }).length, 0);
    assert.equal(store.list({ bindings: [{ origin: 'remote', workerId: 'w', enrolledBy: 'u', createdAt: 2 }], since: 0, limit: 10 }).length, 0);
    assert.equal(store.list({ bindings: [{ origin: 'remote', workerId: 'w', enrolledBy: 'u', createdAt: 1 }], since: 0, limit: 10 }).length, 1);
    store.append({ connectionId: 'new', workerId: 'w', origin: 'local', enrollment: null, kind: 'connected', at: MACHINE_OBSERVE_RETENTION_MS + 101 });
    assert.equal(store.byId('c'), null);
  } finally { db.close(); }
});

test('authorized bindings filter before limit', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = createSqliteMachineObserve(db);
    store.append({ connectionId: 'visible', workerId: 'w', origin: 'remote', enrollment: { enrolledBy: 'u', createdAt: 1 }, kind: 'connected', at: 1 });
    for (let i = 0; i < 510; i++) store.append({ connectionId: `foreign${i}`, workerId: 'other', origin: 'local', enrollment: null, kind: 'connected', at: 2 });
    assert.equal(store.list({ bindings: [{ origin: 'remote', workerId: 'w', enrolledBy: 'u', createdAt: 1 }], since: 0, limit: 1 })[0]?.id, 'visible');
  } finally { db.close(); }
});

test('observe rejects oversize and malformed identifiers without affecting other connections', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = createSqliteMachineObserve(db);
    const base = { connectionId: 'ok', workerId: 'w', origin: 'remote' as const, enrollment: { enrolledBy: 'u', createdAt: 1 }, kind: 'connected' as const, at: 10 };
    const boundary = '界'.repeat(170) + 'ab'; // 512 UTF-8 bytes
    const over = `${boundary}x`;
    store.append({ ...base, connectionId: boundary, workerId: boundary, enrollment: { enrolledBy: boundary, createdAt: 1 } });
    assert.equal(Buffer.byteLength(boundary), MACHINE_OBSERVE_ID_MAX_BYTES);
    assert.ok(store.byId(boundary));
    for (const bad of [over, '\ud800', 'x\0y', '']) {
      store.append({ ...base, connectionId: bad });
      store.append({ ...base, connectionId: 'bad-worker', workerId: bad });
      store.append({ ...base, connectionId: 'bad-owner', enrollment: { enrolledBy: bad, createdAt: 1 } });
      assert.equal(store.byId(bad), null);
    }
    store.append({ ...base });
    assert.ok(store.byId('ok'));
    assert.equal(store.byId('bad-worker'), null);
    assert.equal(store.byId('bad-owner'), null);
    assert.equal(store.list({ bindings: [{ origin: 'remote', workerId: over, enrolledBy: 'u', createdAt: 1 }, { origin: 'remote', workerId: 'w', enrolledBy: 'u', createdAt: 1 }], since: 0, limit: 10 }).length, 1);
    // Rows written by older versions are not projected.
    db.prepare('INSERT INTO machine_observe_connections VALUES (?, ?, ?, ?, ?, ?, NULL)').run('legacy', over, 'local', null, null, 11);
    assert.equal(store.byId('legacy'), null);
    assert.deepEqual(store.list({ bindings: [{ origin: 'local' }], since: 0, limit: 10 }), []);
  } finally { db.close(); }
});
