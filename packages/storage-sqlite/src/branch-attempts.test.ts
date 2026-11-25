import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asAgentId, asSessionId, type BranchAttempt, type Session } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

const child = (id: string): Session => ({ id: asSessionId(id), taskId: null, agentId: asAgentId('agent'), model: '', origin: { kind: 'derive' }, status: 'running', lastSeq: 0, turn: 0, agentSessionRef: null, options: {}, optionSpec: [], workerId: 'worker', workspaceId: null, mcpDisabled: [], createdAt: 1, updatedAt: 1 });
const attempt = (id: string, sessionId: string): BranchAttempt => ({ id, sessionId, workerId: 'worker', state: 'pending', createdAt: 1, updatedAt: 1, brief: { text: 'brief', stats: { sourceSessionId: 'source', turns: 1, carriedTurns: 1, carried: 1, omitted: 0, omittedTurns: [], tokens: 1, budget: 10 } } });

test('branch stages atomically and exact plain confirmation commits once across reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'branch-attempt-'));
  const path = join(dir, 'hub.db');
  try {
    let db = openSqliteStore(path);
    const plain = { outcome: 'plain' as const, agentSessionRef: 'plain-ref' };
    assert.equal((await db.branchAttempts.settle('child', 'a', 'worker', plain, 2)).kind, 'ignored');
    await db.branchAttempts.stage(child('child'), attempt('a', 'child'));
    await assert.rejects(db.branchAttempts.stage(child('duplicate'), attempt('a', 'duplicate')));
    assert.equal(await db.sessions.byId(asSessionId('duplicate')), null);
    db.close();
    db = openSqliteStore(path);
    assert.equal((await db.branchAttempts.bySession('child'))?.state, 'pending');
    assert.equal((await db.branchAttempts.settle('child', 'wrong', 'worker', plain, 2)).kind, 'ignored');
    assert.equal((await db.branchAttempts.settle('child', 'a', 'wrong', plain, 2)).kind, 'ignored');
    const settled = await db.branchAttempts.settle('child', 'a', 'worker', plain, 2);
    assert.equal(settled.kind, 'settled');
    assert.equal(settled.kind === 'settled' && settled.session.agentSessionRef, 'plain-ref');
    assert.equal((await db.branchAttempts.settle('child', 'a', 'worker', { outcome: 'plain', agentSessionRef: 'different-ref' }, 3)).kind, 'ignored');
    assert.equal((await db.branchAttempts.settle('child', 'a', 'worker', { outcome: 'native', agentSessionRef: 'native-ref' }, 3)).kind, 'ignored');
    db.close();
    db = openSqliteStore(path);
    assert.equal((await db.branchAttempts.bySession('child'))?.state, 'plain');
    assert.equal((await db.branchAttempts.bySession('child'))?.settledAgentSessionRef, 'plain-ref');
    assert.equal((await db.sessions.byId(asSessionId('child')))?.lastSeq, 1);
    assert.equal((await db.sessions.byId(asSessionId('child')))?.agentSessionRef, 'plain-ref');
    assert.equal((await db.sessions.eventsAfter(asSessionId('child'), 0)).filter((e) => e.event.kind === 'prompt').length, 1);
    assert.equal((await db.deliveries.byId('branch_brief_a'))?.state, 'queued');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fork receipt cannot reuse staged source ref, including after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'branch-parent-'));
  const path = join(dir, 'hub.db');
  try {
    let db = openSqliteStore(path);
    await db.sessions.save({ ...child('source'), agentSessionRef: 'parent-ref' });
    await db.branchAttempts.stage({ ...child('fork'), origin: { kind: 'fork', fromSessionId: asSessionId('source'), atSeq: 1 } }, attempt('fork-attempt', 'fork'));
    db.close();
    db = openSqliteStore(path);
    for (const outcome of ['native', 'plain'] as const) {
      assert.equal((await db.branchAttempts.settle('fork', 'fork-attempt', 'worker', { outcome, agentSessionRef: 'parent-ref' }, 2)).kind, 'ignored');
    }
    assert.equal((await db.branchAttempts.bySession('fork'))?.state, 'pending');
    assert.equal((await db.branchAttempts.settle('fork', 'fork-attempt', 'worker', { outcome: 'plain', agentSessionRef: 'child-ref' }, 3)).kind, 'settled');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native and both_failed never enqueue brief; failure during commit rolls back', async () => {
  const db = openSqliteStore(':memory:');
  try {
    for (const state of ['native', 'both_failed'] as const) {
      await db.branchAttempts.stage(child(state), attempt(state, state));
      const receipt = state === 'native' ? { outcome: 'native' as const, agentSessionRef: 'native-ref' } : { outcome: 'both_failed' as const };
      const settled = await db.branchAttempts.settle(state, state, 'worker', receipt, 2);
      assert.equal(settled.kind, 'settled');
      const session = await db.sessions.byId(asSessionId(state));
      assert.equal(session?.agentSessionRef, state === 'native' ? 'native-ref' : null);
      assert.equal(session?.status, state === 'native' ? 'running' : 'failed');
      assert.equal((await db.deliveries.pendingFor(state)).length, 0);
      assert.equal((await db.sessions.eventsAfter(asSessionId(state), 0)).length, 0);
    }
    await db.branchAttempts.stage(child('rollback'), attempt('rollback', 'rollback'));
    db.db.exec("CREATE TRIGGER reject_branch_delivery BEFORE INSERT ON message_delivery BEGIN SELECT RAISE(ABORT, 'reject'); END");
    await assert.rejects(db.branchAttempts.settle('rollback', 'rollback', 'worker', { outcome: 'plain', agentSessionRef: 'ref' }, 2));
    assert.equal((await db.branchAttempts.bySession('rollback'))?.state, 'pending');
    assert.equal((await db.sessions.byId(asSessionId('rollback')))?.lastSeq, 0);
    assert.equal((await db.sessions.byId(asSessionId('rollback')))?.agentSessionRef, null);
    assert.equal((await db.sessions.eventsAfter(asSessionId('rollback'), 0)).length, 0);
  } finally { db.close(); }
});

