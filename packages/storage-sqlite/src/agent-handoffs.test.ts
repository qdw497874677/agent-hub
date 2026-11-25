import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asAgentId, asSessionId, asTaskId, asWorkspaceId, type Session } from '@agent-hub/domain';
import { AGENT_HANDOFF_HISTORY_BYTES, AGENT_HANDOFF_HISTORY_ROWS, createSqliteAgentHandoffs, ensureAgentHandoffTable } from './agent-handoffs.ts';

function fixture(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, deleted_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT, archived_at INTEGER, status TEXT);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY, project_id TEXT, worker_id TEXT, path TEXT, kind TEXT, state TEXT, owner_task_id TEXT, group_id TEXT);
    CREATE TABLE project_workspaces(project_id TEXT, workspace_id TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, task_id TEXT, agent_id TEXT, model TEXT, origin_session TEXT, origin_seq INTEGER, status TEXT, last_seq INTEGER, turn INTEGER, agent_session TEXT, options TEXT, option_spec TEXT, worker_id TEXT, workspace_id TEXT, created_by TEXT, kind TEXT, group_id TEXT, bot_id TEXT, parent_session_id TEXT, mcp_disabled TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE journal(session_id TEXT, seq INTEGER, type TEXT, payload TEXT, at INTEGER, turn INTEGER, PRIMARY KEY(session_id,seq));
    CREATE TABLE message_delivery(id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, kind TEXT, payload TEXT, state TEXT, attempt INTEGER, next_at INTEGER, last_error TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE agent_messages(target_session_id TEXT, status TEXT);
    CREATE TABLE branch_attempt(session_id TEXT, state TEXT);
    INSERT INTO projects VALUES('p',NULL); INSERT INTO tasks VALUES('t','p',NULL,'active');
    INSERT INTO workspaces VALUES('w','p','worker','/repo','long_lived','ready',NULL,NULL);`);
  const save = (s: Session) => { db.prepare(`INSERT INTO sessions(id,task_id,agent_id,model,origin_session,origin_seq,status,last_seq,turn,agent_session,options,option_spec,worker_id,workspace_id,created_by,kind,group_id,bot_id,parent_session_id,mcp_disabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.id,s.taskId,s.agentId,s.model,null,null,s.status,s.lastSeq,s.turn,s.agentSessionRef,JSON.stringify(s.options),JSON.stringify(s.optionSpec),s.workerId,s.workspaceId,s.createdBy ?? null,s.kind ?? null,s.groupId ?? null,s.botId ?? null,s.parentSessionId ?? null,JSON.stringify(s.mcpDisabled),s.createdAt,s.updatedAt); };
  const make = (id: string, agent: string): Session => ({ id: asSessionId(id), taskId: asTaskId('t'), agentId: asAgentId(agent), model: 'model', origin: { kind: 'derive' }, status: 'running', lastSeq: 0, turn: 0, agentSessionRef: null, options: {}, optionSpec: [], workerId: 'worker', workspaceId: asWorkspaceId('w'), createdBy: 'actor', mcpDisabled: [], createdAt: 1, updatedAt: 1 });
  save(make('source','one'));
  ensureAgentHandoffTable(db);
  const store = createSqliteAgentHandoffs(db, save);
  const reservation = { actorId:'actor', sourceSessionId:'source', sourceCursor:0, requestKey:'reserve', semanticHash:'hash', target:make('target','two'), projectId:'p', taskId:'t', workspaceId:'w', workerId:'worker', path:'/repo', targetAgent:'two', targetModel:'model', now:1 };
  const first = { targetSessionId:'target', actorId:'actor', requestKey:'first', semanticHash:'first-hash', text:'raw user text', decoratedText:'history\nraw user text', clientMessageId:'client', deliveryId:'delivery', now:2 };
  return { db, save, store, reservation, first };
}

