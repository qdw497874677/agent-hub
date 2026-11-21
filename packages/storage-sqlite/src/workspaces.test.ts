import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asProjectId, asTaskId, createProject, newWorkspace } from '@agent-hub/domain';
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
  const store = openSqliteStore(':memory:');
  const made = createProject({ name: 'repo', now, repo: { url: 'git@github.com:me/x.git', defaultBranch: 'dev' } });
  assert.ok(made.ok);
  await store.projects.save(made.value);
  assert.deepEqual((await store.projects.byId(made.value.id))?.repo, { url: 'git@github.com:me/x.git', defaultBranch: 'dev' });
  // repos 是权威字段，repo 由它派生（不变量 repo === repos[0] ?? null）：清仓库要一起清。
  await store.projects.save({ ...made.value, repo: null, repos: [] });
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

test('建项目 + 认领同一事务：写项目失败回滚认领，工作空间保持未认领（#233）', async () => {
  const store = openSqliteStore(':memory:');
  const workspace = newWorkspace({ projectId: null, teamId: null, workerId: null, path: '/tmp/atomic', kind: 'long_lived', source: 'linked', now });
  const project = createProject({ name: 'atomic', now });
  assert.ok(workspace.ok && project.ok);
  await store.workspaces.save(workspace.value);
  // 模拟 projects 写入失败：认领必须跟着事务一起回滚，不能留下悬空 link。
  store.db.exec("CREATE TRIGGER fail_project_insert BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  await assert.rejects(
    () =>
      store.projects.saveWithWorkspaceClaim(project.value, {
        projectId: project.value.id,
        workspaceId: workspace.value.id,
        linkedBy: null,
        linkedAt: now
      }),
    /disk full/
  );
  assert.equal(await store.projects.byId(project.value.id), null);
  assert.deepEqual(await store.workspaces.linksOf(workspace.value.id), []);
  assert.notEqual(await store.workspaces.byId(workspace.value.id), null);
  store.close();
});