test('普通会话回写不能替换分叉的 Worker 或原生回执，但仍可保存其他字段', async () => {
  const db = openSqliteStore(':memory:');
  try {
    const stale = child('racing');
    await db.branchAttempts.stage(stale, attempt('racing-attempt', 'racing'));
    await db.sessions.save({ ...stale, agentSessionRef: 'unconfirmed', workerId: 'other' });
    assert.equal((await db.sessions.byId(stale.id))?.agentSessionRef, null);
    assert.equal((await db.branchAttempts.settle(stale.id, 'racing-attempt', 'worker', { outcome: 'native', agentSessionRef: 'proven' }, 2)).kind, 'settled');
    await db.sessions.save({ ...stale, workerId: 'other', model: 'new' });
    const saved = await db.sessions.byId(stale.id);
    assert.equal(saved?.workerId, 'worker');
    assert.equal(saved?.agentSessionRef, 'proven');
    assert.equal(saved?.model, 'new');
    const ordinary = child('ordinary');
    await db.sessions.save(ordinary);
    await db.sessions.save({ ...ordinary, agentSessionRef: 'ordinary-ref', workerId: 'other' });
    const updated = await db.sessions.byId(ordinary.id);
    assert.equal(updated?.agentSessionRef, 'ordinary-ref');
    assert.equal(updated?.workerId, 'other');
  } finally { db.close(); }
});

test('invalid references do not settle, stage rejects inherited ref, UTF-8 limit is measured in bytes', async () => {
  const db = openSqliteStore(':memory:');
  try {
    await assert.rejects(db.branchAttempts.stage({ ...child('bad-stage'), agentSessionRef: 'inherited' }, attempt('bad', 'bad-stage')));
    assert.equal(await db.sessions.byId(asSessionId('bad-stage')), null);
    await db.branchAttempts.stage(child('invalid'), attempt('invalid', 'invalid'));
    for (const ref of ['', '  \t', 'pending', ' pending ', ' PeNdInG ', '界'.repeat(171)]) {
      for (const outcome of ['native', 'plain'] as const) {
        assert.equal((await db.branchAttempts.settle('invalid', 'invalid', 'worker', { outcome, agentSessionRef: ref }, 2)).kind, 'ignored');
      }
    }
    assert.equal((await db.branchAttempts.bySession('invalid'))?.state, 'pending');
    assert.equal((await db.sessions.byId(asSessionId('invalid')))?.agentSessionRef, null);
    assert.equal((await db.sessions.eventsAfter(asSessionId('invalid'), 0)).length, 0);
    assert.equal((await db.deliveries.pendingFor('invalid')).length, 0);
    const valid = '界'.repeat(170) + 'ab';
    assert.equal(Buffer.byteLength(valid), 512);
    assert.equal((await db.branchAttempts.settle('invalid', 'invalid', 'worker', { outcome: 'native', agentSessionRef: valid }, 3)).kind, 'settled');
    assert.equal((await db.sessions.byId(asSessionId('invalid')))?.agentSessionRef, valid);
  } finally { db.close(); }
});

test('existing pre-migration attempts are left unchanged when reopening the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'branch-legacy-'));
  const path = join(dir, 'hub.db');
  try {
    let db = openSqliteStore(path);
    await db.branchAttempts.stage(child('legacy-pending'), attempt('old-pending', 'legacy-pending'));
    await db.branchAttempts.stage(child('legacy-settled'), attempt('old-settled', 'legacy-settled'));
    db.db.prepare("UPDATE branch_attempt SET state = 'plain' WHERE id = ?").run('old-settled');
    db.close();
    db = openSqliteStore(path);
    assert.equal((await db.branchAttempts.bySession('legacy-pending'))?.state, 'pending');
    assert.equal((await db.branchAttempts.bySession('legacy-settled'))?.state, 'plain');
    assert.equal((await db.sessions.byId(asSessionId('legacy-settled')))?.agentSessionRef, null);
    assert.equal((await db.branchAttempts.settle('legacy-settled', 'old-settled', 'worker', { outcome: 'plain', agentSessionRef: 'new-ref' }, 2)).kind, 'ignored');
    assert.equal((await db.deliveries.pendingFor('legacy-settled')).length, 0);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
