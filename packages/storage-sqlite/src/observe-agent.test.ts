import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_OBSERVE_ENDED_SQL, AGENT_OBSERVE_FIRST_OUTPUT_SQL, createSqliteAgentObserve } from './observe-agent.ts';
import { openSqliteStore } from './store.ts';

type Fixture = ReturnType<typeof openFixture>;

function openFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, deleted_at INTEGER);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, task_id TEXT, origin_project_id TEXT);
    CREATE TABLE message_delivery (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
      payload TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE journal (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
      at INTEGER NOT NULL, PRIMARY KEY (session_id, seq)
    );
  `);
  const project = (id: string, deletedAt: number | null = null) =>
    db.prepare('INSERT INTO projects (id, deleted_at) VALUES (?, ?)').run(id, deletedAt);
  const task = (id: string, projectId: string) =>
    db.prepare('INSERT INTO tasks (id, project_id) VALUES (?, ?)').run(id, projectId);
  const session = (id: string, taskId: string | null, originProjectId: string | null = null) =>
    db.prepare('INSERT INTO sessions (id, task_id, origin_project_id) VALUES (?, ?, ?)').run(id, taskId, originProjectId);
  const delivery = (input: {
    id: string;
    sessionId: string;
    createdAt: number;
    kind?: string;
    state?: string;
    attempt?: number;
    seq?: number;
  }) =>
    db
      .prepare(
        `INSERT INTO message_delivery
          (id, session_id, seq, kind, payload, state, attempt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.sessionId,
        input.seq ?? 1,
        input.kind ?? 'prompt',
        JSON.stringify({ text: 'never expose me' }),
        input.state ?? 'queued',
        input.attempt ?? 0,
        input.createdAt,
        input.createdAt
      );
  const journal = (sessionId: string, seq: number, type: string, payload: string, at: number) =>
    db.prepare('INSERT INTO journal (session_id, seq, type, payload, at) VALUES (?, ?, ?, ?, ?)').run(sessionId, seq, type, payload, at);
  return { db, observe: createSqliteAgentObserve(db), project, task, session, delivery, journal };
}

function scopedFixture(): Fixture {
  const f = openFixture();
  f.project('p1');
  f.project('p2');
  f.project('p-deleted', 1);
  f.task('t1', 'p1');
  f.task('t2', 'p2');
  f.task('t-deleted', 'p-deleted');
  f.session('s-task', 't1');
  f.session('s-task-match', 't1', 'p1');
  f.session('s-task-conflict', 't1', 'p2');
  f.session('s-missing-task', 't-missing');
  f.session('s-container', null, 'p1');
  f.session('s-container-no-origin', null);
  f.session('s-container-deleted', null, 'p-deleted');
  f.session('s-other', 't2');

  f.delivery({ id: 'd-task', sessionId: 's-task', createdAt: 100 });
  f.delivery({ id: 'd-match', sessionId: 's-task-match', createdAt: 101 });
  f.delivery({ id: 'd-conflict', sessionId: 's-task-conflict', createdAt: 110 });
  f.delivery({ id: 'd-missing-task', sessionId: 's-missing-task', createdAt: 109 });
  f.delivery({ id: 'd-container', sessionId: 's-container', createdAt: 103, state: 'sending', attempt: 2 });
  f.delivery({ id: 'd-container-no-origin', sessionId: 's-container-no-origin', createdAt: 104 });
  f.delivery({ id: 'd-container-deleted', sessionId: 's-container-deleted', createdAt: 105 });
  f.delivery({ id: 'd-other', sessionId: 's-other', createdAt: 106 });
  f.delivery({ id: 'd-handoff', sessionId: 's-task', createdAt: 107, kind: 'handoff_brief' });
  f.delivery({ id: 'd-held-prompt', sessionId: 's-task', createdAt: 98, state: 'held', seq: 0 });
  f.delivery({ id: 'd-old', sessionId: 's-task', createdAt: 99 });
  f.delivery({ id: 'd-bad-state', sessionId: 's-task', createdAt: 108, state: 'pending' });
  return f;
}

