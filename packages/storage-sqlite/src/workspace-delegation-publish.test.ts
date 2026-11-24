import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteDelegationPublishAttempts } from './workspace-delegation-publish.ts';
import { createSqliteWorkObserve } from './observe-work.ts';
import { createSqliteTaskDispatch } from './task-dispatch.ts';
import { createSqliteWorkspaceDelegations } from './workspace-delegation.ts';
import { createSqliteDelegationAcceptances } from './delegation-acceptance.ts';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

test('legacy migration persists private random observation identities across CAS and rowid-changing rebuild', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, deleted_at INTEGER);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT);
      CREATE TABLE delegation_publish_attempt (
        delegation_id TEXT NOT NULL, approval_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        head_sha TEXT NOT NULL, state TEXT NOT NULL, claim_owner TEXT, claim_token TEXT,
        claim_at INTEGER, claim_expires_at INTEGER, failure_kind TEXT, failure_message TEXT,
        failure_at INTEGER, remote_json TEXT, pull_request_json TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY (delegation_id, approval_key));`);
    createSqliteTaskDispatch(db);
    createSqliteWorkspaceDelegations(db);
    createSqliteDelegationAcceptances(db);
    const insert = db.prepare(`INSERT INTO delegation_publish_attempt
      (delegation_id, approval_key, fingerprint, head_sha, state, created_at, updated_at)
      VALUES (?, ?, 'secret-fingerprint', ?, 'failed', 1, 1)`);
    insert.run('discard', 'secret-discard', SHA);
    insert.run('d1', 'secret-first', SHA);
    insert.run('d1', 'secret-second', SHA);
    db.exec("DELETE FROM delegation_publish_attempt WHERE delegation_id = 'discard'");
    const store = createSqliteDelegationPublishAttempts(db);
    createSqliteDelegationPublishAttempts(db); // idempotent migration
    const observe = createSqliteWorkObserve(db);
    const before = observe.evidence('d1').attempts;
    assert.equal(before.length, 2);
    assert.equal(new Set(before.map((r) => r.nodeIdentity)).size, 2);
    assert.ok(before.every((r) => /^[0-9a-f]{32}$/.test(r.nodeIdentity) && r.sha === SHA));
    assert.doesNotMatch(JSON.stringify(before), /secret/);
    const rowsBefore = db.prepare('SELECT rowid, observe_id FROM delegation_publish_attempt ORDER BY rowid').all() as { rowid: number; observe_id: string }[];
    const change = await store.compareAndSet({ delegationId: 'd1', approvalKey: 'secret-first', expect: { state: 'failed', claimToken: null }, state: 'uncertain', at: 20 });
    assert.equal(change.ok, true);
    const schema = (db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'delegation_publish_attempt'").get() as { sql: string }).sql;
    db.exec(`${schema.replace('CREATE TABLE delegation_publish_attempt', 'CREATE TABLE publish_rebuilt')};
      INSERT INTO publish_rebuilt SELECT * FROM delegation_publish_attempt ORDER BY rowid;
      DROP TABLE delegation_publish_attempt;
      ALTER TABLE publish_rebuilt RENAME TO delegation_publish_attempt`);
    createSqliteDelegationPublishAttempts(db);
    const rowsAfter = db.prepare('SELECT rowid, observe_id FROM delegation_publish_attempt ORDER BY rowid').all() as { rowid: number; observe_id: string }[];
    assert.notDeepEqual(rowsAfter.map((r) => r.rowid), rowsBefore.map((r) => r.rowid));
    assert.deepEqual(rowsAfter.map((r) => r.observe_id), rowsBefore.map((r) => r.observe_id));
    assert.deepEqual(new Set(observe.evidence('d1').attempts.map((r) => r.nodeIdentity)), new Set(before.map((r) => r.nodeIdentity)));
    assert.throws(() => db.prepare("UPDATE delegation_publish_attempt SET observe_id = ? WHERE approval_key = 'secret-second'").run(rowsBefore[0]!.observe_id), /UNIQUE/);
    const created = await store.insert(attempt({ delegationId: 'new', approvalKey: 'secret-new' }));
    assert.equal(created.outcome, 'created');
    const newId = (db.prepare("SELECT observe_id FROM delegation_publish_attempt WHERE delegation_id = 'new'").get() as { observe_id: string }).observe_id;
    assert.match(newId, /^[0-9a-f]{32}$/);
    assert.ok(!rowsBefore.some((r) => r.observe_id === newId));
    assert.equal(Object.hasOwn(created.attempt, 'observeId'), false);
  } finally { db.close(); }
});

const claim = (token: string, at: number, ttlMs = 300) => ({ owner: 'u1', token, at, expiresAt: at + ttlMs });

const remote = (over: Record<string, unknown> = {}) => ({
  sha: SHA,
  branch: 'dlg/d1',
  baseBranch: 'main',
  baseSha: BASE,
  defaultBranch: 'main',
  remoteSha: SHA,
  published: true,
  ...over
});

const pullRequest = (over: Record<string, unknown> = {}) => ({
  repo: 'test/project',
  number: 7,
  url: 'https://github.com/test/project/pull/7',
  headRef: 'dlg/d1',
  headSha: SHA,
  base: 'main',
  baseRepo: 'test/project',
  state: 'open',
  draft: true,
  ...over
});

type Store = ReturnType<typeof createSqliteDelegationPublishAttempts>;

function attempt(over: Record<string, unknown> = {}) {
  return {
    delegationId: 'd1',
    approvalKey: 'k1',
    fingerprint: 'fp-1',
    headSha: SHA,
    claim: claim('c1', 100),
    at: 100,
    ...over
  } as Parameters<Store['insert']>[0];
}

function cas(over: Record<string, unknown> = {}) {
  return {
    delegationId: 'd1',
    approvalKey: 'k1',
    expect: { state: 'publishing', claimToken: 'c1' },
    state: 'failed',
    at: 200,
    claim: null,
    failure: { kind: 'fatal', message: '发布分支失败', at: 200 },
    ...over
  } as Parameters<Store['compareAndSet']>[0];
}

test('插入 / byKey / latest：同键只建一次，exists 不覆盖原记录', async () => {
  const store = createSqliteDelegationPublishAttempts(new DatabaseSync(':memory:'));
  const first = await store.insert(attempt());
  assert.equal(first.outcome, 'created');
  assert.equal(first.attempt.state, 'publishing');
  assert.deepEqual(first.attempt.claim, claim('c1', 100));
  assert.equal(first.attempt.failure, null);
  assert.equal(first.attempt.remote, null);
  assert.equal(first.attempt.pullRequest, null);
  assert.equal(first.attempt.createdAt, 100);
  assert.equal(first.attempt.updatedAt, 100);
  assert.deepEqual(await store.byKey('d1', 'k1'), first.attempt);
  assert.deepEqual(await store.latest('d1'), first.attempt);
  assert.equal(await store.byKey('d1', 'k2'), null);
  assert.equal(await store.latest('d-missing'), null);

  const replayed = await store.insert(attempt({ fingerprint: 'fp-2', headSha: OTHER, at: 900 }));
  assert.equal(replayed.outcome, 'exists');
  assert.equal(replayed.attempt.fingerprint, 'fp-1');
  assert.equal(replayed.attempt.headSha, SHA);
  assert.equal(replayed.attempt.updatedAt, 100);
  assert.equal((await store.byKey('d1', 'k1'))?.fingerprint, 'fp-1');
  assert.equal((await store.latest('d1'))?.approvalKey, 'k1');
});

test('不同批准键：publishing / uncertain / published 原子挡住新键，failed 放行', async () => {
  const store = createSqliteDelegationPublishAttempts(new DatabaseSync(':memory:'));
  await store.insert(attempt());

  const blockedByPublishing = await store.insert(attempt({ approvalKey: 'k2', fingerprint: 'fp-2' }));
  assert.equal(blockedByPublishing.outcome as string, 'blocked');
  assert.equal(blockedByPublishing.attempt.approvalKey, 'k1');
  assert.equal(blockedByPublishing.attempt.state, 'publishing');
  assert.equal(await store.byKey('d1', 'k2'), null);

  const failed = await store.compareAndSet(cas());
  assert.equal(failed.ok, true);
  assert.equal(failed.attempt?.state, 'failed');
  assert.equal(failed.attempt?.claim, null);
  assert.equal(failed.attempt?.failure?.kind, 'fatal');

  const retryOtherKey = await store.insert(attempt({ approvalKey: 'k2', fingerprint: 'fp-2', at: 250 }));
  assert.equal(retryOtherKey.outcome, 'created');
  assert.equal(retryOtherKey.attempt.approvalKey, 'k2');

  const uncertain = await store.compareAndSet(cas({
    approvalKey: 'k2',
    expect: { state: 'publishing', claimToken: 'c1' },
    state: 'uncertain',
    at: 260,
    claim: null,
    failure: { kind: 'uncertain', message: '建 PR 结果不明', at: 260 }
  }));
  assert.equal(uncertain.ok, true);
  assert.equal(uncertain.attempt?.state, 'uncertain');

  const blockedByUncertain = await store.insert(attempt({ approvalKey: 'k3', fingerprint: 'fp-3' }));
  assert.equal(blockedByUncertain.outcome as string, 'blocked');
  assert.equal(blockedByUncertain.attempt.approvalKey, 'k2');
  assert.equal(blockedByUncertain.attempt.state, 'uncertain');

  const published = await store.compareAndSet(cas({
    approvalKey: 'k2',
    expect: { state: 'uncertain', claimToken: null },
    state: 'published',
    at: 300,
    claim: null,
    failure: null,
    remote: remote(),
    pullRequest: pullRequest()
  }));
  assert.equal(published.ok, true);
  assert.equal(published.attempt?.state, 'published');

  const blockedByPublished = await store.insert(attempt({ approvalKey: 'k4', fingerprint: 'fp-4' }));
  assert.equal(blockedByPublished.outcome as string, 'blocked');
  assert.equal(blockedByPublished.attempt.approvalKey, 'k2');
  assert.equal(blockedByPublished.attempt.state, 'published');
  assert.equal(await store.byKey('d1', 'k4'), null);

  // 已 failed 的 k1 想重新进入 publishing，也要被 k2 的终态挡住。
  const transitionBlocked = await store.compareAndSet(cas({
    approvalKey: 'k1',
    expect: { state: 'failed', claimToken: null },
    state: 'publishing',
    at: 400,
    claim: claim('c2', 400)
  }));
  assert.equal(transitionBlocked.ok, false);
  assert.equal(transitionBlocked.attempt?.approvalKey, 'k2');
  assert.equal(transitionBlocked.attempt?.state, 'published');
  assert.equal((await store.byKey('d1', 'k1'))?.state, 'failed');
});

test('CAS：预期状态与 claim token 都匹配才生效；可选项省略不改、null 清空', async () => {
  const store = createSqliteDelegationPublishAttempts(new DatabaseSync(':memory:'));
  await store.insert(attempt());

  const wrongToken = await store.compareAndSet(cas({ expect: { state: 'publishing', claimToken: 'stale' } }));
  assert.equal(wrongToken.ok, false);
  assert.equal(wrongToken.attempt?.state, 'publishing');
  assert.equal(wrongToken.attempt?.claim?.token, 'c1');

  const wrongState = await store.compareAndSet(cas({ expect: { state: 'failed', claimToken: 'c1' } }));
  assert.equal(wrongState.ok, false);
  assert.equal(wrongState.attempt?.state, 'publishing');

  // 留在 publishing，只写 remote；省略 claim 不丢领取凭据。
  const remoteOnly = await store.compareAndSet(cas({
    state: 'publishing',
    at: 150,
    claim: undefined,
    failure: undefined,
    remote: remote()
  }));
  assert.equal(remoteOnly.ok, true);
  assert.equal(remoteOnly.attempt?.claim?.token, 'c1');
  assert.equal(remoteOnly.attempt?.remote?.sha, SHA);

  const failed = await store.compareAndSet(cas({ at: 200 }));
  assert.equal(failed.ok, true);
  assert.equal(failed.attempt?.claim, null);
  assert.equal(failed.attempt?.failure?.kind, 'fatal');

  const retry = await store.compareAndSet(cas({
    expect: { state: 'failed', claimToken: null },
    state: 'publishing',
    at: 250,
    claim: claim('c2', 250)
  }));
  assert.equal(retry.ok, true);
  assert.equal(retry.attempt?.state, 'publishing');
  assert.equal(retry.attempt?.claim?.token, 'c2');

  const done = await store.compareAndSet(cas({
    expect: { state: 'publishing', claimToken: 'c2' },
    state: 'published',
    at: 300,
    claim: null,
    failure: null,
    remote: remote(),
    pullRequest: pullRequest()
  }));
  assert.equal(done.ok, true);
  assert.equal(done.attempt?.claim, null);
  assert.equal(done.attempt?.failure, null);
  assert.deepEqual(done.attempt?.remote, remote());
  assert.deepEqual(done.attempt?.pullRequest, pullRequest());
  assert.equal(done.attempt?.updatedAt, 300);
});

test('latest：按 updated_at 取最近一条，不按创建顺序猜', async () => {
  const store = createSqliteDelegationPublishAttempts(new DatabaseSync(':memory:'));
  await store.insert(attempt());
  await store.compareAndSet(cas({ at: 200 }));
  await store.insert(attempt({ approvalKey: 'k2', fingerprint: 'fp-2', at: 150, claim: claim('c2', 150) }));
  assert.equal((await store.latest('d1'))?.approvalKey, 'k1');
  assert.equal((await store.latest('d1'))?.updatedAt, 200);

  await store.compareAndSet(cas({
    approvalKey: 'k2',
    expect: { state: 'publishing', claimToken: 'c2' },
    state: 'failed',
    at: 400,
    claim: null
  }));
  assert.equal((await store.latest('d1'))?.approvalKey, 'k2');
  assert.equal((await store.latest('d1'))?.updatedAt, 400);
});

test('SQLite 重新打开后仍能读全字段，并且终态继续挡住别的批准键', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-publish-'));
  const file = join(dir, 'publish.db');
  try {
    const first = new DatabaseSync(file);
    const store = createSqliteDelegationPublishAttempts(first);
    await store.insert(attempt());
    const done = await store.compareAndSet(cas({
      expect: { state: 'publishing', claimToken: 'c1' },
      state: 'published',
      at: 300,
      claim: null,
      failure: null,
      remote: remote(),
      pullRequest: pullRequest()
    }));
    assert.equal(done.ok, true);
    first.close();

    const reopened = createSqliteDelegationPublishAttempts(new DatabaseSync(file));
    const record = await reopened.byKey('d1', 'k1');
    assert.deepEqual(record, done.attempt);
    assert.deepEqual((await reopened.latest('d1'))?.pullRequest, pullRequest());
    const blocked = await reopened.insert(attempt({ approvalKey: 'k2', fingerprint: 'fp-2' }));
    assert.equal(blocked.outcome as string, 'blocked');
    assert.equal(blocked.attempt.approvalKey, 'k1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
