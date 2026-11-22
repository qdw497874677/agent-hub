import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { asTaskId } from '@agent-hub/domain';
import { createTaskArchiveBlockers } from './task-archive-blockers.ts';

test('archive blockers are task scoped, including expired unresolved publish claims', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE task_dispatch (task_id TEXT, state TEXT);
    CREATE TABLE workspace_delegation (id TEXT, task_id TEXT, state TEXT);
    CREATE TABLE delegation_publish_attempt (delegation_id TEXT, state TEXT, claim_expires_at INTEGER);
    INSERT INTO task_dispatch VALUES ('task-a', 'queued'), ('task-other', 'running');
    INSERT INTO workspace_delegation VALUES ('delegation-a', 'task-a', 'uncertain');
    INSERT INTO delegation_publish_attempt VALUES ('delegation-a', 'publishing', 0);`);
  const check = createTaskArchiveBlockers(db);
  const task = asTaskId('task-a');
  assert.equal(await check(task), 'dispatch');
  db.exec("UPDATE task_dispatch SET state = 'done' WHERE task_id = 'task-a'");
  assert.equal(await check(task), 'delegation');
  db.exec("UPDATE workspace_delegation SET state = 'prepared'");
  assert.equal(await check(task), 'publish');
  db.exec("UPDATE delegation_publish_attempt SET state = 'uncertain'");
  assert.equal(await check(task), 'publish');
  db.exec("UPDATE delegation_publish_attempt SET state = 'published'");
  assert.equal(await check(task), null);
});
