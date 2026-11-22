import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asProjectId, asSessionId, asTaskId } from '@agent-hub/domain';
import { createSqliteWorkspaceDelegations } from './workspace-delegation.ts';

const at = (n: number) => n;

function allocation(over: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    accountId: 'u1',
    coordinatorSessionId: asSessionId('main'),
    requestKey: 'req-1',
    requestFingerprint: 'fp-1',
    projectId: asProjectId('p1'),
    taskId: asTaskId('t1'),
    repoId: 'r1',
    repoUrl: 'https://github.com/test/project',
    workerId: 'w1',
    baseBranch: 'main',
    instructions: '实现并测试',
    startup: {
      agentId: 'codex',
      model: 'gpt-5-codex',
      profileId: 'profile-1',
      options: { sandbox: 'workspace-write', approval: false }
    },
    executionSessionId: asSessionId('exec-1'),
    worktreePath: '/tmp/wt/d1',
    branch: 'dlg/d1',
    at: 100,
    ...over
  } as Parameters<ReturnType<typeof createSqliteWorkspaceDelegations>['allocate']>[0];
}

const claim = (token: string, at: number, ttlMs = 50) => ({ owner: 'hub-1', token, at, expiresAt: at + ttlMs });

test('分配：同主会话同请求键只一条记录；同键不同指纹是 conflict', async () => {
  const store = createSqliteWorkspaceDelegations(new DatabaseSync(':memory:'));
  const first = await store.allocate(allocation());
  assert.equal(first.outcome, 'created');
  assert.equal(first.record.state, 'pending');
  assert.equal(first.record.executionSessionId, 'exec-1');
  assert.equal((await store.byExecutionSession(asSessionId('exec-1')))?.id, 'd1');
  assert.equal(await store.byExecutionSession(asSessionId('exec-missing')), null);

  const reused = await store.allocate(allocation({ id: 'd-other', at: 200 }));
  assert.equal(reused.outcome, 'reused');
  assert.equal(reused.record.id, 'd1');
  assert.equal(reused.record.executionSessionId, 'exec-1');
  assert.equal(reused.record.createdAt, 100);
  assert.equal((await store.allocate(allocation({ at: 300 }))).outcome, 'reused');
  assert.equal((await store.byCoordinator(asSessionId('main'))).length, 1);

  const conflict = await store.allocate(allocation({ id: 'd-other', requestFingerprint: 'fp-2' }));
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(conflict.record.id, 'd1');
  assert.equal(conflict.record.requestFingerprint, 'fp-1');
  assert.equal((await store.byCoordinator(asSessionId('main'))).length, 1);

  const identityConflict = await store.allocate(allocation({ id: 'd3', requestKey: 'req-2', executionSessionId: asSessionId('exec-1') }));
  assert.equal(identityConflict.outcome, 'conflict');
  assert.equal(identityConflict.record.id, 'd1');
  assert.equal(await store.byCoordinatorRequest(asSessionId('main'), 'req-2'), null);
  assert.equal((await store.byCoordinator(asSessionId('main'))).length, 1);

  const otherCoordinator = await store.allocate(allocation({
    coordinatorSessionId: asSessionId('main-2'), id: 'd2', executionSessionId: asSessionId('exec-2')
  }));
  assert.equal(otherCoordinator.outcome, 'created');
  assert.equal((await store.byCoordinatorRequest(asSessionId('main-2'), 'req-1'))?.id, 'd2');
  assert.equal((await store.byExecutionSession(asSessionId('exec-2')))?.id, 'd2');
  assert.equal((await store.byCoordinator(asSessionId('main-2'))).length, 1);
});

test('领取：pending 才能领取；活跃租期 busy，过期只报告 expired 且不接管', async () => {
  const store = createSqliteWorkspaceDelegations(new DatabaseSync(':memory:'));
  await store.allocate(allocation());

  const first = await store.claim('d1', claim('c1', at(100)));
  assert.equal(first.outcome, 'claimed');
  assert.equal(first.record?.state, 'preparing');
  assert.deepEqual(first.record?.claim, { owner: 'hub-1', token: 'c1', at: 100, expiresAt: 150 });

  const second = await store.claim('d1', claim('c2', at(120)));
  assert.equal(second.outcome, 'busy');
  assert.equal(second.record?.claim?.token, 'c1');

  const stale = await store.claim('d1', claim('c3', at(150)));
  assert.equal(stale.outcome, 'expired');
  assert.equal(stale.record?.state, 'preparing');
  assert.equal(stale.record?.claim?.token, 'c1');

  assert.equal((await store.claim('missing', claim('c4', at(160)))).outcome, 'missing');
});