test('建项目 + 认领竞争：两个连接只有一个项目拿到目录，另一个 conflict 且不写项目（#233）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ahub-project-claim-')), 'hub.db');
  const a = openSqliteStore(file);
  const b = openSqliteStore(file);
  const workspace = newWorkspace({ projectId: null, teamId: null, workerId: null, path: '/tmp/race', kind: 'long_lived', source: 'linked', now });
  assert.ok(workspace.ok);
  await a.workspaces.save(workspace.value);
  const pa = createProject({ name: 'a', now });
  const pb = createProject({ name: 'b', now });
  assert.ok(pa.ok && pb.ok);
  const claim = (projectId: string) => ({ projectId: asProjectId(projectId), workspaceId: workspace.value.id, linkedBy: null, linkedAt: now });
  const results = await Promise.all([
    a.projects.saveWithWorkspaceClaim(pa.value, claim(pa.value.id)),
    b.projects.saveWithWorkspaceClaim(pb.value, claim(pb.value.id))
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['conflict', 'saved']);
  const links = await a.workspaces.linksOf(workspace.value.id);
  assert.equal(links.length, 1);
  const winner = results.find((r) => r.status === 'saved');
  assert.ok(winner && winner.status === 'saved');
  assert.equal(links[0]!.projectId, winner.link.projectId);
  const savedProject = links[0]!.projectId;
  assert.notEqual(await a.projects.byId(savedProject), null);
  assert.equal((await a.projects.list()).length, 1);
  a.close();
  b.close();
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
  assert.deepEqual(links.map((l) => [l['project_id'], l['workspace_id']]), [['p1', 'ws-a'], ['p2', 'ws-c']]);
  const state = (id: string) => store.db.prepare('SELECT state, team_id, base_workspace_id FROM workspaces WHERE id = ?').get(id);
  assert.equal(state('ws-b')?.['state'], 'removed');
  assert.equal(state('ws-a')?.['team_id'], 'team1');
  assert.equal(state('ws-t')?.['base_workspace_id'], 'ws-a');
  assert.equal(store.db.prepare("SELECT workspace_id FROM sessions WHERE id = 's1'").get()?.['workspace_id'], 'ws-a');
  assert.deepEqual((await store.workspaces.byProject(asProjectId('p2'))).filter((w) => w.state !== 'removed').map((w) => w.id).sort(), ['ws-c', 'ws-t']);
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

test('删除项目：没人认领的团队工作空间留下，只属于它的长期工作空间连登记一起删（独占归属）', async () => {
  const store = openSqliteStore(':memory:');
  store.db.exec("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'a', '', 1), ('p2', 'b', '', 2)");
  const team = newWorkspace({ projectId: null, teamId: 'team1', workerId: 'w1', path: '/t', kind: 'long_lived', source: 'linked', now });
  const own = newWorkspace({ projectId: asProjectId('p1'), workerId: 'w1', path: '/o', kind: 'long_lived', source: 'linked', now });
  assert.ok(team.ok && own.ok);
  await store.workspaces.save(team.value);
  await store.workspaces.save(own.value);
  await store.workspaces.claim({ projectId: asProjectId('p1'), workspaceId: team.value.id, linkedBy: null, linkedAt: now });
  await store.projects.remove(asProjectId('p1'));
  assert.equal((await store.workspaces.byId(team.value.id))?.projectId, null);
  assert.deepEqual(await store.workspaces.linksOf(team.value.id), []);
  assert.equal(await store.workspaces.byId(own.value.id), null);
  assert.deepEqual((await store.workspaces.byProject(asProjectId('p2'))).map((w) => w.id), []);
  store.close();
});

test('独占归属：同项目认领幂等且保留元数据，别的项目只能 conflict，不挤掉现任（#233）', async () => {
  const store = openSqliteStore(':memory:');
  store.db.exec("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'a', '', 1), ('p2', 'b', '', 2)");
  const ws = newWorkspace({ projectId: asProjectId('p1'), workerId: 'w1', path: '/only', kind: 'long_lived', source: 'linked', now });
  assert.ok(ws.ok);
  await store.workspaces.save(ws.value);
  // save 已自动认领 p1（linkedBy null）；同项目重复认领不再改写元数据
  const again = await store.workspaces.claim({ projectId: asProjectId('p1'), workspaceId: ws.value.id, linkedBy: 'me', linkedAt: now + 10 });
  assert.equal(again.status, 'owned');
  assert.deepEqual((await store.workspaces.linksOf(ws.value.id)).map((l) => [l.projectId, l.linkedBy, l.linkedAt]), [['p1', null, now]]);
  // 另一个项目认领 → conflict，现任 p1 原样保留
  const stolen = await store.workspaces.claim({ projectId: asProjectId('p2'), workspaceId: ws.value.id, linkedBy: 'me', linkedAt: now + 20 });
  assert.equal(stolen.status, 'conflict');
  assert.equal(stolen.status === 'conflict' ? stolen.owner.projectId : null, 'p1');
  assert.deepEqual((await store.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), ['p1']);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM project_workspaces WHERE workspace_id = ?').get(ws.value.id)?.['n'], 1);
  store.close();
});

test('并发认领：两个连接同时抢空目录，只有一个 claimed，另一个 conflict，行数仍 1（#233）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-claim-race-'));
  const file = join(dir, 'hub.db');
  const first = openSqliteStore(file);
  first.db.exec("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'a', '', 1), ('p2', 'b', '', 2)");
  const ws = newWorkspace({ projectId: null, teamId: 'team1', workerId: 'w1', path: '/race', kind: 'long_lived', source: 'linked', now });
  assert.ok(ws.ok);
  await first.workspaces.save(ws.value);
  const second = openSqliteStore(file);
  const [left, right] = await Promise.all([
    first.workspaces.claim({ projectId: asProjectId('p1'), workspaceId: ws.value.id, linkedBy: 'first', linkedAt: now + 1 }),
    second.workspaces.claim({ projectId: asProjectId('p2'), workspaceId: ws.value.id, linkedBy: 'second', linkedAt: now + 2 })
  ]);
  assert.deepEqual([left.status, right.status].sort(), ['claimed', 'conflict']);
  const links = await first.workspaces.linksOf(ws.value.id);
  assert.equal(links.length, 1);
  assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM project_workspaces WHERE workspace_id = ?').get(ws.value.id)?.['n'], 1);
  second.close();
  first.close();
});

