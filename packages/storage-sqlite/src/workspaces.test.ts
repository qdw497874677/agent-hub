import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asProjectId, asTaskId, newWorkspace } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';
import { migrateWorkspaces } from './workspaces.ts';

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
      .prepare("INSERT INTO workspaces(id, project_id, worker_id, path, kind, source, state, created_at, updated_at) VALUES ('x', 'p1', 'w1', '/r/.worktrees/a', 'long_lived', 'linked', 'ready', 1, 1)")
      .run()
  );
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
  const made = createProject({ name: 'repo', rootPath: '', directoryExists: true, now, workerId: null, repo: { url: 'git@github.com:me/x.git', defaultBranch: 'dev' } });
  assert.ok(made.ok);
  await store.projects.save(made.value);
  assert.deepEqual((await store.projects.byId(made.value.id))?.repo, { url: 'git@github.com:me/x.git', defaultBranch: 'dev' });
  await store.projects.save({ ...made.value, repo: null });
  assert.equal((await store.projects.byId(made.value.id))?.repo, null);

  const a = newWorkspace({ projectId: made.value.id, workerId: 'w1', path: '/a', kind: 'long_lived', source: 'linked', now });
  const b = newWorkspace({ projectId: made.value.id, workerId: null, path: '/b', kind: 'long_lived', source: 'linked', now });
  assert.ok(a.ok && b.ok);
  await store.workspaces.save(a.value);
  await store.workspaces.save(b.value);
  assert.deepEqual((await store.workspaces.onMachine('w1')).map((w) => w.path), ['/a']);
  assert.deepEqual((await store.workspaces.onMachine(null)).map((w) => w.path), ['/b']);
});