test('CAS：预期状态与 claim token 都匹配才生效；离开 preparing 清空 claim', async () => {
  const store = createSqliteWorkspaceDelegations(new DatabaseSync(':memory:'));
  await store.allocate(allocation());

  const wrongState = await store.compareAndSet('d1', { expect: { state: 'preparing', claimToken: 'c1' }, state: 'prepared', at: at(110) });
  assert.equal(wrongState.ok, false);

  await store.claim('d1', claim('c1', at(100)));
  const staleToken = await store.compareAndSet('d1', { expect: { state: 'preparing', claimToken: 'c2' }, state: 'prepared', at: at(110) });
  assert.equal(staleToken.ok, false);
  assert.equal(staleToken.record?.state, 'preparing');

  const wrongTarget = await store.compareAndSet('d1', { expect: { state: 'preparing', claimToken: 'c1' }, state: 'cancelled', at: at(111) });
  assert.equal(wrongTarget.ok, false);

  const prepared = await store.compareAndSet('d1', {
    expect: { state: 'preparing', claimToken: 'c1' }, state: 'prepared', at: at(112), baseSha: 'abc123'
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.record?.state, 'prepared');
  assert.equal(prepared.record?.claim, null);
  assert.equal(prepared.record?.baseSha, 'abc123');
  assert.deepEqual(await store.unsettled(), []);

  const afterPrepared = await store.claim('d1', claim('c2', at(113)));
  assert.equal(afterPrepared.outcome, 'not-claimable');
});

test('明确失败可用同一记录重试，执行身份不重建', async () => {
  const store = createSqliteWorkspaceDelegations(new DatabaseSync(':memory:'));
  await store.allocate(allocation());
  await store.claim('d1', claim('c1', at(100)));

  const failed = await store.compareAndSet('d1', {
    expect: { state: 'preparing', claimToken: 'c1' }, state: 'failed', at: at(110),
    failure: { kind: 'fatal', message: '远端不可达', at: 110 }
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.record?.state, 'failed');
  assert.deepEqual(failed.record?.failure, { kind: 'fatal', message: '远端不可达', at: 110 });
  assert.equal((await store.claim('d1', claim('c2', at(111)))).outcome, 'not-claimable');

  const retry = await store.compareAndSet('d1', { expect: { state: 'failed', claimToken: null }, state: 'pending', at: at(120) });
  assert.equal(retry.ok, true);
  assert.equal(retry.record?.failure, null);
  const reclaimed = await store.claim('d1', claim('c3', at(121)));
  assert.equal(reclaimed.outcome, 'claimed');
  assert.equal(reclaimed.record?.executionSessionId, 'exec-1');
  assert.equal(reclaimed.record?.worktreePath, '/tmp/wt/d1');
  assert.equal(reclaimed.record?.branch, 'dlg/d1');

  const done = await store.compareAndSet('d1', {
    expect: { state: 'preparing', claimToken: 'c3' }, state: 'prepared', at: at(130), baseSha: 'def456'
  });
  assert.equal(done.ok, true);
  assert.equal(done.record?.executionSessionId, 'exec-1');
});

test('不确定状态不能被过期租期、再次 claim 或通用 CAS 自动接管；只能取消', async () => {
  const store = createSqliteWorkspaceDelegations(new DatabaseSync(':memory:'));
  await store.allocate(allocation());
  await store.claim('d1', claim('c1', at(100)));
  assert.equal((await store.claim('d1', claim('c2', at(999)))).outcome, 'expired');
  assert.equal((await store.byId('d1'))?.state, 'preparing');

  const uncertain = await store.compareAndSet('d1', {
    expect: { state: 'preparing', claimToken: 'c1' }, state: 'uncertain', at: at(1000),
    failure: { kind: 'uncertain', message: 'worktree 已建但会话未确认', at: 1000 }
  });
  assert.equal(uncertain.ok, true);
  assert.equal(uncertain.record?.failure?.kind, 'uncertain');
  assert.equal((await store.claim('d1', claim('c3', at(10_000)))).outcome, 'not-claimable');
  assert.deepEqual((await store.unsettled()).map((r) => r.id), ['d1']);

  // 通用 CAS 不能把 uncertain 改回 pending：没有已验证的外部对账，重放会再造副作用。
  const replayed = await store.compareAndSet('d1', { expect: { state: 'uncertain', claimToken: null }, state: 'pending', at: at(10_001) });
  assert.equal(replayed.ok, false);
  assert.equal(replayed.record?.state, 'uncertain');
  assert.equal((await store.claim('d1', claim('c4', at(10_002)))).outcome, 'not-claimable');
  assert.deepEqual((await store.unsettled()).map((r) => r.id), ['d1']);

  const cancelled = await store.compareAndSet('d1', { expect: { state: 'uncertain', claimToken: null }, state: 'cancelled', at: at(10_003) });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.record?.state, 'cancelled');
});

test('失败类型必须与目标状态一致；preparing 不能经 CAS 直接进入', async () => {
  const store = createSqliteWorkspaceDelegations(new DatabaseSync(':memory:'));
  await store.allocate(allocation());
  await assert.rejects(
    () => store.compareAndSet('d1', {
      expect: { state: 'pending', claimToken: null }, state: 'failed', at: at(101),
      failure: { kind: 'uncertain', message: 'x', at: 101 }
    }),
    /failed 必须带 fatal/
  );
  await assert.rejects(
    () => store.compareAndSet('d1', { expect: { state: 'pending', claimToken: null }, state: 'preparing', at: at(101) }),
    /只能走 claim/
  );
});

test('执行会话身份在库层唯一：复制记录会被唯一索引拒绝', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createSqliteWorkspaceDelegations(db);
  await store.allocate(allocation());
  const row = db.prepare("SELECT * FROM workspace_delegation WHERE id = 'd1'").get() as Record<string, string | number | null>;
  // 换掉请求键，只让 execution_session_id 撞车，验证不依赖应用层预检。
  row['request_key'] = 'req-copy';
  const columns = Object.keys(row).filter((c) => c !== 'id');
  const insert = `INSERT INTO workspace_delegation (id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`;
  assert.throws(
    () => db.prepare(insert).run('d-copy', ...columns.map((c) => row[c] ?? null)),
    /UNIQUE constraint failed: workspace_delegation.execution_session_id/
  );
  assert.equal((await store.byCoordinator(asSessionId('main'))).length, 1);
});