test('原子转移：expected 与当前一致才替换；不一致返回 stale 且现任不动（#233）', async () => {
  const store = openSqliteStore(':memory:');
  store.db.exec("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'a', '', 1), ('p2', 'b', '', 2), ('p3', 'c', '', 3)");
  const ws = newWorkspace({ projectId: asProjectId('p1'), workerId: 'w1', path: '/move', kind: 'long_lived', source: 'linked', now });
  assert.ok(ws.ok);
  await store.workspaces.save(ws.value);
  // 调用方读到现任是 p1，接着转移 p1 → p2
  const moved = await store.workspaces.transfer({
    projectId: asProjectId('p2'),
    workspaceId: ws.value.id,
    linkedBy: 'mover',
    linkedAt: now + 10,
    expectedProjectIds: [asProjectId('p1')]
  });
  assert.equal(moved.status, 'transferred');
  assert.deepEqual((await store.workspaces.linksOf(ws.value.id)).map((l) => [l.projectId, l.linkedBy]), [['p2', 'mover']]);
  // 另一个调用方仍以为现任是 p1（陈旧视图）→ stale，p2 不被覆盖
  const stale = await store.workspaces.transfer({
    projectId: asProjectId('p3'),
    workspaceId: ws.value.id,
    linkedBy: 'late',
    linkedAt: now + 20,
    expectedProjectIds: [asProjectId('p1')]
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.status === 'stale' ? stale.owner?.projectId : null, 'p2');
  assert.deepEqual((await store.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), ['p2']);
  store.close();
});

test('原子转移：读到空目录后别人抢先认领，转移 stale 且不删新认领（#233）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-race-'));
  const file = join(dir, 'hub.db');
  const first = openSqliteStore(file);
  first.db.exec("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'a', '', 1), ('p2', 'b', '', 2)");
  const ws = newWorkspace({ projectId: null, teamId: 'team1', workerId: 'w1', path: '/empty', kind: 'long_lived', source: 'linked', now });
  assert.ok(ws.ok);
  await first.workspaces.save(ws.value);
  // 决定转移时看到「没人认领」
  const observed = (await first.workspaces.linksOf(ws.value.id)).map((l) => l.projectId);
  assert.deepEqual(observed, []);
  // 另一个连接在同一瞬间认领 p1
  const second = openSqliteStore(file);
  const claimed = await second.workspaces.claim({ projectId: asProjectId('p1'), workspaceId: ws.value.id, linkedBy: 'racer', linkedAt: now + 5 });
  assert.equal(claimed.status, 'claimed');
  // 原来的转移必须发现预期不一致，绝不能把 p1 的新认领删掉
  const moved = await first.workspaces.transfer({
    projectId: asProjectId('p2'),
    workspaceId: ws.value.id,
    linkedBy: 'mover',
    linkedAt: now + 10,
    expectedProjectIds: observed
  });
  assert.equal(moved.status, 'stale');
  assert.deepEqual((await first.workspaces.linksOf(ws.value.id)).map((l) => [l.projectId, l.linkedBy]), [['p1', 'racer']]);
  second.close();
  first.close();
});

test('save 自动认领遇到不一致：保留现任，不 REPLACE（#233）', async () => {
  const store = openSqliteStore(':memory:');
  store.db.exec("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'a', '', 1), ('p2', 'b', '', 2)");
  const ws = newWorkspace({ projectId: asProjectId('p2'), workerId: 'w1', path: '/conflicted', kind: 'long_lived', source: 'linked', now });
  assert.ok(ws.ok);
  // 模拟历史 / 手改数据：工作空间行还没保存，已有 p1 的认领
  store.db.prepare('INSERT INTO project_workspaces(project_id, workspace_id, linked_by, linked_at) VALUES (?, ?, ?, ?)').run('p1', ws.value.id, 'legacy', now);
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: unknown) => warnings.push(String(message));
  try {
    await store.workspaces.save(ws.value);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual((await store.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), ['p1']);
  assert.equal((await store.workspaces.byId(ws.value.id))?.projectId, null, '行也不应留下和关联表矛盾的 project_id');
  assert.ok(warnings.some((message) => message.includes('已属于项目 p1')));
  store.close();
});

test('同目录并发登记：两个连接同时 save，只落一行，后到的返回 existing（#233）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ahub-place-race-')), 'hub.db');
  const first = openSqliteStore(file);
  const second = openSqliteStore(file);
  const a = newWorkspace({ projectId: null, teamId: 'team1', workerId: 'w1', path: '/same', kind: 'long_lived', source: 'linked', now });
  const b = newWorkspace({ projectId: null, teamId: 'team1', workerId: 'w1', path: '/same', kind: 'long_lived', source: 'linked', now: now + 1 });
  assert.ok(a.ok && b.ok);
  const [ra, rb] = await Promise.all([first.workspaces.save(a.value), second.workspaces.save(b.value)]);
  assert.deepEqual([ra.status, rb.status].sort(), ['existing', 'saved']);
  const saved = ra.status === 'saved' ? ra : rb.status === 'saved' ? rb : null;
  const existing = ra.status === 'existing' ? ra : rb.status === 'existing' ? rb : null;
  assert.ok(saved && existing);
  assert.equal(existing.workspace.id, saved.workspace.id);
  assert.equal(
    first.db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE team_id = 'team1' AND worker_id = 'w1' AND path = '/same' AND state <> 'removed'").get()?.['n'],
    1
  );
  second.close();
  first.close();
});

