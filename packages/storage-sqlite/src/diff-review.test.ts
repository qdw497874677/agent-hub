import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asAgentId, asSessionId, createProject, createTask, deriveSession, type DiffReviewNote } from '@agent-hub/domain';
import { openSqliteStore, type SqliteStore } from './store.ts';

const note = (id: string): Omit<DiffReviewNote, 'delivery'> => ({ id, member: null, path: 'src/a.ts', base: 'abc', side: 'new', start: 1, end: 2, version: 'v1', text: `comment ${id}` });
async function seed(store: SqliteStore) {
  const p = createProject({ name: 'project', now: 1 }); assert.ok(p.ok);
  const t = createTask({ projectId: p.value.id, title: 'task', now: 1 }); assert.ok(t.ok);
  const other = createTask({ projectId: p.value.id, title: 'other', now: 1 }); assert.ok(other.ok);
  const s = deriveSession({ task: t.value, agentId: asAgentId('agent'), model: 'm', now: 1 }); assert.ok(s.ok);
  await store.projects.save(p.value); await store.tasks.save(t.value); await store.tasks.save(other.value);
  await store.sessions.save({ ...s.value, id: asSessionId('source') });
  await store.sessions.save({ ...s.value, id: asSessionId('target') });
  await store.sessions.save({ ...s.value, id: asSessionId('outside'), taskId: other.value.id });
  return { actorId: 'actor', taskId: t.value.id, sourceSessionId: 'source' };
}
const input = (ids = ['b', 'a']) => ({ batchId: 'batch', targetSessionId: 'target', noteIds: ids, expectedNotes: ids.map(note), event: { kind: 'prompt' as const, text: 'review', clientMessageId: 'review-id' }, payload: { text: 'decorated', parts: [] }, now: 2 });

test('scoped durable notes, atomic admission, replay and purged delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diff-review-')); const path = join(dir, 'store.sqlite');
  let store = openSqliteStore(path);
  try {
    const scope = await seed(store);
    assert.equal(await store.diffReview.save(scope, note('a')), true);
    assert.equal(await store.diffReview.save(scope, note('b')), true);
    assert.deepEqual(await store.diffReview.list({ ...scope, actorId: 'other' }), []);
    assert.equal(await store.diffReview.save({ ...scope, taskId: 'wrong' }, note('x')), false);
    assert.equal((await store.diffReview.admit(scope, { ...input(), targetSessionId: 'outside' })).kind, 'conflict');
    assert.equal((await store.diffReview.admit(scope, { ...input(), expectedNotes: [note('b'), { ...note('a'), text: 'stale' }] })).kind, 'conflict');
    const admitted = await store.diffReview.admit(scope, input()); assert.equal(admitted.kind, 'admitted');
    if (admitted.kind !== 'admitted') throw new Error();
    assert.deepEqual(admitted.batch.noteIds, ['a', 'b']);
    assert.equal(await store.diffReview.save(scope, note('a')), false);
    assert.equal(await store.diffReview.remove(scope, 'a'), false);
    assert.equal((await store.diffReview.admit(scope, { ...input(['a', 'b']), event: { kind: 'prompt', text: 'changed decoration' }, payload: { text: 'changed', parts: [] } })).kind, 'replay');
    assert.equal((await store.diffReview.admit(scope, { ...input(), expectedNotes: [note('b'), { ...note('a'), version: 'changed' }] })).kind, 'conflict');
    assert.equal((await store.diffReview.admit(scope, { ...input(), batchId: 'racing' })).kind, 'conflict');
    assert.equal((await store.diffReview.list(scope))[0]?.delivery?.state, 'queued');
    store.close(); store = openSqliteStore(path);
    assert.deepEqual(await store.diffReview.batch(scope, 'batch'), admitted.batch);
    store.db.prepare("UPDATE message_delivery SET state='delivered' WHERE id=?").run(admitted.batch.deliveryId);
    assert.equal((await store.diffReview.list(scope))[0]?.delivery?.state, 'delivered');
    store.db.prepare('DELETE FROM message_delivery WHERE id=?').run(admitted.batch.deliveryId);
    assert.equal((await store.diffReview.list(scope))[0]?.delivery?.state, 'unknown');
    await store.sessions.remove(asSessionId('target'));
    assert.equal((await store.diffReview.list(scope)).length, 2);
    assert.equal((await store.diffReview.list(scope))[0]?.delivery?.state, 'unknown');
    await store.sessions.remove(asSessionId('source'));
    assert.deepEqual(await store.diffReview.list(scope), []);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('SQL failure rolls back receipt, note claims, journal, cursor and delivery', async () => {
  const store = openSqliteStore(':memory:');
  try {
    const scope = await seed(store); await store.diffReview.save(scope, note('a'));
    store.db.exec("CREATE TRIGGER reject_review BEFORE INSERT ON message_delivery BEGIN SELECT RAISE(ABORT, 'reject review'); END");
    await assert.rejects(store.diffReview.admit(scope, input(['a'])), /reject review/);
    assert.equal(await store.diffReview.batch(scope, 'batch'), null);
    assert.equal((await store.diffReview.list(scope))[0]?.delivery, null);
    assert.equal((await store.sessions.byId(asSessionId('target')))?.lastSeq, 0);
    assert.equal((await store.sessions.eventsAfter(asSessionId('target'), 0)).length, 0);
    store.db.exec('DROP TRIGGER reject_review');
    assert.equal((await store.diffReview.admit(scope, input(['a']))).kind, 'admitted');
  } finally { store.close(); }
});

test('existing ordinary clientMessageId is never admitted as a second prompt', async () => {
  const store = openSqliteStore(':memory:');
  try {
    const scope = await seed(store); await store.diffReview.save(scope, note('a'));
    store.db.prepare('INSERT INTO journal(session_id,seq,type,payload,at,turn) VALUES (?,?,?,?,?,?)').run('target', 1, 'prompt', JSON.stringify(input().event), 1, 1);
    store.db.prepare('UPDATE sessions SET last_seq=1,turn=1 WHERE id=?').run('target');
    assert.equal((await store.diffReview.admit(scope, input(['a']))).kind, 'conflict');
    assert.equal((await store.sessions.eventsAfter(asSessionId('target'), 0)).length, 1);
  } finally { store.close(); }
});
