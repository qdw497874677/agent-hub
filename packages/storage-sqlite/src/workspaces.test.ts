import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asProjectId, asTaskId, newWorkspace } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';
import { migrateSharedWorkspaces, migrateWorkspaces } from './workspaces.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = 1_700_000_000_000;

function legacyDb() {
  const store = openSqliteStore(':memory:');
  const { db } = store;
  db.prepare("INSERT INTO projects(id, name, root_path, worker_id, directories, created_at) VALUES ('p1', 'demo', '/srv/demo/', NULL, ?, 1)")
    .run(JSON.stringify({ w2: '/home/b/demo' }));
  db.prepare("INSERT INTO tasks(id, project_id, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'x', 'todo', 1, 1)").run();
  const session = db.prepare(
    "INSERT INTO sessions(id, task_id, agent_id, model, origin_kind, status, last_seq, worker_id, created_at, updated_at) VALUES (?, 't1', 'pi', '', 'derive', 'done', 0, ?, 1, 1)"
  );
  session.run('s-home', null);
  session.run('s-local', 'local');
  session.run('s-w2', 'w2');
  return store;
}

test('迁移：项目目录与各机器目录登记成长期 linked 工作空间，老会话指向它在用的那个；幂等', async () => {
  const store = legacyDb();
  assert.equal(migrateWorkspaces(store.db, now), 1);
  assert.equal(migrateWorkspaces(store.db, now), 0);
  assert.equal(migrateSharedWorkspaces(store.db, now).linked, 2);
  const workspaces = await store.workspaces.byProject(asProjectId('p1'));
  assert.deepEqual(
    workspaces.map((w) => [w.workerId, w.path, w.kind, w.source, w.state]).sort(),
    [
      [null, '/srv/demo', 'long_lived', 'linked', 'ready'],
      ['w2', '/home/b/demo', 'long_lived', 'linked', 'ready']
    ]
  );
  const home = workspaces.find((w) => w.workerId === null)!;
  const remote = workspaces.find((w) => w.workerId === 'w2')!;
  const pointed = async (id: string) => (await store.sessions.byId(id as never))?.workspaceId;
  assert.equal(await pointed('s-home'), home.id);
  assert.equal(await pointed('s-local'), home.id);
  assert.equal(await pointed('s-w2'), remote.id);
  store.close();
});

test('工作空间往返；临时的必须有任务；同一目录不重复登记；删除项目连登记一起删', async () => {
  const store = openSqliteStore(':memory:');
  store.db.prepare("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'demo', '', 1)").run();
  const temp = newWorkspace({
    projectId: asProjectId('p1'),
    workerId: 'w1',
    path: '/r/.worktrees/a',
    kind: 'temporary',
    source: 'worktree',
    ownerTaskId: asTaskId('t1'),
    branch: 'agent-hub/a-1',
    isGit: true,
    now
  });
  assert.ok(temp.ok);
  await store.workspaces.save(temp.value);
  assert.deepEqual(await store.workspaces.byId(temp.value.id), temp.value);
  assert.deepEqual(await store.workspaces.temporaries(), [temp.value]);
  assert.deepEqual(await store.workspaces.byTask(asTaskId('t1')), [temp.value]);
  assert.throws(() =>
    store.db
      .prepare("INSERT INTO workspaces(id, project_id, worker_id, path, kind, source, state, created_at, updated_at) VALUES ('y', 'p1', 'w1', '/other', 'temporary', 'worktree', 'ready', 1, 1)")
      .run()
  );
  await store.projects.remove(asProjectId('p1'));
  assert.equal(await store.workspaces.byId(temp.value.id), null);
  store.close();
});

test('项目仓库字段往返：保存、读回、清空；onMachine 只给这台机器上没删的', async () => {
  const { createProject } = await import('@agent-hub/domain');
  const store = openSqliteStore(':memory:');
  const made = createProject({ name: 'repo', now, repo: { url: 'git@github.com:me/x.git', defaultBranch: 'dev' } });
  assert.ok(made.ok);
  await store.projects.save(made.value);
  assert.deepEqual((await store.projects.byId(made.value.id))?.repo, { url: 'git@github.com:me/x.git', defaultBranch: 'dev' });
  await store.projects.save({ ...made.value, repo: null });
  assert.equal((await store.projects.byId(made.value.id))?.repo, null);
  await store.projects.save({ ...made.value, description: '# 说明\n- 用 pnpm' });
  assert.equal((await store.projects.byId(made.value.id))?.description, '# 说明\n- 用 pnpm');

  const a = newWorkspace({ projectId: made.value.id, workerId: 'w1', path: '/a', kind: 'long_lived', source: 'linked', now });
  const b = newWorkspace({ projectId: made.value.id, workerId: null, path: '/b', kind: 'long_lived', source: 'linked', now });
  assert.ok(a.ok && b.ok);
  await store.workspaces.save(a.value);
  await store.workspaces.save(b.value);
  assert.deepEqual((await store.workspaces.onMachine('w1')).map((w) => w.path), ['/a']);
  assert.deepEqual((await store.workspaces.onMachine(null)).map((w) => w.path), ['/b']);
});

/** 上一版（ADR 0026 之前）的 workspaces 表：project_id NOT NULL、按项目唯一。 */
const OLD_SCHEMA = `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), worker_id TEXT, path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('long_lived', 'temporary')),
  source TEXT NOT NULL CHECK (source IN ('linked', 'created', 'cloned', 'worktree')),
  base_workspace_id TEXT, branch TEXT, owner_task_id TEXT, label TEXT, is_git INTEGER,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'ready', 'failed', 'kept', 'removed')),
  kept_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK ((kind = 'temporary') = (owner_task_id IS NOT NULL))
);
CREATE UNIQUE INDEX workspaces_one_place ON workspaces(project_id, COALESCE(worker_id, ''), path) WHERE state <> 'removed';`;

