import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { asProjectId, asWorkspaceId, type Bot, type BotGrant } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';
import { createSqliteBotRepository, migrateBotsToTeamScope } from './bots.ts';

const bot = (id: string, teamId: string, name: string, createdAt = 10): Bot => ({
  id,
  teamId,
  name,
  displayName: `${name} 的显示名`,
  color: 'sage',
  description: `${name} 的职责`,
  ref: { runtime: 'opencode', model: 'my-codex/go-glm-5.3', options: { mode: 'build', effort: 'high' } },
  reuse: 'per-trace',
  createdAt,
  updatedAt: createdAt
});

test('团队级 bot：两个团队同名互不影响、byName 按团队、listByTeam 排序', async () => {
  const store = openSqliteStore(':memory:');
  await store.bots.save(bot('bot_a', 'team_t1', 'qa', 20));
  await store.bots.save(bot('bot_b', 'team_t1', 'coder', 10));
  // 同名但另一个团队：不撞 UNIQUE(team_id, name)
  await store.bots.save(bot('bot_c', 'team_t2', 'qa', 5));

  assert.deepEqual(await store.bots.byId('bot_a'), bot('bot_a', 'team_t1', 'qa', 20));

  assert.equal((await store.bots.byName('team_t1', 'qa'))?.id, 'bot_a');
  assert.equal(await store.bots.byName('team_t1', 'nope'), null);
  assert.equal((await store.bots.byName('team_t2', 'qa'))?.id, 'bot_c');

  // created_at 再按 name
  assert.deepEqual((await store.bots.listByTeam('team_t1')).map((row) => row.name), ['coder', 'qa']);
  assert.deepEqual((await store.bots.listByTeam('team_t2')).map((row) => row.id), ['bot_c']);
  assert.deepEqual(await store.bots.listByTeam('team_none'), []);

  // 覆盖保存：同一 id 换列，不新增行
  await store.bots.save({ ...bot('bot_a', 'team_t1', 'qa', 20), displayName: '质检', updatedAt: 30 });
  const updated = await store.bots.byId('bot_a');
  assert.equal(updated?.displayName, '质检');
  assert.equal(updated?.updatedAt, 30);
  assert.equal((await store.bots.listByTeam('team_t1')).length, 2);
  store.close();
});

test('团队级 bot：同团队同名撞唯一约束，删掉才能复用', async () => {
  const store = openSqliteStore(':memory:');
  await store.bots.save(bot('bot_a', 'team_t1', 'qa'));
  await assert.rejects(store.bots.save(bot('bot_b', 'team_t1', 'qa')));
  await store.bots.remove('bot_a');
  await store.bots.save(bot('bot_b', 'team_t1', 'qa'));
  assert.equal((await store.bots.byName('team_t1', 'qa'))?.id, 'bot_b');
  assert.equal(await store.bots.byId('bot_a'), null);
  store.close();
});

test('授权：grant → listForProject，重复 grant 只换 workspaceId，revoke 不删 bot', async () => {
  const store = openSqliteStore(':memory:');
  await store.bots.save(bot('bot_a', 'team_t1', 'qa', 20));
  await store.bots.save(bot('bot_b', 'team_t1', 'coder', 10));

  const grantA: BotGrant = {
    botId: 'bot_a',
    projectId: asProjectId('p1'),
    workspaceId: null,
    createdAt: 100,
    createdBy: 'u1'
  };
  await store.bots.grant(grantA);
  assert.deepEqual((await store.bots.listForProject(asProjectId('p1'))).map((row) => row.id), ['bot_a']);
  assert.deepEqual(await store.bots.grantsOf('bot_a'), [grantA]);
  assert.deepEqual(await store.bots.grantsForProject(asProjectId('p1')), [grantA]);

  // listForProject 按 bots.created_at, bots.name（不是授权时间）
  await store.bots.grant({
    botId: 'bot_b',
    projectId: asProjectId('p1'),
    workspaceId: null,
    createdAt: 90,
    createdBy: 'u1'
  });
  assert.deepEqual((await store.bots.listForProject(asProjectId('p1'))).map((row) => row.id), ['bot_b', 'bot_a']);

  // 重复授权（换 workspace / 时间 / 授权人）：workspaceId 更新，createdAt / createdBy 保留原值
  await store.bots.grant({
    botId: 'bot_a',
    projectId: asProjectId('p1'),
    workspaceId: asWorkspaceId('ws_1'),
    createdAt: 999,
    createdBy: 'u2'
  });
  assert.deepEqual(await store.bots.grantsOf('bot_a'), [{ ...grantA, workspaceId: asWorkspaceId('ws_1') }]);
  assert.equal((await store.bots.grantsOf('bot_a')).length, 1);

  // 撤销：项目里不再有它，但 bot 行还在
  await store.bots.revoke('bot_a', asProjectId('p1'));
  assert.deepEqual((await store.bots.listForProject(asProjectId('p1'))).map((row) => row.id), ['bot_b']);
  assert.deepEqual(await store.bots.grantsOf('bot_a'), []);
  assert.notEqual(await store.bots.byId('bot_a'), null);
  assert.deepEqual((await store.bots.grantsForProject(asProjectId('p1'))).map((row) => row.botId), ['bot_b']);
  store.close();
});

