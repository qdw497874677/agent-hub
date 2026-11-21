import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureSingleWorkspaceOwner, WORKSPACE_SCHEMA } from './workspaces.ts';
import { openSqliteStore } from './store.ts';

/**
 * #233 第 9 项：ensureSingleWorkspaceOwner 的兜底去重。
 * 这些用例只用 :memory: 库，不碰真实数据目录。
 */

/** 老版本 audit_log：只有 7 列，没有后来的 ip / team_id。 */
const OLD_AUDIT_SCHEMA = `
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT NOT NULL,
  detail      TEXT NOT NULL,
  at          INTEGER NOT NULL
);
`;

function rawDb(withAudit: boolean): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // 老库最小项目表：独占归属只关心 id 与 deleted_at。
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY, deleted_at INTEGER)');
  db.exec(WORKSPACE_SCHEMA);
  if (withAudit) db.exec(OLD_AUDIT_SCHEMA);
  return db;
}

function addProject(db: DatabaseSync, id: string, deletedAt: number | null = null): void {
  db.prepare('INSERT INTO projects(id, deleted_at) VALUES (?, ?)').run(id, deletedAt);
}

function addClaim(db: DatabaseSync, workspaceId: string, projectId: string, linkedAt: number): void {
  db.prepare(
    'INSERT INTO project_workspaces(project_id, workspace_id, linked_by, linked_at) VALUES (?, ?, NULL, ?)'
  ).run(projectId, workspaceId, linkedAt);
}

function claimsOf(db: DatabaseSync, workspaceId: string): Array<[string, number]> {
  const rows = db
    .prepare('SELECT project_id, linked_at FROM project_workspaces WHERE workspace_id = ? ORDER BY project_id ASC')
    .all(workspaceId) as Array<{ project_id: string; linked_at: number }>;
  return rows.map((row) => [row.project_id, Number(row.linked_at)]);
}

function hasOwnerIndex(db: DatabaseSync): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'project_workspaces_workspace'")
      .get() !== undefined
  );
}

/** 收集 console.log，用来断言「回滚不输出迁移日志」。 */
function captureLogs<T>(fn: () => T): { value?: T; error?: unknown; logs: string[] } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    return { value: fn(), logs };
  } catch (error) {
    return { error, logs };
  } finally {
    console.log = original;
  }
}

test('老库多认领：优先 live 项目，其次软删除，最后悬空；同档按 linked_at + project_id；逐条写 audit_log', () => {
  const db = rawDb(true);
  addProject(db, 'p-live');
  addProject(db, 'p-soft', 100);
  addProject(db, 'p-a');
  addProject(db, 'p-b');
  addProject(db, 'p-only');

  // w1：最早是软删除项目，其次项目已不存在，最后才是 live 项目。
  addClaim(db, 'w1', 'p-soft', 1);
  addClaim(db, 'w1', 'p-gone', 2);
  addClaim(db, 'w1', 'p-live', 50);
  // w2：两个 live 项目 linked_at 相同，用 project_id 字典序决定（老 tie-break）。
  addClaim(db, 'w2', 'p-b', 10);
  addClaim(db, 'w2', 'p-a', 10);
  // w3：只有一条认领，谁都不该碰。
  addClaim(db, 'w3', 'p-only', 5);

  assert.equal(ensureSingleWorkspaceOwner(db), 3);

  assert.deepEqual(claimsOf(db, 'w1'), [['p-live', 50]]);
  assert.deepEqual(claimsOf(db, 'w2'), [['p-a', 10]]);
  assert.deepEqual(claimsOf(db, 'w3'), [['p-only', 5]]);
  assert.equal(hasOwnerIndex(db), true);

  const audit = db
    .prepare('SELECT actor_id, actor_email, action, target, detail, at FROM audit_log ORDER BY target ASC, detail ASC')
    .all() as Array<{
    actor_id: string;
    actor_email: string;
    action: string;
    target: string;
    detail: string;
    at: number;
  }>;
  assert.equal(audit.length, 3);
  for (const row of audit) {
    assert.equal(row.actor_id, 'system');
    assert.equal(row.actor_email, '');
    assert.equal(row.action, 'workspace.owner.reconcile');
    assert.ok(row.at > 0);
  }

  const detailOf = (workspaceId: string, removedProjectId: string) => {
    const row = audit.find((entry) => {
      if (entry.target !== workspaceId) return false;
      return (JSON.parse(entry.detail) as { projectId: string }).projectId === removedProjectId;
    });
    assert.ok(row, `missing audit detail for ${workspaceId}/${removedProjectId}`);
    return JSON.parse(row.detail) as {
      projectId: string;
      linkedAt: number;
      projectState: string;
      survivorProjectId: string;
      survivorLinkedAt: number;
      survivorState: string;
    };
  };

  assert.deepEqual(detailOf('w1', 'p-soft'), {
    projectId: 'p-soft',
    linkedAt: 1,
    projectState: 'deleted',
    survivorProjectId: 'p-live',
    survivorLinkedAt: 50,
    survivorState: 'live'
  });
  assert.deepEqual(detailOf('w1', 'p-gone'), {
    projectId: 'p-gone',
    linkedAt: 2,
    projectState: 'dangling',
    survivorProjectId: 'p-live',
    survivorLinkedAt: 50,
    survivorState: 'live'
  });
  assert.deepEqual(detailOf('w2', 'p-b'), {
    projectId: 'p-b',
    linkedAt: 10,
    projectState: 'live',
    survivorProjectId: 'p-a',
    survivorLinkedAt: 10,
    survivorState: 'live'
  });

  // 幂等：第二次没有重复行，不删也不写审计。
  assert.equal(ensureSingleWorkspaceOwner(db), 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n, 3);
  db.close();
});