test('启动配置随记录冻结持久化；同键重分配不改写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-delegation-startup-'));
  const file = join(dir, 'hub.sqlite');
  const frozen = {
    agentId: 'codex',
    model: 'gpt-5-codex',
    profileId: 'profile-1',
    options: { sandbox: 'workspace-write', approval: false }
  };
  try {
    const first = new DatabaseSync(file);
    const store = createSqliteWorkspaceDelegations(first);
    const created = await store.allocate(allocation({ startup: frozen }));
    assert.deepEqual(created.record.startup, frozen);
    first.close();

    const second = new DatabaseSync(file);
    const reopened = createSqliteWorkspaceDelegations(second);
    assert.deepEqual((await reopened.byId('d1'))?.startup, frozen);

    // 同键同指纹重分配只能复用；即使传入另一份配置，也不能覆盖已冻结的启动配置。
    const reused = await reopened.allocate(allocation({
      id: 'd-other',
      startup: {
        agentId: 'claude',
        model: null,
        profileId: null,
        options: { sandbox: 'read-only', approval: true }
      }
    }));
    assert.equal(reused.outcome, 'reused');
    assert.equal(reused.record.id, 'd1');
    assert.deepEqual(reused.record.startup, frozen);
    assert.deepEqual((await reopened.byId('d1'))?.startup, frozen);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧库没有启动配置列时只增列；缺失配置读出 null，不伪造默认值', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE workspace_delegation (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    coordinator_session_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    repo_id TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    base_sha TEXT,
    instructions TEXT NOT NULL,
    execution_session_id TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    state TEXT NOT NULL,
    claim_owner TEXT,
    claim_token TEXT,
    claim_at INTEGER,
    claim_expires_at INTEGER,
    failure_kind TEXT,
    failure_message TEXT,
    failure_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (coordinator_session_id, request_key))`);
  db.prepare(`INSERT INTO workspace_delegation (
    id, account_id, coordinator_session_id, request_key, request_fingerprint, project_id, task_id, repo_id, repo_url,
    worker_id, base_branch, base_sha, instructions, execution_session_id, worktree_path, branch, state,
    claim_owner, claim_token, claim_at, claim_expires_at, failure_kind, failure_message, failure_at, created_at, updated_at
  ) VALUES ('legacy', 'u1', 'main', 'req-legacy', 'fp-legacy', 'p1', 't1', 'r1', 'https://github.com/test/project',
    'w1', 'main', NULL, '旧记录', 'exec-legacy', '/tmp/wt/legacy', 'dlg/legacy', 'pending',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, 1)`).run();

  const store = createSqliteWorkspaceDelegations(db);
  const record = await store.byId('legacy');
  assert.equal(record?.startup, null);
  assert.equal(record?.worktreePath, '/tmp/wt/legacy');
  const columns = (db.prepare('PRAGMA table_info(workspace_delegation)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns.includes('startup_agent_id'));
  assert.ok(columns.includes('startup_model'));
  assert.ok(columns.includes('startup_profile_id'));
  assert.ok(columns.includes('startup_options_json'));
  assert.ok(columns.includes('worktree_path'));
});

test('同一来源 + 请求键在不同车道是两条记录；提案确认不能领走直接记录', async () => {
  const store = createSqliteWorkspaceDelegations(new DatabaseSync(':memory:'));
  const proposal = await store.allocate(allocation());
  assert.equal(proposal.record.mode, 'proposal');

  const direct = await store.allocate(allocation({
    id: 'd-direct',
    mode: 'direct',
    executionSessionId: asSessionId('exec-direct')
  }));
  assert.equal(direct.outcome, 'created');
  assert.equal(direct.record.id, 'd-direct');
  assert.equal(direct.record.mode, 'direct');
  assert.equal(direct.record.requestKey, 'req-1');
  assert.equal(direct.record.coordinatorSessionId, 'main');

  // 不带 mode 的读取 / 分配仍然落在提案车道，不会误伤直接记录。
  assert.equal((await store.byCoordinatorRequest(asSessionId('main'), 'req-1'))?.id, 'd1');
  assert.equal((await store.byCoordinatorRequest(asSessionId('main'), 'req-1', 'proposal'))?.id, 'd1');
  assert.equal((await store.byCoordinatorRequest(asSessionId('main'), 'req-1', 'direct'))?.id, 'd-direct');
  assert.equal((await store.allocate(allocation({ id: 'd-proposal-again', executionSessionId: asSessionId('exec-2') }))).outcome, 'reused');
  assert.equal((await store.allocate(allocation({
    id: 'd-direct-again', mode: 'direct', executionSessionId: asSessionId('exec-3')
  }))).outcome, 'reused');

  // 同车道同键不同指纹仍然是 conflict。
  const directConflict = await store.allocate(allocation({
    id: 'd-direct-conflict', mode: 'direct', requestFingerprint: 'fp-direct-2', executionSessionId: asSessionId('exec-4')
  }));
  assert.equal(directConflict.outcome, 'conflict');
  assert.equal(directConflict.record.id, 'd-direct');
  assert.equal((await store.byCoordinator(asSessionId('main'))).length, 2);
});

test('旧库迁移：去掉两列唯一约束、补 mode 列，旧记录归入提案车道且可并存直接记录', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE workspace_delegation (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    coordinator_session_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    repo_id TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    base_sha TEXT,
    instructions TEXT NOT NULL,
    startup_agent_id TEXT,
    startup_model TEXT,
    startup_profile_id TEXT,
    startup_options_json TEXT,
    execution_session_id TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    state TEXT NOT NULL,
    claim_owner TEXT,
    claim_token TEXT,
    claim_at INTEGER,
    claim_expires_at INTEGER,
    failure_kind TEXT,
    failure_message TEXT,
    failure_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (coordinator_session_id, request_key))`);
  db.prepare(`INSERT INTO workspace_delegation (
    id, account_id, coordinator_session_id, request_key, request_fingerprint, project_id, task_id, repo_id, repo_url,
    worker_id, base_branch, base_sha, instructions, startup_agent_id, startup_model, startup_profile_id, startup_options_json,
    execution_session_id, worktree_path, branch, state, claim_owner, claim_token, claim_at, claim_expires_at,
    failure_kind, failure_message, failure_at, created_at, updated_at
  ) VALUES ('legacy', 'u1', 'main', 'req-1', 'fp-1', 'p1', 't1', 'r1', 'https://github.com/test/project',
    'w1', 'main', NULL, '旧记录', NULL, NULL, NULL, NULL,
    'exec-legacy', '/tmp/wt/legacy', 'dlg/legacy', 'pending', NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, 1, 1)`).run();

  const store = createSqliteWorkspaceDelegations(db);
  const record = await store.byId('legacy');
  assert.equal(record?.mode, 'proposal');
  assert.equal(record?.worktreePath, '/tmp/wt/legacy');
  assert.equal((await store.byCoordinatorRequest(asSessionId('main'), 'req-1'))?.id, 'legacy');

  // 迁移后同一来源 + 键可以并存一条直接记录；旧的两列唯一约束已经不存在。
  const direct = await store.allocate(allocation({
    id: 'legacy-direct', mode: 'direct', executionSessionId: asSessionId('exec-direct')
  }));
  assert.equal(direct.outcome, 'created');
  assert.equal(direct.record.mode, 'direct');
  assert.equal((await store.byCoordinatorRequest(asSessionId('main'), 'req-1', 'direct'))?.id, 'legacy-direct');

  // 同车道重复键仍被三列唯一约束挡住。
  assert.throws(
    () => db.prepare(`INSERT INTO workspace_delegation (
      id, account_id, coordinator_session_id, mode, request_key, request_fingerprint, project_id, task_id, repo_id, repo_url,
      worker_id, base_branch, base_sha, instructions, execution_session_id, worktree_path, branch, state, created_at, updated_at
    ) VALUES ('legacy-dup', 'u1', 'main', 'proposal', 'req-1', 'fp-1', 'p1', 't1', 'r1', 'https://github.com/test/project',
      'w1', 'main', NULL, 'x', 'exec-dup', '/tmp/wt/dup', 'dlg/dup', 'pending', 2, 2)`).run(),
    /UNIQUE constraint failed: workspace_delegation.mode, workspace_delegation.coordinator_session_id, workspace_delegation.request_key/
  );
});

