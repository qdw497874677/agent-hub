import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteWorkObserve } from './observe-work.ts';
import { createSqliteTaskDispatch } from './task-dispatch.ts';
import { createSqliteWorkspaceDelegations } from './workspace-delegation.ts';
import { createSqliteDelegationAcceptances } from './delegation-acceptance.ts';
import { createSqliteDelegationPublishAttempts } from './workspace-delegation-publish.ts';

test('owner, current task/project and time scope precede deterministic 501 bound; only safe columns leave SQL', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, deleted_at INTEGER);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT);
      CREATE TABLE task_dispatch (id TEXT, account_id TEXT, project_id TEXT, task_id TEXT, session_id TEXT, state TEXT, created_at INTEGER, notified INTEGER, goal TEXT, result TEXT);
      CREATE TABLE workspace_delegation (id TEXT, account_id TEXT, project_id TEXT, task_id TEXT, execution_session_id TEXT, state TEXT, created_at INTEGER, instructions TEXT);
      INSERT INTO projects VALUES ('p',NULL),('other',NULL),('deleted',1);
      INSERT INTO tasks VALUES ('t','p'),('o','other'),('gone','deleted');`);
    const insert = db.prepare('INSERT INTO task_dispatch VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 505; i++) insert.run(`d${String(i).padStart(3, '0')}`, 'u', 'p', 't', null, 'queued', 100, 0, 'secret', 'secret');
    insert.run('other-owner', 'v', 'p', 't', null, 'running', 999, 1, 'secret', 'secret');
    insert.run('mismatch', 'u', 'p', 'o', null, 'running', 999, 1, 'secret', 'secret');
    insert.run('deleted', 'u', 'deleted', 'gone', null, 'running', 999, 1, 'secret', 'secret');
    insert.run('bad-state', 'u', 'p', 't', null, 'secret', 999, 1, 'secret', 'secret');
    db.exec("INSERT INTO workspace_delegation VALUES ('w','u','p','t','reserved','uncertain',101,'secret')");
    const records = createSqliteWorkObserve(db);
    const rows = records.list('dispatch', { accountId: 'u', projectIds: ['p'], since: 100, limit: 10000 });
    assert.equal(rows.length, 501);
    assert.equal(rows[0]?.id, 'd504');
    assert.equal(rows[500]?.id, 'd004');
    assert.equal(records.byId('dispatch', 'other-owner', 'u'), null);
    assert.equal(records.byId('dispatch', 'mismatch', 'u'), null);
    assert.equal(records.byId('dispatch', 'deleted', 'u'), null);
    assert.equal(records.list('dispatch', { accountId: 'u', projectIds: ['other'], since: 0, limit: 501 }).length, 0);
    assert.equal(records.list('dispatch', { accountId: 'u', projectIds: ['p'], since: 101, limit: 501 }).length, 0);
    assert.equal(records.byId('delegation', 'w', 'u')?.state, 'uncertain');
    assert.equal(JSON.stringify([rows, records.byId('delegation', 'w', 'u')]).includes('secret'), false);
  } finally { db.close(); }
});

test('detail evidence reads bounded indexed exact delegation projections without private columns', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, deleted_at INTEGER); CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)');
    createSqliteTaskDispatch(db);
    createSqliteWorkspaceDelegations(db);
    createSqliteDelegationAcceptances(db);
    createSqliteDelegationPublishAttempts(db);
    const records = createSqliteWorkObserve(db);
    const sha = 'a'.repeat(40);
    const acceptance = db.prepare('INSERT INTO delegation_acceptance (delegation_id, request_key, sha, actor_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const attempt = db.prepare('INSERT INTO delegation_publish_attempt (delegation_id, approval_key, fingerprint, head_sha, state, created_at, updated_at, failure_message, remote_json, observe_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 24; i++) {
      acceptance.run('d', `secret-key-${i}`, sha, 'secret-actor', 'secret-note', i);
      attempt.run('d', `secret-approval-${i}`, 'secret-fingerprint', sha, i === 23 ? 'uncertain' : 'failed', i, i, 'secret-error', 'secret-json', i.toString(16).padStart(32, '0'));
    }
    acceptance.run('other', 'key', sha, 'actor', 'note', 999);
    attempt.run('other', 'key', 'fingerprint', sha, 'published', 999, 999, 'error', 'json', 'f'.repeat(32));
    const result = records.evidence('d');
    assert.equal(result.acceptances.length, 21);
    assert.equal(result.attempts.length, 21);
    assert.equal(result.attempts[0]?.state, 'uncertain');
    assert.equal(new Set(result.attempts.map((r) => r.nodeIdentity)).size, 21);
    assert.ok([...result.acceptances, ...result.attempts].every((r) => r.delegationId === 'd' && r.sha === sha));
    assert.doesNotMatch(JSON.stringify(result), /secret|other/);
    for (const sql of [
      'SELECT rowid, delegation_id, sha, created_at FROM delegation_acceptance WHERE delegation_id = ? ORDER BY seq DESC LIMIT 21',
      'SELECT observe_id, delegation_id, head_sha, state, updated_at FROM delegation_publish_attempt WHERE delegation_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 21'
    ]) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('d') as { detail: string }[];
      assert.ok(plan.some((p) => p.detail.includes('USING INDEX') || p.detail.includes('USING COVERING INDEX')));
      assert.ok(!plan.some((p) => p.detail.includes('TEMP B-TREE')));
    }
  } finally { db.close(); }
});

test('provisioned stores admit ordered owner/time indexes without a temporary sort', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, deleted_at INTEGER); CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)');
    createSqliteTaskDispatch(db);
    createSqliteWorkspaceDelegations(db);
    createSqliteWorkObserve(db);
    createSqliteWorkObserve(db);
    for (const [table, states] of [['task_dispatch', "'queued','running','done','failed','cancelled'"], ['workspace_delegation', "'pending','preparing','prepared','failed','uncertain','cancelled'"]] as const) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT w.id FROM ${table} w
        JOIN tasks t ON t.id = w.task_id AND t.project_id = w.project_id
        JOIN projects p ON p.id = w.project_id AND p.deleted_at IS NULL
        WHERE w.account_id = ? AND w.state IN (${states}) AND w.created_at >= ?
          AND w.project_id IN (SELECT value FROM json_each(?))
        ORDER BY w.created_at DESC, w.id DESC LIMIT ?`).all('u', 0, '["p"]', 501) as { detail: string }[];
      assert.ok(plan.some((entry) => entry.detail.includes(`${table}_observe_owner_time`)));
      assert.ok(!plan.some((entry) => entry.detail.includes('TEMP B-TREE')));
    }
  } finally { db.close(); }
});