test('ADR 0026 迁移：老表重建（project_id 可空、加 team_id / repo_url），关联回填、团队回填、完全相同目录合并；幂等；老代码的查询照样能用', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ahub-ws-')), 'hub.db');
  const seed = openSqliteStore(file);
  seed.close();
  const raw = new DatabaseSync(file);
  raw.exec('DROP TABLE workspaces; DROP TABLE IF EXISTS project_workspaces; DROP TABLE IF EXISTS workspace_link_migrated;');
  raw.exec(OLD_SCHEMA);
  raw.exec("INSERT INTO projects(id, name, root_path, team_id, created_at) VALUES ('p1', 'a', '', 'team1', 1), ('p2', 'b', '', 'team1', 2)");
  raw.exec("INSERT INTO tasks(id, project_id, title, status, created_at, updated_at) VALUES ('t2', 'p2', 'x', 'todo', 1, 1)");
  const ins = raw.prepare("INSERT INTO workspaces(id, project_id, worker_id, path, kind, source, owner_task_id, base_workspace_id, state, created_at, updated_at) VALUES (?, ?, 'w1', ?, ?, ?, ?, ?, 'ready', ?, ?)");
  ins.run('ws-a', 'p1', '/srv/app', 'long_lived', 'linked', null, null, 10, 10);
  ins.run('ws-b', 'p2', '/srv/app', 'long_lived', 'linked', null, null, 20, 20); // 同一目录 → 合并进 ws-a
  ins.run('ws-c', 'p2', '/srv/app-copy', 'long_lived', 'cloned', null, null, 30, 30); // 重复 clone：不动（Q7）
  ins.run('ws-t', 'p2', '/srv/app/.worktrees/x', 'temporary', 'worktree', 't2', 'ws-b', 40, 40);
  raw.exec("INSERT INTO sessions(id, task_id, agent_id, model, origin_kind, status, last_seq, worker_id, workspace_id, created_at, updated_at) VALUES ('s1', 't2', 'pi', '', 'derive', 'done', 0, 'w1', 'ws-b', 1, 1)");
  raw.close();

  const store = openSqliteStore(file);
  const cols = (store.db.prepare('PRAGMA table_info(workspaces)').all() as { name: string; notnull: number }[]);
  assert.ok(cols.some((c) => c.name === 'team_id') && cols.some((c) => c.name === 'repo_url'));
  assert.equal(cols.find((c) => c.name === 'project_id')?.notnull, 0);
  const links = store.db.prepare('SELECT project_id, workspace_id FROM project_workspaces ORDER BY project_id, workspace_id').all();
  assert.deepEqual(links.map((l) => [l['project_id'], l['workspace_id']]), [['p1', 'ws-a'], ['p2', 'ws-a'], ['p2', 'ws-c']]);
  const state = (id: string) => store.db.prepare('SELECT state, team_id, base_workspace_id FROM workspaces WHERE id = ?').get(id);
  assert.equal(state('ws-b')?.['state'], 'removed');
  assert.equal(state('ws-a')?.['team_id'], 'team1');
  assert.equal(state('ws-t')?.['base_workspace_id'], 'ws-a');
  assert.equal(store.db.prepare("SELECT workspace_id FROM sessions WHERE id = 's1'").get()?.['workspace_id'], 'ws-a');
  assert.deepEqual((await store.workspaces.byProject(asProjectId('p2'))).filter((w) => w.state !== 'removed').map((w) => w.id).sort(), ['ws-a', 'ws-c', 'ws-t']);
  // 取消关联后重启不会被补回来
  await store.workspaces.unlink(asProjectId('p2'), 'ws-c' as never);
  store.close();
  const again = openSqliteStore(file);
  assert.deepEqual(migrateSharedWorkspaces(again.db), { linked: 0, teamed: 0, merged: 0 });
  assert.equal((await again.workspaces.byProject(asProjectId('p2'))).some((w) => w.id === 'ws-c'), false);
  // 回滚：老代码按 project_id 查、老的唯一索引还能建起来
  assert.equal(again.db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE project_id = 'p1' AND state <> 'removed'").get()?.['n'], 1);
  again.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS workspaces_one_place ON workspaces(project_id, COALESCE(worker_id, ''), path) WHERE state <> 'removed'");
  again.close();
});

test('删除项目：还关联着别的项目的长期工作空间留下，只关联它的连登记一起删', async () => {
  const store = openSqliteStore(':memory:');
  store.db.exec("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'a', '', 1), ('p2', 'b', '', 2)");
  const shared = newWorkspace({ projectId: asProjectId('p1'), workerId: 'w1', path: '/s', kind: 'long_lived', source: 'linked', now });
  const own = newWorkspace({ projectId: asProjectId('p1'), workerId: 'w1', path: '/o', kind: 'long_lived', source: 'linked', now });
  assert.ok(shared.ok && own.ok);
  await store.workspaces.save(shared.value);
  await store.workspaces.save(own.value);
  await store.workspaces.link({ projectId: asProjectId('p2'), workspaceId: shared.value.id, linkedBy: null, linkedAt: now });
  await store.projects.remove(asProjectId('p1'));
  assert.equal((await store.workspaces.byId(shared.value.id))?.projectId, null);
  assert.equal(await store.workspaces.byId(own.value.id), null);
  assert.deepEqual((await store.workspaces.byProject(asProjectId('p2'))).map((w) => w.id), [shared.value.id]);
  store.close();
});
