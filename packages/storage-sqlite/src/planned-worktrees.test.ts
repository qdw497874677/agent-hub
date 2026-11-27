import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqlitePlannedWorktrees } from './planned-worktrees.ts';
import type { NewPlannedWorktree, PlannedWorktreeUpdate } from '@agent-hub/domain';

const record: NewPlannedWorktree = { id: 'unguessable-id', actorId: 'actor', projectId: 'project', taskId: 'task', workerId: 'worker', createdAt: 100,
  plan: { commit: 'abc', source: 'local' }, state: 'draft', progress: { step: 'planned' }, protectedWorkspaceIds: ['base', 'output'], protectedGroupIds: ['group'] };
const update = (state: PlannedWorktreeUpdate['state']): PlannedWorktreeUpdate => ({ state, progress: { step: state }, protectedWorkspaceIds: ['base', 'output'], protectedGroupIds: ['group'] });

test('durable plans: CAS, restart, protections, association and terminal closure', () => {
  const dir = mkdtempSync('/tmp/opencode/planned-worktrees-');
  const file = join(dir, 'db.sqlite');
  let db = new DatabaseSync(file);
  try {
    let store = createSqlitePlannedWorktrees(db);
    assert.equal(store.create(record), true);
    assert.equal(store.create({ ...record, plan: { commit: 'other' } }), false);
    assert.deepEqual(store.get(record.id)?.plan, record.plan);
    assert.equal(store.isWorkspaceProtected('base'), false);
    assert.equal(store.isGroupProtected('group'), false);
    assert.equal(store.byWorkspaceId('output').length, 1);
    assert.equal(store.compareAndSet(record.id, 0, update('pending'))?.revision, 1);
    assert.equal(store.compareAndSet(record.id, 0, update('unknown')), null);
    assert.equal(store.isWorkspaceProtected('base'), true);
    assert.equal(store.isWorkspaceProtected('output'), true);
    assert.equal(store.isGroupProtected('group'), true);
    assert.equal(store.compareAndSet(record.id, 1, { ...update('pending'), protectedWorkspaceIds: ['output'] }), null);
    assert.equal(store.compareAndSet(record.id, 1, update('draft')), null);
    assert.equal(store.compareAndSet(record.id, 1, update('unknown'))?.revision, 2);
    db.close();
    db = new DatabaseSync(file);
    store = createSqlitePlannedWorktrees(db);
    assert.equal(store.get(record.id)?.state, 'unknown');
    assert.deepEqual(store.get(record.id)?.progress, { step: 'unknown' });
    assert.equal(store.listByTask('task').length, 1);
    assert.equal(store.listByTask('other').length, 0);
    assert.equal(store.isWorkspaceProtected('base'), true);
    assert.equal(store.compareAndSet(record.id, 2, update('ready-unused'))?.revision, 3);
    assert.equal(store.isWorkspaceProtected('output'), true);
    assert.equal(store.compareAndSet(record.id, 3, update('closed'))?.revision, 4);
    assert.equal(store.isWorkspaceProtected('output'), false);
    assert.equal(store.isGroupProtected('group'), false);
    assert.equal(store.byWorkspaceId('output')[0]?.state, 'closed');
    assert.equal(store.compareAndSet(record.id, 4, update('pending')), null);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent database connections cannot overwrite a revision or clear another plan protection', () => {
  const dir = mkdtempSync('/tmp/opencode/planned-worktrees-');
  const file = join(dir, 'db.sqlite');
  const db1 = new DatabaseSync(file), db2 = new DatabaseSync(file);
  try {
    const a = createSqlitePlannedWorktrees(db1), b = createSqlitePlannedWorktrees(db2);
    a.create({ ...record, state: 'pending' });
    b.create({ ...record, id: 'second', state: 'pending' });
    assert.equal(a.compareAndSet(record.id, 0, update('unknown'))?.revision, 1);
    assert.equal(b.compareAndSet(record.id, 0, update('ready-unused')), null);
    assert.equal(b.compareAndSet(record.id, 1, update('closed'))?.revision, 2);
    assert.equal(a.isWorkspaceProtected('output'), true);
    assert.equal(a.byWorkspaceId('output').length, 2);
    assert.throws(() => a.create({ ...record, id: 'invalid', plan: { x: NaN } }), /invalid planned worktree JSON/);
    assert.throws(() => a.create({ ...record, id: 'invalid', protectedWorkspaceIds: [''] }), /invalid planned worktree protection ids/);
  } finally { db1.close(); db2.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('project and worker lookup is scoped and retains closed records across restart', () => {
  const dir = mkdtempSync('/tmp/opencode/planned-worktrees-');
  const file = join(dir, 'db.sqlite');
  let db = new DatabaseSync(file);
  try {
    let store = createSqlitePlannedWorktrees(db);
    store.create({ ...record, id: 'match-closed', state: 'pending' });
    store.create({ ...record, id: 'match-draft' });
    store.create({ ...record, id: 'other-project', projectId: 'other' });
    store.create({ ...record, id: 'other-worker', workerId: 'other' });
    assert.equal(store.compareAndSet('match-closed', 0, update('closed'))?.state, 'closed');
    db.close();
    db = new DatabaseSync(file);
    store = createSqlitePlannedWorktrees(db);
    assert.deepEqual(store.listByProjectWorker('project', 'worker').map(({ id, state }) => ({ id, state })), [
      { id: 'match-closed', state: 'closed' }, { id: 'match-draft', state: 'draft' }
    ]);
    assert.deepEqual(store.listByProjectWorker('other', 'worker').map(({ id }) => id), ['other-project']);
    assert.deepEqual(store.listByProjectWorker('project', 'other').map(({ id }) => id), ['other-worker']);
    assert.deepEqual(store.listByProjectWorker('other', 'other'), []);
    assert.throws(() => store.listByProjectWorker('', 'worker'), /invalid project or worker id/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed is a distinct terminal state without protections, retained across restart', () => {
  const dir = mkdtempSync('/tmp/opencode/planned-worktrees-');
  const file = join(dir, 'db.sqlite');
  let db = new DatabaseSync(file);
  try {
    let store = createSqlitePlannedWorktrees(db);
    store.create({ ...record, id: 'pending', state: 'pending' });
    store.create({ ...record, id: 'unknown', state: 'pending' });
    store.create({ ...record, id: 'ready', state: 'pending' });
    store.create({ ...record, id: 'draft' });
    store.create({ ...record, id: 'closed', state: 'pending' });
    assert.equal(store.compareAndSet('draft', 0, update('failed')), null);
    assert.equal(store.compareAndSet('ready', 0, update('ready-unused'))?.state, 'ready-unused');
    assert.equal(store.compareAndSet('ready', 1, update('failed')), null);
    assert.equal(store.compareAndSet('ready', 1, update('closed'))?.state, 'closed');
    assert.equal(store.compareAndSet('closed', 0, update('closed'))?.state, 'closed');
    assert.equal(store.compareAndSet('pending', 0, update('failed'))?.revision, 1);
    assert.equal(store.compareAndSet('unknown', 0, update('unknown'))?.revision, 1);
    assert.equal(store.compareAndSet('unknown', 1, update('failed'))?.revision, 2);
    assert.equal(store.isWorkspaceProtected('output'), false);
    assert.equal(store.isGroupProtected('group'), false);
    assert.equal(store.compareAndSet('pending', 1, update('pending')), null);
    assert.equal(store.compareAndSet('pending', 1, update('closed')), null);
    assert.equal(store.compareAndSet('pending', 1, update('failed')), null);
    db.close();
    db = new DatabaseSync(file);
    store = createSqlitePlannedWorktrees(db);
    assert.equal(store.get('pending')?.state, 'failed');
    assert.equal(store.get('unknown')?.state, 'failed');
    assert.equal(store.get('closed')?.state, 'closed');
    assert.equal(store.isWorkspaceProtected('base'), false);
    assert.equal(store.isGroupProtected('group'), false);
    assert.equal(store.byWorkspaceId('output').find(({ id }) => id === 'pending')?.state, 'failed');
    assert.equal(store.listByProjectWorker('project', 'worker').find(({ id }) => id === 'unknown')?.state, 'failed');
    assert.equal(store.compareAndSet('unknown', 2, update('closed')), null);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