test('firstOutput：精确 delivery 与 seq、坏 JSON 安全，查询只投影 at/seq 并命中索引', () => {
  const f = openFixture();
  const text = (id: string, extra = {}) => JSON.stringify({ kind: 'text', delta: 'private content', firstOutputDeliveryId: id, ...extra });
  f.journal('other', 3, 'text', text('a'), 30);
  f.journal('s1', 1, 'text', text('a'), 10);
  f.journal('s1', 2, 'text', '{bad', 20);
  f.journal('s1', 3, 'text', text('a', { subagentId: 'child' }), 30);
  f.journal('s1', 4, 'text', text('b'), 40);
  f.journal('s1', 5, 'text', text('a', { delta: '' }), 50);
  f.journal('s1', 6, 'text', text('a'), 60);
  f.journal('s1', 7, 'text', text('a'), 70);
  assert.deepEqual(f.observe.firstOutput('s1', 'a', 1, null), { seq: 6, at: 60 });
  assert.equal(f.observe.firstOutput('s1', 'a', 1, 6), null);
  assert.equal(f.observe.firstOutput('s1', 'missing', 1, null), null);
  const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${AGENT_OBSERVE_FIRST_OUTPUT_SQL}`).all('s1', 'a', 1, 9, 's1', 'a', 1);
  assert.match(JSON.stringify(plan), /SEARCH.*journal_observe_first_output/);
  assert.match(JSON.stringify(plan), /SEARCH.*journal_observe_ended_delivery/);
  f.journal('s1', 8, 'ended', JSON.stringify({ kind: 'ended', deliveryId: 'c', outcome: 'invalid' }), 80);
  f.journal('s1', 9, 'text', text('c'), 90);
  assert.equal(f.observe.ended('s1', 'c', 1), null);
  assert.equal(f.observe.firstOutput('s1', 'c', 1, null), null);
});

test('list：只列 prompt，项目范围先于 LIMIT，任务缺失 / 来源冲突 / 已删项目失败关闭', () => {
  const f = scopedFixture();
  const rows = f.observe.list({ projectIds: ['p1'], since: 100, limit: 20 });
  assert.deepEqual(rows.map((row) => row.id), ['d-container', 'd-match', 'd-task']);
  assert.deepEqual(rows.map((row) => row.projectId), ['p1', 'p1', 'p1']);
  assert.deepEqual(rows[0], {
    id: 'd-container',
    sessionId: 's-container',
    projectId: 'p1',
    seq: 1,
    state: 'sending',
    attempt: 2,
    createdAt: 103,
    updatedAt: 103
  });
  // 不返回 payload / last_error / 原文。
  assert.equal('payload' in rows[0]!, false);
  assert.equal('lastError' in rows[0]!, false);

  // 不可见项目里更新的行不能先占 LIMIT：范围过滤必须在 LIMIT 之前。
  assert.deepEqual(
    f.observe.list({ projectIds: ['p1'], since: 0, limit: 2 }).map((row) => row.id),
    ['d-container', 'd-match']
  );
  assert.deepEqual(f.observe.list({ projectIds: ['p2'], since: 0, limit: 20 }).map((row) => row.id), ['d-other']);
  assert.deepEqual(f.observe.list({ projectIds: [], since: 0, limit: 20 }), []);
});

test('list：created_at 新的在前，同刻按 id 倒序；最多 501 条', () => {
  const f = openFixture();
  f.project('p1');
  f.task('t1', 'p1');
  f.session('s1', 't1');
  for (let i = 0; i < 505; i += 1) {
    f.delivery({ id: `d-${String(i).padStart(3, '0')}`, sessionId: 's1', createdAt: 1_000 });
  }
  const rows = f.observe.list({ projectIds: ['p1'], since: 0, limit: 10_000 });
  assert.equal(rows.length, 501);
  assert.equal(rows[0]!.id, 'd-504');
  assert.equal(rows[500]!.id, 'd-004');

  const one = f.observe.list({ projectIds: ['p1'], since: 0, limit: 0 });
  assert.equal(one.length, 1, 'limit 至少为 1，不会退化成无界查询');
});

test('byId：同一套绑定投影；不受列表项目范围影响，但坏绑定 / 非 prompt 一律 null', () => {
  const f = scopedFixture();
  assert.equal(f.observe.byId('d-container')?.projectId, 'p1');
  assert.equal(f.observe.byId('d-other')?.projectId, 'p2');
  assert.equal(f.observe.byId('d-conflict'), null);
  assert.equal(f.observe.byId('d-missing-task'), null);
  assert.equal(f.observe.byId('d-container-no-origin'), null);
  assert.equal(f.observe.byId('d-container-deleted'), null);
  assert.equal(f.observe.byId('d-handoff'), null);
  assert.equal(f.observe.byId('d-bad-state'), null, '未知持久化状态不往读侧送');
  assert.equal(f.observe.byId('d-held-prompt')?.state, 'held');
  assert.equal(f.observe.ended('s-task', 'd-held-prompt', 0), null, '无有效来源 seq 不查结束结果');
  assert.equal(f.observe.byId('missing'), null);
});

test('ended：同会话 + 精确 deliveryId + seq > 来源，取最早一条；不按 prompt 窗口或状态推断', () => {
  const f = openFixture();
  const marker = 'Hermes 这一轮的结果未知（outcome_unknown）';
  f.journal('s1', 1, 'prompt', JSON.stringify({ kind: 'prompt', text: 'secret' }), 10);
  f.journal('s1', 2, 'ended', JSON.stringify({ kind: 'ended', outcome: 'failed', deliveryId: 'other' }), 20);
  f.journal('s1', 3, 'ended', JSON.stringify({ kind: 'ended', outcome: 'done', deliveryId: 'd1' }), 30);
  f.journal('s1', 4, 'ended', JSON.stringify({ kind: 'ended', outcome: 'interrupted', reason: marker, deliveryId: 'd1' }), 40);
  f.journal('s1', 5, 'ended', '{not json', 50);
  f.journal('s1', 6, 'ended', JSON.stringify({ kind: 'ended', outcome: 'interrupted', reason: marker, deliveryId: 'd1' }), 60);
  f.journal('s1', 7, 'ended', JSON.stringify({ kind: 'ended', outcome: 'weird', deliveryId: 'd1' }), 70);
  f.journal('s1', 8, 'ended', JSON.stringify({ kind: 'ended', outcome: 'done', reason: marker, deliveryId: 'd1' }), 80);
  f.journal('s1', 9, 'ended', JSON.stringify({ kind: 'text', delta: 'not an ended' }), 90);
  // 坏 JSON 在更早的位置：能取到后面的有效 ended，说明 json_extract 被 CASE 挡住而不是靠 AND 顺序。
  f.journal('s-bad', 1, 'ended', '{not json', 10);
  f.journal('s-bad', 2, 'ended', JSON.stringify({ kind: 'ended', outcome: 'done', deliveryId: 'd1' }), 20);

  assert.deepEqual(f.observe.ended('s1', 'd1', 2), { seq: 3, at: 30, outcome: 'done', unknownOutcome: false });
  assert.deepEqual(f.observe.ended('s1', 'd1', 3), { seq: 4, at: 40, outcome: 'interrupted', unknownOutcome: true });
  // 坏 JSON 不抛错；越过它仍取最早的有效精确匹配。
  assert.deepEqual(f.observe.ended('s1', 'd1', 5), { seq: 6, at: 60, outcome: 'interrupted', unknownOutcome: true });
  // 无效 outcome 失败关闭，不跳到后面「看起来更好」的 ended。
  assert.equal(f.observe.ended('s1', 'd1', 6), null);
  // 只有 interrupted + 持久化标记才算结果未知；done 里的同名字样不算。
  assert.deepEqual(f.observe.ended('s1', 'd1', 7), { seq: 8, at: 80, outcome: 'done', unknownOutcome: false });
  assert.equal(f.observe.ended('s1', 'd1', 8), null);
  // deliveryId 必须精确相等。
  assert.deepEqual(f.observe.ended('s1', 'other', 1), { seq: 2, at: 20, outcome: 'failed', unknownOutcome: false });
  assert.equal(f.observe.ended('s1', 'd1', 100), null);
  assert.deepEqual(f.observe.ended('s-bad', 'd1', 1), { seq: 2, at: 20, outcome: 'done', unknownOutcome: false });
  for (const seq of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    assert.equal(f.observe.ended('s-bad', 'd1', seq as number), null);
  }
});

test('promptActor：同会话和 delivery seq 精确关联，脏数据及旧数据不猜', () => {
  const f = openFixture();
  f.project('p1'); f.task('t1', 'p1'); f.session('s1', 't1'); f.session('s2', 't1');
  f.delivery({ id: 'a', sessionId: 's1', seq: 1, createdAt: 1 });
  f.delivery({ id: 'b', sessionId: 's1', seq: 2, createdAt: 2 });
  f.journal('s1', 1, 'prompt', JSON.stringify({ kind: 'prompt', promptActor: 'account', text: 'private text', author: { name: 'private name', via: 'private token' } }), 1);
  f.journal('s1', 2, 'prompt', JSON.stringify({ kind: 'prompt', promptActor: 'token' }), 2);
  f.journal('s2', 1, 'prompt', JSON.stringify({ kind: 'prompt', promptActor: 'system' }), 1);
  f.journal('s1', 3, 'prompt', '{broken', 3);
  f.journal('s1', 4, 'prompt', JSON.stringify({ kind: 'prompt', author: { via: 'token' } }), 4);
  f.journal('s1', 5, 'prompt', JSON.stringify({ kind: 'prompt', promptActor: 'private token' }), 5);
  f.journal('s1', 6, 'prompt', JSON.stringify({ kind: 'text', promptActor: 'account' }), 6);
  f.journal('s1', 7, 'text', JSON.stringify({ kind: 'prompt', promptActor: 'account' }), 7);
  f.journal('s1', 8, 'prompt', JSON.stringify({ kind: 'prompt', promptActor: 'unknown' }), 8);
  for (const [id, expected] of [['a', 'account'], ['b', 'token']]) {
    const row = f.observe.byId(id!)!;
    assert.equal(f.observe.promptActor(row.sessionId, row.seq), expected);
    assert.doesNotMatch(JSON.stringify(row), /private/);
  }
  assert.equal(f.observe.promptActor('s2', 1), 'system');
  assert.equal(f.observe.promptActor('s1', 8), 'unknown');
  for (const seq of [0, 3, 4, 5, 6, 7, 9, -1, 1.5, NaN]) assert.equal(f.observe.promptActor('s1', seq), null);
});

test('查询计划：prompt 列表走新增索引，不在内存里重排', () => {
  const f = openFixture();
  const plan = f.db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT d.id, d.session_id, d.seq, d.state, d.attempt, d.created_at, d.updated_at,
         CASE WHEN s.task_id IS NOT NULL THEN t.project_id ELSE s.origin_project_id END AS project_id
       FROM message_delivery d
       JOIN sessions s ON s.id = d.session_id
       LEFT JOIN tasks t ON t.id = s.task_id
       JOIN projects p ON p.id = CASE WHEN s.task_id IS NOT NULL THEN t.project_id ELSE s.origin_project_id END
       WHERE d.kind = 'prompt'
         AND d.state IN ('queued','sending','delivered','undelivered','cancelled','held')
         AND p.deleted_at IS NULL
         AND ((s.task_id IS NOT NULL AND t.id IS NOT NULL
           AND (s.origin_project_id IS NULL OR s.origin_project_id = t.project_id))
           OR (s.task_id IS NULL AND s.origin_project_id IS NOT NULL))
         AND d.created_at >= ?
         AND p.id IN (SELECT value FROM json_each(?))
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT ?`
    )
    .all() as unknown as { detail: string }[];
  const text = plan.map((row) => row.detail).join('\n');
  assert.match(text, /message_delivery_observe_prompt/);
  assert.doesNotMatch(text, /TEMP B-TREE FOR ORDER BY/);
});