/** 老形状的库：bots 按项目存（project_id NOT NULL + UNIQUE(project_id, name)），没有 team_id。 */
const legacyDb = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, team_id TEXT);
    CREATE TABLE bots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      doc TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, name)
    );
    CREATE INDEX bots_project ON bots(project_id);
    INSERT INTO projects(id, team_id) VALUES ('p1', 'team_a'), ('p2', 'team_b');
  `);
  const doc = JSON.stringify({
    ref: { runtime: 'opencode', model: 'my-codex/go-glm-5.3', options: { mode: 'build', effort: 'high' } },
    displayName: '质检',
    color: 'sage',
    description: 'qa 的职责',
    reuse: 'per-trace'
  });
  db.prepare('INSERT INTO bots VALUES (?, ?, ?, ?, ?, ?)').run('bot_1', 'p1', 'qa', doc, 10, 10);
  db.prepare('INSERT INTO bots VALUES (?, ?, ?, ?, ?, ?)').run('bot_2', 'p2', 'qa', doc, 20, 20);
  return db;
};

const dump = (db: DatabaseSync): string =>
  JSON.stringify({
    bots: db.prepare('SELECT * FROM bots ORDER BY id').all(),
    grants: db.prepare('SELECT * FROM bot_grants ORDER BY bot_id, project_id').all()
  });

test('迁移：项目级 → 团队级 + 授权，幂等，唯一约束换到 team 上', () => {
  const db = legacyDb();
  migrateBotsToTeamScope(db);

  const teams = db.prepare('SELECT id, team_id, name, created_at FROM bots ORDER BY id').all() as unknown as {
    id: string;
    team_id: string;
    name: string;
    created_at: number;
  }[];
  assert.deepEqual(
    teams.map((row) => [row.id, row.team_id, row.name, row.created_at]),
    [
      ['bot_1', 'team_a', 'qa', 10],
      ['bot_2', 'team_b', 'qa', 20]
    ]
  );

  // 每个老 bot 一条授权：project 来自原行，workspace / createdBy 为空，createdAt 沿用老时间
  const grants = db.prepare('SELECT * FROM bot_grants ORDER BY bot_id').all() as unknown as {
    bot_id: string;
    project_id: string;
    workspace_id: string | null;
    created_at: number;
    created_by: string | null;
  }[];
  assert.deepEqual(
    grants.map((row) => [row.bot_id, row.project_id, row.workspace_id, row.created_at, row.created_by]),
    [
      ['bot_1', 'p1', null, 10, null],
      ['bot_2', 'p2', null, 20, null]
    ]
  );

  // UNIQUE(team_id, name) 生效：同团队同名插不进去（不同团队的同名是合法的，迁移后仍在）
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO bots(id, team_id, name, doc, created_at, updated_at) VALUES ('bot_x', 'team_a', 'qa', '{}', 1, 1)"
      )
      .run()
  );

  // 幂等：再跑一次，两表内容逐字节不变
  const before = dump(db);
  migrateBotsToTeamScope(db);
  assert.equal(dump(db), before);

  // PRAGMA foreign_keys 恢复
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  db.close();
});

test('迁移后老数据不丢：listForProject / byName / listByTeam 仍能读到', async () => {
  const db = legacyDb();
  // createSqliteBotRepository 内部会先迁移；这里显式再跑一次也不会重复迁移
  migrateBotsToTeamScope(db);
  const bots = createSqliteBotRepository(db);

  assert.deepEqual((await bots.listForProject(asProjectId('p1'))).map((row) => row.id), ['bot_1']);
  assert.deepEqual((await bots.listForProject(asProjectId('p2'))).map((row) => row.id), ['bot_2']);
  assert.deepEqual((await bots.listForProject(asProjectId('p_missing'))), []);

  const migrated = await bots.byId('bot_1');
  assert.equal(migrated?.teamId, 'team_a');
  assert.equal(migrated?.name, 'qa');
  assert.equal(migrated?.displayName, '质检');
  assert.equal(migrated?.ref.model, 'my-codex/go-glm-5.3');
  assert.equal(migrated?.createdAt, 10);
  assert.equal((await bots.byName('team_a', 'qa'))?.id, 'bot_1');
  assert.deepEqual((await bots.listByTeam('team_a')).map((row) => row.id), ['bot_1']);
  db.close();
});
