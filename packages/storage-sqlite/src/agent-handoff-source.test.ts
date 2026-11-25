import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_HANDOFF_SOURCE_BUDGET, AGENT_HANDOFF_SOURCE_BYTES, installAgentHandoffSourceIndexes, prepareAgentHandoffSource } from './agent-handoff-source.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, last_seq INTEGER, agent_session TEXT);
    CREATE TABLE journal (session_id TEXT, seq INTEGER, type TEXT, payload TEXT, PRIMARY KEY(session_id,seq));
    CREATE TABLE message_delivery (id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, kind TEXT, state TEXT, attempt INTEGER);
    CREATE TABLE agent_messages (target_session_id TEXT, status TEXT);
    CREATE TABLE branch_attempt (session_id TEXT, state TEXT);
    INSERT INTO sessions VALUES ('s',0,'native-ref');`);
  installAgentHandoffSourceIndexes(db);
  const cursor = (n: number) => db.prepare('UPDATE sessions SET last_seq=? WHERE id=?').run(n, 's');
  const event = (seq: number, type: string, payload: unknown) => db.prepare('INSERT INTO journal VALUES (?,?,?,?)').run('s', seq, type, typeof payload === 'string' ? payload : JSON.stringify(payload));
  const delivery = (id: string, seq: number, state = 'delivered', kind = 'prompt', attempt = 1) => db.prepare('INSERT INTO message_delivery VALUES (?,?,?,?,?,?)').run(id, 's', seq, kind, state, attempt);
  const proof = (n: number) => prepareAgentHandoffSource(db, 's', n);
  const prompt = (seq: number, id: string) => { event(seq, 'prompt', { kind: 'prompt', text: 'private' }); delivery(id, seq); };
  const end = (seq: number, id: string, outcome = 'done') => event(seq, 'ended', { kind: 'ended', deliveryId: id, outcome });
  return { db, cursor, event, delivery, proof, prompt, end };
}

test('empty, cursor mismatch, newer journal and missing schema fail closed', () => {
  const f = fixture();
  assert.deepEqual(f.proof(0), { kind: 'ready', cursor: 0 });
  assert.deepEqual(f.proof(1), { kind: 'cursor_changed' });
  assert.deepEqual(prepareAgentHandoffSource(f.db, 'missing', 0), { kind: 'missing' });
  f.event(1, 'text', { kind: 'text' });
  assert.equal(f.proof(0).kind, 'unproven');
  f.db.exec('DROP TABLE agent_messages');
  f.cursor(1);
  assert.equal(f.proof(1).kind, 'unproven');
  f.db.close();
});

test('overlapping exact A/B/C completions, transaction window, and unrelated sessions', () => {
  const f = fixture();
  f.db.exec('BEGIN IMMEDIATE');
  f.event(1, 'prompt', { kind: 'prompt', text: 'private' }); f.cursor(1);
  assert.equal(f.proof(1).kind, 'unproven');
  f.delivery('A', 1); f.prompt(2, 'B'); f.end(3, 'A'); f.prompt(4, 'C'); f.end(5, 'C'); f.end(6, 'B'); f.cursor(6);
  f.db.prepare('INSERT INTO journal VALUES (?,?,?,?)').run('other', 1, 'prompt', '{');
  assert.deepEqual(f.proof(6), { kind: 'ready', cursor: 6 });
  f.db.exec('ROLLBACK'); f.db.close();
});

test('busy queue, inbound and branches, including legacy brief', () => {
  for (const state of ['queued', 'sending', 'undelivered', 'held']) {
    const f = fixture(); f.delivery('x', 1, state, 'handoff_brief'); f.cursor(1);
    assert.equal(f.proof(1).kind, 'busy'); f.db.close();
  }
  for (const status of ['queued', 'held', 'awaiting_approval', 'delivered']) {
    const f = fixture(); f.db.prepare('INSERT INTO agent_messages VALUES (?,?)').run('s', status);
    assert.equal(f.proof(0).kind, 'busy'); f.db.close();
  }
  for (const state of ['pending', 'both_failed', 'garbage', 'native']) {
    const f = fixture(); f.db.prepare('INSERT INTO branch_attempt VALUES (?,?)').run('s', state);
    if (state === 'native') f.db.exec("UPDATE sessions SET agent_session='pending'");
    assert.equal(f.proof(0).kind, ['pending', 'both_failed'].includes(state) ? 'busy' : 'unproven'); f.db.close();
  }
});

test('historical evidence is exact and cancellation is not a no-send receipt', () => {
  const cases: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.event(1, 'prompt', { kind: 'prompt' }); },
    f => { f.delivery('a', 1); },
    f => { f.prompt(1, 'a'); f.delivery('b', 1); f.end(2, 'a'); },
    f => { f.prompt(1, 'a'); f.end(2, 'a'); f.end(3, 'a'); },
    f => { f.prompt(1, 'a'); f.end(2, 'wrong'); },
    f => { f.prompt(1, 'a'); f.event(2, 'ended', { kind: 'ended', outcome: 'done' }); },
    f => { f.end(1, 'a'); f.prompt(2, 'a'); },
    f => { f.prompt(1, 'a'); f.event(2, 'ended', { kind: 'ended', deliveryId: 'a', outcome: 'interrupted', reason: 'outcome_unknown' }); },
    f => { f.event(1, 'prompt', '{'); f.delivery('a', 1); f.end(2, 'a'); },
    f => { f.event(1, 'prompt', { kind: 'prompt' }); f.delivery('a', 1, 'cancelled', 'prompt', 0); },
    f => { f.prompt(1, 'a'); f.end(2, 'a'); f.event(3, 'ended', '{'); },
  ];
  for (const setup of cases) {
    const f = fixture(); setup(f);
    const max = f.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM journal').get() as { n: number };
    f.cursor(Math.max(1, max.n));
    assert.equal(f.proof(Math.max(1, max.n)).kind, 'unproven'); f.db.close();
  }
});

test('stopped is a known outcome and aggregate event bytes are bounded', () => {
  const f = fixture(); f.prompt(1, 'a'); f.end(2, 'a', 'stopped'); f.cursor(2);
  assert.equal(f.proof(2).kind, 'ready'); f.db.close();
  const g = fixture();
  const n = 20;
  for (let i=0; i<n; i++) {
    g.event(2*i+1, 'prompt', { kind:'prompt', text:'x'.repeat(Math.ceil(AGENT_HANDOFF_SOURCE_BYTES/n)) });
    g.delivery(`d${i}`,2*i+1); g.end(2*i+2,`d${i}`);
  }
  g.cursor(2*n); assert.equal(g.proof(2*n).kind, 'unproven'); g.db.close();
  const h = fixture();
  for (let i=0; i<n; i++) h.event(i+1, 'text', { kind:'text', delta:'x'.repeat(Math.ceil(AGENT_HANDOFF_SOURCE_BYTES/n)) });
  h.prompt(n+1,'d'); h.end(n+2,'d'); h.cursor(n+2);
  assert.equal(h.proof(n+2).kind, 'ready'); h.db.close();
  const many = fixture();
  for (let i=0; i<AGENT_HANDOFF_SOURCE_BUDGET+10; i++) many.event(i+1,'text',{kind:'text',delta:'stream'});
  many.prompt(AGENT_HANDOFF_SOURCE_BUDGET+11,'d'); many.end(AGENT_HANDOFF_SOURCE_BUDGET+12,'d'); many.cursor(AGENT_HANDOFF_SOURCE_BUDGET+12);
  assert.equal(many.proof(AGENT_HANDOFF_SOURCE_BUDGET+12).kind, 'ready'); many.db.close();
});

test('old orphan cannot be hidden by recent completed turns; fixed budget fails closed', () => {
  const f = fixture(); f.event(1, 'prompt', { kind: 'prompt' });
  for (let i = 0; i < 30; i++) { f.prompt(2 + i * 2, `d${i}`); f.end(3 + i * 2, `d${i}`); }
  f.cursor(61); assert.equal(f.proof(61).kind, 'unproven'); f.db.close();
  const g = fixture();
  for (let i = 0; i < AGENT_HANDOFF_SOURCE_BUDGET + 1; i++) g.event(i + 1, 'prompt', { kind: 'prompt' });
  g.cursor(AGENT_HANDOFF_SOURCE_BUDGET + 1); assert.equal(g.proof(AGENT_HANDOFF_SOURCE_BUDGET + 1).kind, 'unproven'); g.db.close();
});

test('installed covering predicates use session indexes and old schema does not throw', () => {
  const f = fixture();
  for (const sql of [
    "SELECT seq FROM journal INDEXED BY handoff_source_journal WHERE session_id = ? AND type IN ('prompt','ended') LIMIT 10",
    'SELECT seq FROM message_delivery INDEXED BY handoff_source_delivery WHERE session_id = ? LIMIT 10',
    'SELECT 1 FROM agent_messages INDEXED BY handoff_source_message WHERE target_session_id = ? LIMIT 1',
    'SELECT state FROM branch_attempt INDEXED BY handoff_source_branch WHERE session_id = ? LIMIT 2'
  ]) {
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('s') as { detail: string }[];
    assert.match(plan.map(p => p.detail).join(' '), /SEARCH .* USING (?:COVERING )?INDEX/);
  }
  f.db.close();
  const old = new DatabaseSync(':memory:'); old.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, last_seq INTEGER); INSERT INTO sessions VALUES (\'s\',0)');
  assert.equal(prepareAgentHandoffSource(old, 's', 0).kind, 'unproven'); old.close();
});