test('查询计划：ended 通过精确 deliveryId 和 seq 定位，缺失 ID 不扫会话后缀', () => {
  const f = openFixture();
  for (let seq = 2; seq <= 1201; seq++) {
    f.journal('long-session', seq, 'ended', JSON.stringify({ kind: 'ended', outcome: 'done', deliveryId: `other-${seq}` }), seq);
  }
  assert.equal(f.observe.ended('long-session', 'missing-old-id', 1), null);
  const plan = f.db
    .prepare(`EXPLAIN QUERY PLAN ${AGENT_OBSERVE_ENDED_SQL}`)
    .all('outcome_unknown', 'long-session', 1, 'missing-old-id') as unknown as { detail: string }[];
  const text = plan.map((row) => row.detail).join('\n');
  assert.match(text, /SEARCH journal USING INDEX journal_observe_ended_delivery \(session_id=\? AND <expr>=\? AND seq>\?\)/);
  assert.doesNotMatch(text, /SCAN journal/);
  assert.doesNotMatch(text, /TEMP B-TREE FOR ORDER BY/);
});

test('标准 SQLite 初始化在含坏 JSON 的旧 journal 上建索引并可重复初始化', () => {
  const store = openSqliteStore(':memory:');
  try {
    const insert = store.db.prepare('INSERT INTO journal (session_id, seq, type, payload, at) VALUES (?, ?, ?, ?, ?)');
    insert.run('legacy', 2, 'ended', '{broken', 2);
    insert.run('legacy', 3, 'ended', JSON.stringify({ kind: 'ended', deliveryId: 42, outcome: 'done' }), 3);
    insert.run('legacy', 4, 'ended', JSON.stringify({ kind: 'ended', deliveryId: 'd', outcome: 'done' }), 4);
    const observe = createSqliteAgentObserve(store.db);
    createSqliteAgentObserve(store.db);
    assert.deepEqual(observe.ended('legacy', 'd', 1), { seq: 4, at: 4, outcome: 'done', unknownOutcome: false });
  } finally {
    store.close();
  }
});