test('历史重复登记：新登记/认领/转移都报 ambiguous 且不写、不动老行；同位置仍可维护和删除（#233）', async () => {
  const store = openSqliteStore(':memory:');
  store.db.exec("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'a', '', 1), ('p2', 'b', '', 2)");
  const a = newWorkspace({ projectId: null, teamId: 'team1', workerId: 'w1', path: '/dup', kind: 'long_lived', source: 'linked', now });
  const b = newWorkspace({ projectId: null, teamId: 'team1', workerId: 'w1', path: '/dup-other', kind: 'long_lived', source: 'linked', now: now + 1 });
  assert.ok(a.ok && b.ok);
  assert.equal((await store.workspaces.save(a.value)).status, 'saved');
  assert.equal((await store.workspaces.save(b.value)).status, 'saved');
  // 模拟老库留下的重复活跃登记。
  store.db.prepare("UPDATE workspaces SET path = '/dup' WHERE id = ?").run(b.value.id);

  const fresh = newWorkspace({ projectId: null, teamId: 'team1', workerId: 'w1', path: '/dup', kind: 'long_lived', source: 'linked', now: now + 2 });
  assert.ok(fresh.ok);
  const attempt = await store.workspaces.save(fresh.value);
  assert.equal(attempt.status, 'ambiguous');
  if (attempt.status === 'ambiguous') assert.deepEqual(attempt.candidates.map((w) => w.id).sort(), [a.value.id, b.value.id].sort());
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE path = '/dup'").get()?.['n'], 2);

  const claimed = await store.workspaces.claim({ projectId: asProjectId('p1'), workspaceId: a.value.id, linkedBy: 'x', linkedAt: now + 3 });
  assert.equal(claimed.status, 'ambiguous');
  assert.deepEqual(await store.workspaces.linksOf(a.value.id), []);
  const moved = await store.workspaces.transfer({
    projectId: asProjectId('p1'),
    workspaceId: a.value.id,
    linkedBy: 'x',
    linkedAt: now + 3,
    expectedProjectIds: []
  });
  assert.equal(moved.status, 'ambiguous');
  assert.deepEqual(await store.workspaces.linksOf(a.value.id), []);

  // 已经是当前项目的唯一认领：不能因为历史重复行就把幂等 claim/transfer 变成冲突。
  store.db.prepare('INSERT INTO project_workspaces(project_id, workspace_id, linked_by, linked_at) VALUES (?, ?, ?, ?)').run('p1', a.value.id, 'legacy', now);
  const owned = await store.workspaces.claim({ projectId: asProjectId('p1'), workspaceId: a.value.id, linkedBy: 'x', linkedAt: now + 4 });
  assert.equal(owned.status, 'owned');
  const noop = await store.workspaces.transfer({
    projectId: asProjectId('p1'),
    workspaceId: a.value.id,
    linkedBy: 'x',
    linkedAt: now + 4,
    expectedProjectIds: []
  });
  assert.equal(noop.status, 'owned');
  assert.deepEqual((await store.workspaces.linksOf(a.value.id)).map((l) => l.projectId), ['p1']);

  // 同位置更新绕开唯一性守卫，老重复行仍能改元数据和标记删除。
  const renamed = await store.workspaces.save({ ...a.value, label: 'kept-readable', updatedAt: now + 4 });
  assert.equal(renamed.status, 'saved');
  assert.equal((await store.workspaces.byId(a.value.id))?.label, 'kept-readable');
  const removed = await store.workspaces.save({ ...a.value, state: 'removed', updatedAt: now + 5 });
  assert.equal(removed.status, 'saved');
  assert.equal((await store.workspaces.byId(a.value.id))?.state, 'removed');
  store.close();
});

