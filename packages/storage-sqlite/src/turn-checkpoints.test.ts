import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteCheckpoints, createSqliteTurnRefs } from './turn-checkpoints.ts';

test('legacy migration, delivery first-write and abort survive database reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checkpoint-test-'));
  const path = join(dir, 'test.sqlite');
  try {
    let db = new DatabaseSync(path);
    db.exec(`CREATE TABLE turn_checkpoints (
      session_id TEXT NOT NULL, turn INTEGER NOT NULL, prompt_seq INTEGER NOT NULL,
      before_sha TEXT NOT NULL, after_sha TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
      files INTEGER, additions INTEGER, deletions INTEGER, PRIMARY KEY (session_id, turn));
      INSERT INTO turn_checkpoints (session_id, turn, prompt_seq, before_sha, started_at)
      VALUES ('s', 1, 2, 'legacy', 1)`);
    let store = createSqliteCheckpoints(db);
    await store.begin({ sessionId: 's', turn: 2, promptSeq: 41, before: 'first', startedAt: 2, deliveryId: 'd' });
    await store.begin({ sessionId: 's', turn: 3, promptSeq: 42, before: 'overwrite', startedAt: 3, deliveryId: 'd' });
    const controller = new AbortController();
    controller.abort();
    await store.begin({ sessionId: 's', turn: 3, promptSeq: 50, before: 'late', startedAt: 3, deliveryId: 'aborted' }, controller.signal);
    await store.end('s', 2, { after: 'after', endedAt: 4, files: 1, additions: 2, deletions: 3 });
    await store.end('s', 2, { after: 'overwritten', endedAt: 5, files: 0, additions: 0, deletions: 0 });
    db.close();

    db = new DatabaseSync(path);
    store = createSqliteCheckpoints(db);
    const rows = await store.list('s');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.deliveryId, undefined);
    assert.deepEqual([rows[1]?.deliveryId, rows[1]?.promptSeq, rows[1]?.before, rows[1]?.after], ['d', 41, 'first', 'after']);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('turn ref legacy migration retains unknown rows and verified first write survives reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turn-ref-test-'));
  const path = join(dir, 'test.sqlite');
  try {
    let db = new DatabaseSync(path);
    db.exec(`CREATE TABLE turn_refs (session_id TEXT NOT NULL, prompt_seq INTEGER NOT NULL, turn_ref TEXT NOT NULL, PRIMARY KEY (session_id, prompt_seq));
      INSERT INTO turn_refs VALUES ('s', 1, 'legacy'), ('s', 2, 'legacy-2')`);
    let refs = createSqliteTurnRefs(db);
    assert.equal((await refs.list('s')).get(1), 'legacy');
    assert.equal((await refs.listVerified!('s')).size, 0);
    await refs.record('s', 1, 'verified', 'd1');
    await refs.record('s', 1, 'conflict', 'd2');
    await refs.record('s', 1, 'different-ref', 'd1');
    await refs.record('s', 2, 'unkeyed', '');
    db.close();
    db = new DatabaseSync(path);
    refs = createSqliteTurnRefs(db);
    assert.deepEqual((await refs.listVerified!('s')).get(1), { turnRef: 'verified', deliveryId: 'd1' });
    assert.equal((await refs.list('s')).get(2), 'legacy-2');
    assert.equal((await refs.listVerified!('s')).has(2), false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