test('reservation rolls back staged target on source proof rejection and replays before cursor check', async () => {
  const f = fixture();
  f.db.exec("INSERT INTO agent_messages VALUES('source','queued')");
  assert.equal((await f.store.reserve(f.reservation)).kind, 'conflict');
  assert.equal(f.db.prepare("SELECT 1 FROM sessions WHERE id='target'").get(), undefined);
  f.db.exec('DELETE FROM agent_messages');
  assert.equal((await f.store.reserve(f.reservation)).kind, 'created');
  assert.equal((await f.store.byRequest('actor','source','reserve'))?.reservation.target.id, 'target');
  assert.equal(await f.store.byRequest('other','source','reserve'), null);
  assert.equal(await f.store.byRequest('actor','other','reserve'), null);
  assert.equal(await f.store.byRequest('actor','source','other'), null);
  f.db.exec("UPDATE sessions SET last_seq=10 WHERE id='source'");
  assert.equal((await f.store.reserve(f.reservation)).kind, 'replay');
  assert.equal((await f.store.reserve({ ...f.reservation, semanticHash:'different' })).kind, 'conflict');
  f.db.close();
});

test('handoff source must have its exact delivered first receipt and a unique known end', async () => {
  const f = fixture();
  assert.equal((await f.store.reserve(f.reservation)).kind, 'created');
  const next = { ...f.reservation, sourceSessionId:'target', requestKey:'second-reserve', target: { ...f.reservation.target, id:asSessionId('third'), agentId:asAgentId('three') }, targetAgent:'three' };
  const conflict = async (cursor: number) => {
    assert.equal((await f.store.reserve({ ...next, sourceCursor:cursor })).kind, 'conflict');
    assert.equal(f.db.prepare("SELECT 1 FROM sessions WHERE id='third'").get(), undefined);
  };
  await conflict(0); // pending first prompt cannot be a chain source
  assert.equal((await f.store.admitFirst(f.first)).kind, 'admitted');
  await conflict(1); // queued, then delivered without an end
  f.db.exec("UPDATE message_delivery SET state='delivered',attempt=1,next_at=NULL WHERE id='delivery'");
  await conflict(1);
  f.db.prepare('INSERT INTO journal VALUES(?,?,?,?,?,?)').run('target',2,'ended',JSON.stringify({kind:'ended',deliveryId:'delivery',outcome:'done'}),3,1);
  f.db.exec("UPDATE sessions SET last_seq=2 WHERE id='target'");
  f.db.exec("UPDATE agent_handoff SET first_delivery_id='wrong' WHERE target_id='target'");
  await conflict(2); // an otherwise valid journal cannot repair a corrupt receipt
  f.db.exec("UPDATE agent_handoff SET first_delivery_id='delivery' WHERE target_id='target'");
  f.db.prepare("UPDATE journal SET payload=? WHERE session_id='target' AND seq=2").run(JSON.stringify({kind:'ended',deliveryId:'delivery',outcome:'done',reason:'outcome_unknown'}));
  await conflict(2); // unknown outcome
  f.db.prepare("UPDATE journal SET payload=? WHERE session_id='target' AND seq=2").run(JSON.stringify({kind:'ended',deliveryId:'delivery',outcome:'done'}));
  f.db.prepare('INSERT INTO journal VALUES(?,?,?,?,?,?)').run('target',3,'ended',JSON.stringify({kind:'ended',deliveryId:'delivery',outcome:'done'}),4,1);
  f.db.exec("UPDATE sessions SET last_seq=3 WHERE id='target'");
  await conflict(3); // duplicate end is ambiguous
  f.db.exec("DELETE FROM journal WHERE session_id='target' AND seq=3; UPDATE sessions SET last_seq=2 WHERE id='target'");
  assert.equal((await f.store.reserve({ ...next, sourceCursor:2 })).kind, 'created');
  f.db.close();
});

test('reservation bounds target ids, model and serialized target storage', async () => {
  const f = fixture();
  for (const r of [
    { ...f.reservation, target: { ...f.reservation.target, id:asSessionId('x'.repeat(513)) } },
    { ...f.reservation, targetModel:'x'.repeat(513) },
    { ...f.reservation, target: { ...f.reservation.target, model:'x'.repeat(70_000) } },
  ]) assert.equal((await f.store.reserve(r)).kind, 'conflict');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_handoff").get()?.n, 0);
  f.db.close();
});