test('SQLite 重新打开后记录、领取与 CAS 仍然按原状态继续', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-delegation-'));
  const file = join(dir, 'hub.sqlite');
  try {
    const first = new DatabaseSync(file);
    const store = createSqliteWorkspaceDelegations(first);
    await store.allocate(allocation());
    await store.claim('d1', claim('c1', at(100)));
    first.close();

    const second = new DatabaseSync(file);
    const reopened = createSqliteWorkspaceDelegations(second);
    const record = await reopened.byId('d1');
    assert.equal(record?.state, 'preparing');
    assert.equal(record?.claim?.token, 'c1');
    assert.equal((await reopened.byExecutionSession(asSessionId('exec-1')))?.id, 'd1');
    assert.equal((await reopened.allocate(allocation({ id: 'd-other' }))).outcome, 'reused');
    assert.equal((await reopened.allocate(allocation({ id: 'd-dup', requestKey: 'req-2' }))).outcome, 'conflict');
    assert.equal((await reopened.claim('d1', claim('c2', at(120)))).outcome, 'busy');
    assert.equal((await reopened.claim('d1', claim('c2', at(151)))).outcome, 'expired');

    const prepared = await reopened.compareAndSet('d1', {
      expect: { state: 'preparing', claimToken: 'c1' }, state: 'prepared', at: at(152), baseSha: 'abc123'
    });
    assert.equal(prepared.ok, true);
    second.close();

    const third = new DatabaseSync(file);
    const again = createSqliteWorkspaceDelegations(third);
    assert.deepEqual(
      { state: (await again.byId('d1'))?.state, baseSha: (await again.byId('d1'))?.baseSha },
      { state: 'prepared', baseSha: 'abc123' }
    );
    third.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
