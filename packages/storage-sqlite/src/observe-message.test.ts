import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteMessageObserve, MESSAGE_OBSERVE_BY_ID_SQL, MESSAGE_OBSERVE_LIST_SQL } from './observe-message.ts';
import { createSqliteMessageStore } from './messages.ts';
import { openSqliteStore } from './store.ts';

test('message metadata is project scoped before the bounded stable scan and excludes unsafe columns and endpoints', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, deleted_at INTEGER);
      CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, task_id TEXT, origin_project_id TEXT);
      CREATE TABLE agent_messages(id TEXT PRIMARY KEY, project_id TEXT, from_session_id TEXT, target_session_id TEXT, reply_to TEXT, status TEXT, created_at INTEGER, delivered_at INTEGER, read_at INTEGER, handoff_origin TEXT, body TEXT, parts TEXT, to_address TEXT, trace_id TEXT);
      INSERT INTO projects VALUES ('p',NULL),('other',NULL),('deleted',1);
      INSERT INTO tasks VALUES ('t','p'),('wrong','other');
      INSERT INTO sessions VALUES ('a','t','p'),('b',NULL,'p'),('other',NULL,'other'),('bad','wrong','p'),('external:secret',NULL,'p');`);
    const insert = db.prepare('INSERT INTO agent_messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 505; i++) insert.run(`m${String(i).padStart(3, '0')}`, 'p', 'a', 'b', null, 'done', 100, 120, 130, null, 'secret-body', 'secret-parts', 'secret-address', 'secret-trace');
    for (let i = 0; i < 510; i++) insert.run(`foreign${i}`, 'other', 'other', 'other', null, 'done', 999, null, null, null, '', '', '', '');
    insert.run('bad-target', 'p', 'a', 'bad', null, 'done', 999, null, null, null, '', '', '', '');
    insert.run('external', 'p', 'external:secret', 'b', null, 'done', 999, null, null, null, '', '', '', '');
    insert.run('unresolved', 'p', 'a', null, null, 'done', 999, null, null, null, '', '', '', '');
    const records = createSqliteMessageObserve(db);
    const rows = records.list({ projectIds: ['p'], since: 100, limit: 9999 });
    assert.equal(rows.length, 501);
    assert.equal(rows[0]?.id, 'm504');
    assert.equal(rows[500]?.id, 'm004');
    assert.equal(rows[0]?.deliveredAt, 120);
    assert.equal(rows[0]?.readAt, 130);
    assert.equal(records.byId('bad-target'), null);
    assert.equal(records.byId('external'), null);
    assert.equal(records.byId('unresolved'), null);
    assert.equal(records.list({ projectIds: ['p'], since: 101, limit: 501 }).length, 0);
    assert.doesNotMatch(JSON.stringify(rows), /secret/);
  } finally { db.close(); }
});

test('native store with competing indexes uses the ordered message index for one and two project scopes; direct id uses primary key', () => {
  const store = openSqliteStore(':memory:');
  try {
    createSqliteMessageStore(store.db);
    createSqliteMessageObserve(store.db);
    const indexes = store.db.prepare('PRAGMA index_list(agent_messages)').all() as { name: string }[];
    assert.ok(indexes.some((index) => index.name === 'agent_messages_project'));
    for (const scope of [['p'], ['p', 'other']]) {
      const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${MESSAGE_OBSERVE_LIST_SQL}`).all(100, JSON.stringify(scope), 501) as { detail: string }[];
      const text = plan.map((entry) => entry.detail).join('\n');
      assert.match(text, /SEARCH m USING INDEX agent_messages_observe_time \(created_at>\?\)/);
      assert.doesNotMatch(text, /TEMP B-TREE FOR ORDER BY/);
      assert.match(plan[0]!.detail, /SEARCH m USING INDEX agent_messages_observe_time/);
    }
    const byIdPlan = store.db.prepare(`EXPLAIN QUERY PLAN ${MESSAGE_OBSERVE_BY_ID_SQL}`).all('m') as { detail: string }[];
    assert.match(byIdPlan.map((entry) => entry.detail).join('\n'), /SEARCH m USING INDEX sqlite_autoindex_agent_messages_1 \(id=\?\)/);
  } finally { store.close(); }
});