test('firstEnded uses exact indexed delivery key, rejects ambiguity and malformed known keys', async () => {
  const f = fixture(); await f.store.reserve(f.reservation); await f.store.admitFirst(f.first);
  const insert = f.db.prepare('INSERT INTO journal VALUES(?,?,?,?,?,?)');
  const check = () => f.store.firstEnded('target','delivery',1);
  assert.equal(await check(),false);
  for (let i=0; i<600; i++) insert.run('target',i+10,'ended',JSON.stringify({kind:'ended',deliveryId:`other${i}`,outcome:'done',reason:'x'.repeat(2048)}),1,1);
  insert.run('target',2,'ended',JSON.stringify({kind:'ended',deliveryId:'delivery',outcome:'stopped'}),1,1);
  assert.equal(await check(),false); // delivery still queued
  f.db.exec("UPDATE message_delivery SET state='delivered' WHERE id='delivery'");
  assert.equal(await check(),true);
  assert.equal(await f.store.firstEnded('target','delivery',2),false);
  const update = f.db.prepare("UPDATE journal SET payload=? WHERE session_id='target' AND seq=2");
  for (const payload of [
    JSON.stringify({kind:'ended',deliveryId:'delivery',outcome:'done',reason:'outcome_unknown'}),
    JSON.stringify({kind:'ended',deliveryId:'delivery',outcome:'done',reason:null}),
    JSON.stringify({kind:'text',deliveryId:'delivery',outcome:'done'}),
    '{"kind":"ended","deliveryId":"delivery","outcome":"done","outcome":"failed"}',
    '{"kind":"ended","deliveryId":"delivery","deliveryId":"other","outcome":"done"}',
  ]) { update.run(payload); assert.equal(await check(),false, payload); }
  update.run(JSON.stringify({kind:'ended',deliveryId:'delivery',outcome:'done'}));
  insert.run('target',3,'ended',JSON.stringify({kind:'ended',deliveryId:'delivery',outcome:'failed'}),1,1);
  assert.equal(await check(),false);
  const sql = `SELECT seq FROM journal INDEXED BY handoff_first_ended WHERE session_id=? AND type='ended'
    AND CASE WHEN typeof(payload)='text' AND json_valid(payload) AND json_type(payload,'$.deliveryId')='text'
      THEN json_extract(payload,'$.deliveryId') END = ? AND seq > ? LIMIT 2`;
  const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('target','delivery',1) as {detail:string}[];
  assert.match(plan.map(p => p.detail).join(' '), /SEARCH .* USING INDEX handoff_first_ended \(session_id=\? AND <expr>=\? AND seq>\?\)/);
  f.db.close();
});

test('first receipt is idempotent and raw journal remains separate from decorated delivery', async () => {
  const f = fixture(); await f.store.reserve(f.reservation);
  f.db.exec("UPDATE sessions SET last_seq=3 WHERE id='source'");
  assert.equal((await f.store.admitFirst(f.first)).kind, 'admitted');
  assert.equal((await f.store.admitFirst(f.first)).kind, 'replay');
  assert.equal((await f.store.admitFirst({ ...f.first, semanticHash:'other' })).kind, 'conflict');
  const event = JSON.parse((f.db.prepare('SELECT payload FROM journal').get() as { payload:string }).payload);
  const payload = JSON.parse((f.db.prepare('SELECT payload FROM message_delivery').get() as { payload:string }).payload);
  assert.deepEqual(event, { kind:'prompt', text:'raw user text', promptActor:'account', clientMessageId:'client' });
  assert.deepEqual(payload, { text:'history\nraw user text', parts:[] });
  const handoff = f.db.prepare('SELECT * FROM agent_handoff').get()!;
  assert.equal(JSON.stringify(handoff).includes('raw user text'), false);
  assert.equal(JSON.stringify(handoff).includes('history\\nraw user text'), false);
  f.db.exec("UPDATE message_delivery SET state='delivered', attempt=1, next_at=NULL WHERE id='delivery'");
  const replay = await f.store.admitFirst(f.first);
  assert.equal(replay.kind, 'replay');
  if (replay.kind === 'replay') { assert.equal(replay.record.first?.delivery.state, 'delivered'); assert.equal(replay.record.first?.delivery.id, 'delivery'); assert.equal(replay.record.first?.delivery.seq, 1); }
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM journal').get() as { n:number }).n, 1);
  f.db.close();
});

