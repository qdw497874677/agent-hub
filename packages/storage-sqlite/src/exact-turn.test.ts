import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteExactTurn, EXACT_TURN_ROW_LIMIT } from './exact-turn.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE journal(session_id TEXT, seq INTEGER, type TEXT, payload TEXT, turn INTEGER, PRIMARY KEY(session_id,seq));
    CREATE TABLE message_delivery(id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, kind TEXT, state TEXT, attempt INTEGER);`);
  const event = (s: string, seq: number, type: string, payload: unknown, turn = 1) => db.prepare('INSERT INTO journal VALUES(?,?,?,?,?)').run(s, seq, type, typeof payload === 'string' ? payload : JSON.stringify(payload), turn);
  const delivery = (id: string, s: string, seq: number, state = 'sending', attempt = 0) => db.prepare("INSERT INTO message_delivery VALUES(?,?,?,'prompt',?,?)").run(id, s, seq, state, attempt);
  return { db, event, delivery, read: createSqliteExactTurn(db) };
}

test('exact identity follows prompt and delivery, not ended turn; no raw content', () => {
  const f = fixture();
  f.event('s', 1, 'prompt', { kind: 'prompt', text: 'private prompt' }, 1); f.delivery('a', 's', 1, 'delivered', 1);
  f.event('s', 2, 'prompt', { kind: 'prompt' }, 2); f.delivery('b', 's', 2, 'queued');
  f.event('s', 3, 'ended', { kind: 'ended', deliveryId: 'a', outcome: 'done', reason: 'private reason' }, 2);
  assert.deepEqual(f.read('s', 1), { sessionId:'s', turn:1, promptSeq:1, deliveryId:'a', deliveryState:'delivered', outcome:'done', outcomeUnknown:false, endedSeq:3, status:'terminal', reason:'ended' });
  assert.equal(f.read('s', 2).status, 'pending');
  assert.equal(f.read('other', 1).status, 'unknown');
  f.db.close();
});

test('unknown dominates missing, conflicting, late duplicate, retry and malformed evidence', () => {
  const f = fixture(); f.event('s', 1, 'prompt', {kind:'prompt'}, 1); f.delivery('a', 's', 1);
  assert.equal(f.read('s', 1).status, 'pending');
  f.event('s', 2, 'ended', { kind:'ended', deliveryId:'other', outcome:'done' });
  assert.equal(f.read('s', 1).status, 'pending');
  f.event('s', 3, 'ended', { kind:'ended', deliveryId:'a', outcome:'done' });
  assert.equal(f.read('s', 1).status, 'unknown');
  f.db.prepare("UPDATE message_delivery SET state='delivered',attempt=1 WHERE id='a'").run();
  assert.equal(f.read('s', 1).status, 'terminal');
  f.event('s', 4, 'ended', { kind:'ended', deliveryId:'a', outcome:'failed' });
  assert.equal(f.read('s', 1).reason, 'contradictory_end');
  f.db.prepare('DELETE FROM journal WHERE seq=4').run();
  f.db.prepare('UPDATE journal SET payload=? WHERE seq=3').run(JSON.stringify({kind:'ended',deliveryId:'a',outcome:'done',outcomeUnknown:false}));
  assert.equal(f.read('s', 1).reason, 'outcome_unknown');
  f.db.prepare('UPDATE journal SET payload=? WHERE seq=3').run('{bad');
  assert.equal(f.read('s', 1).reason, 'unattributed_end');
  f.db.prepare('DELETE FROM journal WHERE seq=3').run();
  f.db.prepare("UPDATE message_delivery SET attempt=2,state='delivered'").run();
  assert.equal(f.read('s', 1).reason, 'retry_ambiguous');
  f.db.prepare("UPDATE message_delivery SET attempt=0,state='queued'").run();
  f.delivery('b','s',1);
  assert.equal(f.read('s', 1).reason, 'ambiguous_delivery');
  f.db.close();
});

test('bounded scans and validation fail closed', () => {
  const f = fixture(); f.event('s', 1, 'prompt', {kind:'prompt'}, 1); f.delivery('a', 's', 1);
  for (let i=2; i<=EXACT_TURN_ROW_LIMIT+1; i++) f.event('s', i, 'prompt', {}, i);
  assert.equal(f.read('s', 1).reason, 'scan_limit');
  assert.equal(f.read('s', 0).reason, 'invalid_input');
  assert.equal(f.read('x'.repeat(513), 1).reason, 'invalid_input');
  f.db.close();
});
