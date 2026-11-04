import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { SessionProvenance } from '@agent-hub/domain';
import { createSqliteProvenance } from './provenance.ts';

const p = (sessionId: string, over: Partial<SessionProvenance> = {}): SessionProvenance => ({
  id: `p-${sessionId}`, sessionId, taskId: 't', actor: { kind: 'user', id: 'u1', name: 'David' }, via: 'web', parent: null,
  authority: { role: 'owner' }, backfilled: false, createdAt: 10, ...over
});

test('来历：老会话按 origin 回填并标补录；只写一次，表上 UPDATE 被触发器挡住', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, task_id TEXT, origin_kind TEXT, origin_session TEXT, origin_seq INTEGER, created_at INTEGER)`);
  db.exec(`INSERT INTO sessions VALUES ('old1','t','derive',NULL,NULL,1), ('old2','t','fork','old1',4,2)`);
  const store = createSqliteProvenance(db);
  const a = await store.get('old1');
  assert.equal(a?.backfilled, true);
  assert.equal(a?.via, 'web');
  assert.equal(a?.actor.kind, 'system');
  const b = await store.get('old2');
  assert.deepEqual(b?.parent, { sessionId: 'old1', atSeq: 4 });
  assert.equal(b?.via, 'fork');

  assert.equal(await store.record(p('s1')), true);
  assert.equal(await store.record(p('s1', { actor: { kind: 'user', id: 'x', name: '冒名' } })), false);
  assert.equal((await store.get('s1'))?.actor.name, 'David');
  assert.throws(() => db.exec("UPDATE session_provenance SET actor_name = 'x' WHERE session_id = 's1'"), /immutable/);
  // 再开一次不重复回填
  createSqliteProvenance(db);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_provenance').get() as { n: number }).n, 3);
});