test('lineage persists on source deletion and incomplete receipts fail closed', async () => {
  const f = fixture(); await f.store.reserve(f.reservation); await f.store.admitFirst(f.first);
  f.db.exec("DELETE FROM sessions WHERE id='source'");
  assert.equal((await f.store.byTarget('target'))?.reservation.sourceSessionId, 'source');
  assert.equal((await f.store.byRequest('actor','source','reserve'))?.reservation.target.id, 'target');
  assert.equal((await f.store.admitFirst(f.first)).kind, 'conflict');
  f.db.exec("DELETE FROM journal WHERE session_id='target'");
  await assert.rejects(f.store.byTarget('target'), /Invalid handoff receipt/);
  assert.equal((await f.store.admitFirst(f.first)).kind, 'conflict');
  const claim = { targetSessionId:'target', deliveryId:'delivery', attemptId:'attempt', workerId:'worker', connectionId:'socket', now:3 };
  assert.equal((await f.store.claimStartup(claim)).kind, 'ignored');
  assert.equal((await f.store.settleStartup({ ...claim, state:'ready' })).kind, 'ignored');
  f.db.close();
});

test('receipt reload rejects half rows and tolerates equivalent JSON reserialization', async () => {
  const f = fixture(); await f.store.reserve(f.reservation); await f.store.admitFirst(f.first);
  f.db.prepare('UPDATE journal SET payload=? WHERE session_id=?').run('{"clientMessageId":"client","promptActor":"account","text":"raw user text","kind":"prompt"}', 'target');
  f.db.prepare('UPDATE message_delivery SET payload=? WHERE id=?').run('{"parts":[],"text":"history\\nraw user text"}', 'delivery');
  assert.equal((await f.store.admitFirst(f.first)).kind, 'replay');
  f.db.exec('UPDATE agent_handoff SET first_delivery_id=NULL');
  await assert.rejects(f.store.byRequest('actor','source','reserve'), /Incomplete handoff receipt/);
  assert.equal((await f.store.admitFirst(f.first)).kind, 'conflict');
  f.db.close();
});

test('existing ingress, wrong creator, changed placement or ownership fail closed', async () => {
  for (const change of [
    "INSERT INTO journal VALUES('target',1,'text','{}',1,0)",
    "INSERT INTO agent_messages VALUES('target','queued')",
    "UPDATE workspaces SET path='/else'",
    "INSERT INTO project_workspaces VALUES('other','w')",
    "UPDATE tasks SET archived_at=3",
    "UPDATE sessions SET model='changed' WHERE id='target'"
  ]) {
    const f = fixture(); await f.store.reserve(f.reservation); f.db.exec(change);
    assert.equal((await f.store.admitFirst(f.first)).kind, 'conflict', change);
    f.db.close();
  }
  const f = fixture(); await f.store.reserve(f.reservation);
  assert.equal((await f.store.admitFirst({ ...f.first, actorId:'other' })).kind, 'conflict');
  f.db.close();
});

test('startup claim survives reopening and only exact receipt can settle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-')); const path = join(dir, 'db.sqlite');
  try {
    const f = fixture(path); await f.store.reserve(f.reservation); await f.store.admitFirst(f.first);
    const claim = { targetSessionId:'target', deliveryId:'delivery', attemptId:'attempt', workerId:'worker', connectionId:'socket-a', now:3 };
    assert.equal((await f.store.claimStartup(claim)).kind, 'claimed'); f.db.close();
    const db = new DatabaseSync(path); ensureAgentHandoffTable(db);
    const store = createSqliteAgentHandoffs(db, () => { throw new Error('must not recreate'); });
    const restored = await store.byRequest('actor','source','reserve');
    assert.equal(restored?.first?.delivery.id, 'delivery');
    assert.equal(restored?.first?.delivery.seq, 1);
    assert.equal(restored?.first?.event.kind, 'prompt');
    assert.equal((await store.claimStartup({ ...claim, attemptId:'other' })).kind, 'ignored');
    assert.equal((await store.byTarget('target'))?.startup.state, 'claimed');
    assert.equal((await store.byTarget('target'))?.startup.connectionId, 'socket-a');
    assert.equal((await store.settleStartup({ ...claim, workerId:'other', state:'ready' })).kind, 'ignored');
    assert.equal((await store.settleStartup({ ...claim, connectionId:'socket-b', state:'ready' })).kind, 'ignored');
    assert.equal((await store.settleStartup({ ...claim, state:'unknown' })).kind, 'settled');
    assert.equal((await store.settleStartup({ ...claim, state:'ready' })).kind, 'ignored');
    assert.equal((await store.byTarget('target'))?.startup.state, 'unknown'); db.close();
  } finally { rmSync(dir, { recursive:true, force:true }); }
});