test('已有登记改目录撞到现登记：place-taken，原行和新位置都不被改写（#233）', async () => {
  const store = openSqliteStore(':memory:');
  const a = newWorkspace({ projectId: null, teamId: 'team1', workerId: 'w1', path: '/a', kind: 'long_lived', source: 'linked', now });
  const b = newWorkspace({ projectId: null, teamId: 'team1', workerId: 'w1', path: '/b', kind: 'long_lived', source: 'linked', now: now + 1 });
  assert.ok(a.ok && b.ok);
  assert.equal((await store.workspaces.save(a.value)).status, 'saved');
  assert.equal((await store.workspaces.save(b.value)).status, 'saved');
  const moved = await store.workspaces.save({ ...a.value, path: '/b', updatedAt: now + 2 });
  assert.equal(moved.status, 'place-taken');
  if (moved.status === 'place-taken') assert.equal(moved.existing.id, b.value.id);
  assert.equal((await store.workspaces.byId(a.value.id))?.path, '/a');
  assert.equal((await store.workspaces.byId(b.value.id))?.path, '/b');
  store.close();
});

test('已删除 / 临时登记在同一目录复活成长期：已有活跃登记时 place-taken，不新增第二条（#233）', async () => {
  const store = openSqliteStore(':memory:');
  store.db.exec("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'a', '', 1)");

  // removed -> live：同一 id 在同一路径复活，不能盖掉已经活跃的登记。
  const live = newWorkspace({ projectId: null, teamId: 'team1', workerId: 'w1', path: '/revive', kind: 'long_lived', source: 'linked', now });
  const dead = newWorkspace({ projectId: null, teamId: 'team1', workerId: 'w1', path: '/revive', kind: 'long_lived', source: 'linked', state: 'removed', now: now + 1 });
  assert.ok(live.ok && dead.ok);
  assert.equal((await store.workspaces.save(live.value)).status, 'saved');
  assert.equal((await store.workspaces.save(dead.value)).status, 'saved');
  const revived = await store.workspaces.save({ ...dead.value, state: 'ready', updatedAt: now + 2 });
  assert.equal(revived.status, 'place-taken');
  if (revived.status === 'place-taken') assert.equal(revived.existing.id, live.value.id);
  assert.equal((await store.workspaces.byId(dead.value.id))?.state, 'removed');

  // temporary -> long_lived：同一 id / 路径改类型，也不能在已有活跃长期登记旁再落一条。
  const temp = newWorkspace({ projectId: asProjectId('p1'), workerId: 'w1', path: '/mix', kind: 'temporary', source: 'worktree', ownerTaskId: asTaskId('t1'), now: now + 3 });
  const other = newWorkspace({ projectId: null, teamId: null, workerId: 'w1', path: '/mix', kind: 'long_lived', source: 'linked', now: now + 4 });
  assert.ok(temp.ok && other.ok);
  assert.equal((await store.workspaces.save(temp.value)).status, 'saved');
  assert.equal((await store.workspaces.save(other.value)).status, 'saved');
  const promoted = await store.workspaces.save({ ...temp.value, kind: 'long_lived', ownerTaskId: null, projectId: null, source: 'linked', updatedAt: now + 5 });
  assert.equal(promoted.status, 'place-taken');
  if (promoted.status === 'place-taken') assert.equal(promoted.existing.id, other.value.id);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE path = '/mix' AND kind = 'long_lived' AND state <> 'removed'").get()?.['n'], 1);
  store.close();
});

test('独占归属迁移：老库里同一个工作空间的多条认领只留 linked_at 最早的一条，并建唯一索引', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ahub-own-')), 'hub.db');
  const seed = openSqliteStore(file);
  seed.db.exec("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'a', '', 1), ('p2', 'b', '', 2)");
  const ws = newWorkspace({ projectId: asProjectId('p1'), workerId: 'w1', path: '/legacy', kind: 'long_lived', source: 'linked', now });
  assert.ok(ws.ok);
  await seed.workspaces.save(ws.value);
  // 模拟老库：先拿掉唯一索引，再塞第二条认领
  seed.db.exec('DROP INDEX project_workspaces_workspace');
  seed.db.prepare('INSERT INTO project_workspaces(project_id, workspace_id, linked_by, linked_at) VALUES (?, ?, ?, ?)').run('p2', ws.value.id, null, now + 10);
  assert.equal(seed.db.prepare('SELECT COUNT(*) AS n FROM project_workspaces WHERE workspace_id = ?').get(ws.value.id)?.['n'], 2);
  seed.close();

  const store = openSqliteStore(file);
  assert.deepEqual((await store.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), ['p1']);
  assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'project_workspaces_workspace' AND sql LIKE '%UNIQUE%'").get());
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM project_workspaces WHERE workspace_id = ?').get(ws.value.id)?.['n'], 1);
  store.close();
});
