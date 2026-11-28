import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createDevelopmentPreviewStore, type DevelopmentPreviewReservation } from './development-preview-store.ts';

const service = { id: 'service-1', workerId: 'worker-1', workspaceId: 'workspace-1', root: '/workspace/project', cwd: '/workspace/project/app', port: 3000, listenerIdentity: 'listener-1' };
const range = { from: 18000, to: 18001 };

test('reservations survive reopening exactly and ports are never reassigned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'development-preview-'));
  const path = join(dir, 'hub.db');
  let db = new DatabaseSync(path);
  try {
    let store = createDevelopmentPreviewStore(db);
    const first = store.reserve(service, range);
    const second = store.reserve({ ...service, id: 'service-2', port: 3001 }, range);
    assert.deepEqual(first, { ...service, hubPort: 18000 });
    assert.deepEqual(second, { ...service, id: 'service-2', port: 3001, hubPort: 18001 });
    assert.equal(store.reserve({ ...service, id: 'service-3' }, range), null);
    db.close();
    db = new DatabaseSync(path);
    store = createDevelopmentPreviewStore(db);
    assert.deepEqual(store.byService(service.id), first);
    assert.deepEqual(store.byPort(18001), second);
    assert.deepEqual(store.list(), [first, second]);
    assert.deepEqual(store.reserve(service, { from: 19000, to: 19001 }), first);
    assert.equal(store.reserve({ ...service, id: 'service-3' }, range), null);
    assert.equal(store.byService('missing'), null);
    assert.equal(store.byPort(18002), null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same id with any differing identity field fails closed without mutation', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = createDevelopmentPreviewStore(db);
    const first = store.reserve(service, range);
    const changes: Partial<Omit<DevelopmentPreviewReservation, 'hubPort'>>[] = [
      { workerId: 'worker-2' }, { workspaceId: 'workspace-2' }, { root: '/other' }, { cwd: '/workspace/project/other' },
      { port: 3001 }, { listenerIdentity: 'listener-2' },
    ];
    for (const change of changes) assert.equal(store.reserve({ ...service, ...change }, range), null);
    assert.deepEqual(store.list(), [first]);
    assert.deepEqual(store.reserve(service, range), first);
  } finally { db.close(); }
});

test('invalid ranges and ports fail closed without reserving a port', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = createDevelopmentPreviewStore(db);
    for (const invalid of [{ from: 0, to: 1 }, { from: 1, to: 65536 }, { from: 2, to: 1 }, { from: 1.5, to: 3 }, { from: NaN, to: 3 }]) {
      assert.equal(store.reserve(service, invalid), null);
    }
    assert.equal(store.reserve({ ...service, port: 0 }, range), null);
    assert.deepEqual(store.list(), []);
    assert.equal(store.reserve(service, range)?.hubPort, 18000);
  } finally { db.close(); }
});
