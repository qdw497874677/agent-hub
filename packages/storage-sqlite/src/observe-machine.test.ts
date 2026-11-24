import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteMachineObserve, MACHINE_OBSERVE_ID_MAX_BYTES, MACHINE_OBSERVE_INSTALL_PER_CONNECTION, MACHINE_OBSERVE_INSTALL_MAX_ROWS, MACHINE_OBSERVE_RETENTION_MS } from './observe-machine.ts';

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
    db.prepare('INSERT INTO machine_observe_connections(connection_id,worker_id,origin,enrolled_by,enrollment_created_at,connected_at,disconnected_at) VALUES (?, ?, ?, ?, ?, ?, NULL)').run('legacy', over, 'local', null, null, 11);
    assert.equal(store.byId('legacy'), null);
    assert.deepEqual(store.list({ bindings: [{ origin: 'local' }], since: 0, limit: 10 }), []);
  } finally { db.close(); }
});

test('install reports require an exact open connection and have stable independent ids', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let store = createSqliteMachineObserve(db);
    const connection = { connectionId: 'c', workerId: 'w', origin: 'remote' as const, enrollment: { enrolledBy: 'u', createdAt: 1 }, at: 10 };
    const report = { ...connection, action: 'install' as const, state: 'succeeded' as const, at: 11 };
    store.appendInstall(report);
    assert.deepEqual(store.installs('c'), { items: [], truncated: false });
    store.append({ ...connection, kind: 'connected' });
    for (const event of [{ ...report, connectionId: 'missing' }, { ...report, workerId: 'wrong' }, { ...report, origin: 'local' as const, enrollment: null }, { ...report, enrollment: { enrolledBy: 'u', createdAt: 2 } }, { ...report, at: 9 }, { ...report, workerId: 'x'.repeat(513) }]) store.appendInstall(event);
    assert.equal(store.installs('c').items.length, 0);
    store.appendInstall({ ...report, ...{ jobId: 'secret', name: 'secret', error: 'secret' } });
    store.appendInstall({ ...report, state: 'failed' });
    store = createSqliteMachineObserve(db);
    const items = store.installs('c').items;
    assert.equal(items.length, 2);
    assert.notEqual(items[0]?.id, items[1]?.id);
    assert.deepEqual(items.map((r) => r.state), ['failed', 'succeeded']);
    assert.doesNotMatch(JSON.stringify(items), /secret/);
    store.append({ ...connection, kind: 'disconnected', at: 12 });
    store.appendInstall({ ...report, state: 'refused', at: 13 });
    assert.equal(store.installs('c').items.length, 2);
  } finally { db.close(); }
});

test('install retention caps report rows, preserves truncation and removes reports with connection', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = createSqliteMachineObserve(db);
    const c = { connectionId: 'c', workerId: 'w', origin: 'local' as const, enrollment: null, at: 1 };
    store.append({ ...c, kind: 'connected' });
    for (let i = 0; i < MACHINE_OBSERVE_INSTALL_PER_CONNECTION + 1; i++) store.appendInstall({ ...c, action: 'install', state: 'refused' });
    assert.equal(store.installs('c').items.length, MACHINE_OBSERVE_INSTALL_PER_CONNECTION);
    assert.equal(store.installs('c').truncated, true);
    assert.equal((db.prepare('SELECT count(*) AS n FROM machine_observe_install_truncations').get() as { n: number }).n, 1);
    // Simulate an existing populated database to exercise the global cap in one append.
    const insert = db.prepare('INSERT INTO machine_observe_installs(connection_id,state,at) VALUES (?, ?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < MACHINE_OBSERVE_INSTALL_MAX_ROWS; i++) insert.run('c', 'failed', 1);
    db.exec('COMMIT');
    store.append({ ...c, connectionId: 'other', kind: 'connected' });
    store.appendInstall({ ...c, connectionId: 'other', action: 'install', state: 'succeeded' });
    assert.equal((db.prepare('SELECT count(*) AS n FROM machine_observe_installs').get() as { n: number }).n, MACHINE_OBSERVE_INSTALL_MAX_ROWS);
    store.append({ ...c, connectionId: 'fresh', kind: 'connected', at: MACHINE_OBSERVE_RETENTION_MS + 2 });
    assert.equal(store.byId('c'), null);
    assert.equal((db.prepare('SELECT count(*) AS n FROM machine_observe_installs').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM machine_observe_install_truncations').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('previous seven-column positional insert remains compatible after initialization and reopen', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let store = createSqliteMachineObserve(db);
    assert.equal(db.prepare('PRAGMA table_info(machine_observe_connections)').all().length, 7);
    db.prepare('INSERT OR IGNORE INTO machine_observe_connections VALUES (?, ?, ?, ?, ?, ?, NULL)').run('old-connection', 'w', 'remote', 'u', 1, 10);
    store.appendInstall({ connectionId: 'old-connection', workerId: 'w', origin: 'remote', enrollment: { enrolledBy: 'u', createdAt: 1 }, action: 'install', state: 'succeeded', at: 11 });
    store = createSqliteMachineObserve(db);
    assert.equal(store.byId('old-connection')?.connectedAt, 10);
    assert.deepEqual(store.installs('old-connection').items.map((r) => r.state), ['succeeded']);
    db.prepare('INSERT OR IGNORE INTO machine_observe_connections VALUES (?, ?, ?, ?, ?, ?, NULL)').run('after-reopen', 'w', 'local', null, null, 12);
    assert.ok(store.byId('after-reopen'));
  } finally { db.close(); }
});

test('column-based development database preserves existing truncation markers without schema removal', () => {
  const db = new DatabaseSync(':memory:');
  try {
    createSqliteMachineObserve(db);
    db.exec("ALTER TABLE machine_observe_connections ADD COLUMN installs_truncated INTEGER NOT NULL DEFAULT 0; INSERT INTO machine_observe_connections VALUES ('old', 'w', 'local', NULL, NULL, 1, NULL, 1)");
    const store = createSqliteMachineObserve(db);
    assert.equal(store.installs('old').truncated, true);
    assert.equal(db.prepare('PRAGMA table_info(machine_observe_connections)').all().length, 8);
  } finally { db.close(); }
});