test('ready CAS persists only observed runtime reference and option spec across reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-observed-')); const path = join(dir, 'db.sqlite');
  try {
    const f = fixture(path); await f.store.reserve(f.reservation); await f.store.admitFirst(f.first);
    const claim = { targetSessionId:'target', deliveryId:'delivery', attemptId:'attempt', workerId:'worker', connectionId:'socket', now:3 };
    const options = [{ id:'model', label:'Model', category:'model' as const, kind:'select' as const, current:'other', choices:[{kind:'value' as const, value:{value:'other', label:'Other', metadata:{contextWindow:32000, aliases:['alias']}}}] }];
    const observed = { agentSessionRef:'native-new', options };
    assert.equal((await f.store.claimStartup(claim)).kind,'claimed');
    const before = f.db.prepare("SELECT model, options, last_seq, status, turn, updated_at FROM sessions WHERE id='target'").get();
    for (const bad of [{ ...claim, attemptId:'wrong' }, { ...claim, connectionId:'wrong' }, { ...claim, workerId:'wrong' }]) {
      assert.equal((await f.store.settleStartup({ ...bad, state:'ready', observed })).kind,'ignored');
    }
    let row = f.db.prepare("SELECT agent_session, option_spec FROM sessions WHERE id='target'").get()!;
    assert.equal(row.agent_session,null); assert.equal(row.option_spec,'[]');
    assert.equal((await f.store.settleStartup({ ...claim, state:'ready', observed })).kind,'settled');
    f.db.close();
    const db = new DatabaseSync(path); ensureAgentHandoffTable(db);
    const store = createSqliteAgentHandoffs(db, () => { throw new Error('must not write'); });
    row = db.prepare("SELECT agent_session, option_spec, model, options, last_seq, status FROM sessions WHERE id='target'").get()!;
    assert.equal(row.agent_session,'native-new'); assert.deepEqual(JSON.parse(row.option_spec as string),options);
    assert.equal(row.model,'model'); assert.equal(row.options,'{}'); assert.equal(row.last_seq,1); assert.equal(row.status,'running');
    assert.deepEqual(db.prepare("SELECT model, options, last_seq, status, turn, updated_at FROM sessions WHERE id='target'").get(),before);
    assert.equal((await store.byTarget('target'))?.startup.state,'ready'); db.close();
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('oversized options are discarded without blocking ready with valid reference', async () => {
  const f = fixture(); await f.store.reserve(f.reservation); await f.store.admitFirst(f.first);
  const claim = { targetSessionId:'target', deliveryId:'delivery', attemptId:'attempt', workerId:'worker', connectionId:'socket', now:3 };
  await f.store.claimStartup(claim);
  const options = Array.from({length: 17}, (_, i) => ({ id:`option-${i}`, label:'x'.repeat(4096), category:'custom' as const, kind:'boolean' as const, current:true, choices:[] }));
  assert.equal((await f.store.settleStartup({ ...claim, state:'ready', observed:{ agentSessionRef:'native', options } })).kind,'settled');
  const row = f.db.prepare("SELECT agent_session, option_spec FROM sessions WHERE id='target'").get()!;
  assert.equal(row.agent_session,'native'); assert.equal(row.option_spec,'[]'); f.db.close();
});

test('nonready, absent and invalid observations never populate session metadata', async () => {
  for (const mode of ['failed','unknown','absent','invalid'] as const) {
    const f = fixture(); await f.store.reserve(f.reservation); await f.store.admitFirst(f.first);
    const claim = { targetSessionId:'target', deliveryId:'delivery', attemptId:'attempt', workerId:'worker', connectionId:'socket', now:3 };
    await f.store.claimStartup(claim);
    const observed = mode === 'absent' ? undefined : mode === 'invalid'
      ? { agentSessionRef:'pending', options:[{id:'bad',label:'Bad',category:'model' as const,kind:'select' as const,current:'m',choices:[{kind:'value' as const,value:{value:'m',label:'M',metadata:{contextWindow:-1}}}]}] }
      : { agentSessionRef:'native', options:[] };
    assert.equal((await f.store.settleStartup({ ...claim, state: mode === 'failed' || mode === 'unknown' ? mode : 'ready', observed })).kind,mode === 'failed' || mode === 'unknown' ? 'settled' : 'ignored');
    const row = f.db.prepare("SELECT agent_session, option_spec FROM sessions WHERE id='target'").get()!;
    assert.equal(row.agent_session,null,mode); assert.equal(row.option_spec,'[]',mode); f.db.close();
  }
});

test('keyed ready fails closed without usable observed reference and does not inherit an existing target ref', async () => {
  const f = fixture(); await f.store.reserve(f.reservation); await f.store.admitFirst(f.first);
  const claim = { targetSessionId:'target', deliveryId:'delivery', attemptId:'attempt', workerId:'worker', connectionId:'socket', now:3 };
  await f.store.claimStartup(claim);
  for (const ref of [undefined, '', '   ', ' Pending ', 'x'.repeat(513), 'é'.repeat(257), 'ok\u0000bad', 'ok\n', 'ok\u007f', 'ok\u0085']) {
    assert.equal((await f.store.settleStartup({ ...claim, state:'ready', observed:{ agentSessionRef:ref, options:[] } })).kind,'ignored');
    assert.equal((await f.store.byTarget('target'))?.startup.state,'claimed');
    assert.equal(f.db.prepare("SELECT agent_session FROM sessions WHERE id='target'").get()?.agent_session,null);
  }
  f.db.exec("UPDATE sessions SET agent_session='injected' WHERE id='target'");
  for (const ref of ['injected', 'new']) {
    assert.equal((await f.store.settleStartup({ ...claim, state:'ready', observed:{ agentSessionRef:ref } })).kind,'ignored');
    assert.equal((await f.store.byTarget('target'))?.startup.state,'claimed');
    assert.equal(f.db.prepare("SELECT agent_session FROM sessions WHERE id='target'").get()?.agent_session,'injected');
  }
  f.db.close();
});

test('a separately observed reference may equal an opaque source reference across agents', async () => {
  const f = fixture(); f.db.exec("UPDATE sessions SET agent_session='same-native' WHERE id='source'");
  await f.store.reserve(f.reservation); await f.store.admitFirst(f.first);
  const claim = { targetSessionId:'target', deliveryId:'delivery', attemptId:'attempt', workerId:'worker', connectionId:'socket', now:3 };
  await f.store.claimStartup(claim);
  assert.equal((await f.store.settleStartup({ ...claim, state:'ready', observed:{ agentSessionRef:'same-native' } })).kind,'settled');
  assert.equal(f.db.prepare("SELECT agent_session FROM sessions WHERE id='target'").get()?.agent_session,'same-native');
  f.db.close();
});

test('legacy duplicate receipt is reduced to keys on setup without losing lineage', async () => {
  const f = fixture(); await f.store.reserve(f.reservation); await f.store.admitFirst(f.first);
  const first = (await f.store.byTarget('target'))!.first!;
  f.db.exec('ALTER TABLE agent_handoff ADD COLUMN first_event TEXT; ALTER TABLE agent_handoff ADD COLUMN first_delivery TEXT');
  f.db.prepare('UPDATE agent_handoff SET first_seq=NULL, first_delivery_id=NULL, first_event=?, first_delivery=?').run(JSON.stringify(first.event),JSON.stringify(first.delivery));
  ensureAgentHandoffTable(f.db);
  const row = f.db.prepare('SELECT first_event, first_delivery, first_seq, first_delivery_id FROM agent_handoff').get()!;
  assert.deepEqual({ ...row }, { first_event:null, first_delivery:null, first_seq:1, first_delivery_id:'delivery' });
  assert.equal((await f.store.admitFirst(f.first)).kind, 'replay');
  f.db.close();
});

test('history uses only exact delivered prompt and unique end at or before the pinned cursor', async () => {
  const f = fixture();
  const add = (seq: number, event: object) => f.db.prepare('INSERT INTO journal VALUES(?,?,?,?,?,?)').run('source', seq, (event as {kind:string}).kind, JSON.stringify(event), seq, 1);
  const delivery = (id: string, seq: number, state: string) => f.db.prepare('INSERT INTO message_delivery VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'source',seq,'prompt','{}',state,1,null,null,seq,seq);
  add(1, { kind:'prompt', text:'question', promptActor:'account' });
  add(2, { kind:'text', delta:'answer', textOrigin:'main_assistant', firstOutputDeliveryId:'d1' });
  add(3, { kind:'ended', outcome:'done', deliveryId:'d1' });
  add(4, { kind:'text', delta:'after boundary' });
  add(5, { kind:'ended', outcome:'done', deliveryId:'d1' });
  delivery('d1',1,'delivered');
  const history = await f.store.historyFor('source',3);
  assert.deepEqual(history.entries.map(e => e.seq), [1,2,3]);
  assert.deepEqual(history.deliveries, [{ sessionId:'source', promptSeq:1, deliveryId:'d1', ended:{ seq:3, outcome:'done' } }]);
  assert.deepEqual((await f.store.historyFor('source',5)).deliveries, []);
  f.db.exec("UPDATE message_delivery SET state='sending'");
  assert.deepEqual((await f.store.historyFor('source',3)).deliveries, []);
  f.db.exec("UPDATE message_delivery SET state='delivered', seq=2");
  assert.deepEqual((await f.store.historyFor('source',3)).deliveries, []);
  f.db.close();
});

test('history has bounded row and raw byte materialization and omits malformed events', async () => {
  const f = fixture();
  const ins = f.db.prepare('INSERT INTO journal VALUES(?,?,?,?,?,?)');
  for (let i=1; i<=AGENT_HANDOFF_HISTORY_ROWS+3; i++) ins.run('source', i, 'text', JSON.stringify({kind:'text',delta:'x'}), i, 1);
  const slice = await f.store.historyFor('source', AGENT_HANDOFF_HISTORY_ROWS+3);
  assert.equal(slice.entries.length, AGENT_HANDOFF_HISTORY_ROWS);
  assert.equal(slice.entries[0]?.seq,4);
  ins.run('source', AGENT_HANDOFF_HISTORY_ROWS+4, 'text', '{', 1, 1);
  ins.run('source', AGENT_HANDOFF_HISTORY_ROWS+5, 'text', JSON.stringify({kind:'text',delta:'x'.repeat(AGENT_HANDOFF_HISTORY_BYTES)}), 1, 1);
  const oversized = await f.store.historyFor('source',AGENT_HANDOFF_HISTORY_ROWS+5);
  assert.deepEqual(oversized, { entries:[], deliveries:[] });
  assert.deepEqual(await f.store.historyFor('source',-1), { entries:[], deliveries:[] });
  f.db.close();
});

test('history survives reopen and malformed keyed endings cannot prove a turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-history-')); const path = join(dir, 'db.sqlite');
  try {
    const f = fixture(path);
    f.db.prepare('INSERT INTO journal VALUES(?,?,?,?,?,?)').run('source',1,'prompt',JSON.stringify({kind:'prompt',text:'question',promptActor:'account'}),1,1);
    f.db.prepare('INSERT INTO journal VALUES(?,?,?,?,?,?)').run('source',2,'ended',JSON.stringify({kind:'ended',deliveryId:'d',outcome:'done'}),2,1);
    f.db.prepare('INSERT INTO journal VALUES(?,?,?,?,?,?)').run('source',3,'ended','{',3,1);
    f.db.prepare('INSERT INTO message_delivery VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('d','source',1,'prompt','{}','delivered',1,null,null,1,1);
    f.db.close();
    const db = new DatabaseSync(path); ensureAgentHandoffTable(db);
    const store = createSqliteAgentHandoffs(db, () => { throw new Error('read must not write'); });
    assert.equal((await store.historyFor('source',2)).deliveries.length,1);
    const history = await store.historyFor('source',3);
    assert.deepEqual(history.entries.map(e => e.seq),[1,2]);
    assert.deepEqual(history.deliveries,[]);
    db.close();
  } finally { rmSync(dir, { recursive:true, force:true }); }
});

test('startup claim revalidates placement and queue head', async () => {
  for (const change of ["UPDATE tasks SET archived_at=4", "UPDATE workspaces SET path='/moved'", "INSERT INTO message_delivery VALUES('earlier','target',0,'prompt','{}','queued',0,0,NULL,0,0)"]) {
    const f = fixture(); await f.store.reserve(f.reservation); await f.store.admitFirst(f.first); f.db.exec(change);
    assert.equal((await f.store.claimStartup({ targetSessionId:'target', deliveryId:'delivery', attemptId:'a', workerId:'worker', connectionId:'c', now:4 })).kind, 'ignored', change);
    f.db.close();
  }
});