test('裸库没有 audit_log：提交后输出结构化日志；幂等且不重写幸存 / 无关认领', () => {
  const db = rawDb(false);
  addProject(db, 'p1');
  addProject(db, 'p2');
  addClaim(db, 'w1', 'p1', 1);
  addClaim(db, 'w1', 'p2', 2);
  addClaim(db, 'w9', 'p1', 7);

  const first = captureLogs(() => ensureSingleWorkspaceOwner(db));
  assert.equal(first.error, undefined);
  assert.equal(first.value, 1);
  assert.equal(first.logs.length, 1);
  const prefix = '[storage] workspace.owner.reconcile ';
  assert.ok(first.logs[0]!.startsWith(prefix));
  assert.deepEqual(JSON.parse(first.logs[0]!.slice(prefix.length)), {
    workspaceId: 'w1',
    projectId: 'p2',
    linkedAt: 2,
    projectState: 'live',
    survivorProjectId: 'p1',
    survivorLinkedAt: 1,
    survivorState: 'live'
  });

  // 幸存者与无关认领保持原样（linked_at 未被改写）。
  assert.deepEqual(claimsOf(db, 'w1'), [['p1', 1]]);
  assert.deepEqual(claimsOf(db, 'w9'), [['p1', 7]]);

  const second = captureLogs(() => ensureSingleWorkspaceOwner(db));
  assert.equal(second.error, undefined);
  assert.equal(second.value, 0);
  assert.deepEqual(second.logs, []);
  db.close();
});

test('迁移顺序：openSqliteStore 先建 audit_log，再跑独占归属；审计可直接从 store 读取', async () => {
  const store = openSqliteStore(':memory:');
  assert.ok(
    store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get() !== undefined,
    'openSqliteStore 应在 ensureSingleWorkspaceOwner 之前初始化 audit_log'
  );

  // 模拟老库：把初始化时建的唯一索引拿掉，再塞入重复认领。
  store.db.exec('DROP INDEX IF EXISTS project_workspaces_workspace');
  store.db
    .prepare("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p-live', 'live', '/tmp/live', 1)")
    .run();
  store.db
    .prepare("INSERT INTO projects(id, name, root_path, created_at, deleted_at) VALUES ('p-old', 'old', '/tmp/old', 1, 9)")
    .run();
  addClaim(store.db, 'w1', 'p-old', 1);
  addClaim(store.db, 'w1', 'p-live', 2);

  assert.equal(ensureSingleWorkspaceOwner(store.db), 1);
  assert.deepEqual(claimsOf(store.db, 'w1'), [['p-live', 2]]);
  assert.equal(hasOwnerIndex(store.db), true);

  const entries = (await store.audit.recent(10)).filter(
    (entry) => String(entry.action) === 'workspace.owner.reconcile'
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.target, 'w1');
  assert.equal(entries[0]!.actorEmail, '');
  assert.equal(String(entries[0]!.actorId), 'system');
  const detail = JSON.parse(entries[0]!.detail) as Record<string, unknown>;
  assert.equal(detail['projectId'], 'p-old');
  assert.equal(detail['projectState'], 'deleted');
  assert.equal(detail['survivorProjectId'], 'p-live');
  assert.equal(detail['survivorState'], 'live');
  store.close();
});

test('审计写入失败：整个迁移回滚，重复认领仍在，且不输出提交后日志', () => {
  const db = rawDb(true);
  addProject(db, 'p1');
  addProject(db, 'p2');
  addClaim(db, 'w1', 'p1', 1);
  addClaim(db, 'w1', 'p2', 2);
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");

  const run = captureLogs(() => ensureSingleWorkspaceOwner(db));
  assert.ok(run.error instanceof Error);
  assert.match((run.error as Error).message, /audit unavailable/);
  assert.deepEqual(run.logs, []);
  assert.deepEqual(claimsOf(db, 'w1'), [
    ['p1', 1],
    ['p2', 2]
  ]);
  assert.equal(hasOwnerIndex(db), false);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n, 0);
  db.close();
});
