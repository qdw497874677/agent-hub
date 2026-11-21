import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore } from './store.ts';
import { createSqliteSessionServices } from './services.ts';
import { SERVICE_LOG_MAX, asServiceId, asSessionId, asTaskId, type SessionService } from '@agent-hub/domain';

const serviceOf = (patch: Partial<SessionService> = {}): SessionService => ({
  id: asServiceId('svc_0a1b2c3d'),
  projectId: 'p-1' as SessionService['projectId'],
  taskId: asTaskId('t-1'),
  workspaceId: null,
  sessionId: asSessionId('s-1'),
  workerId: 'local',
  root: '/tmp/demo',
  command: 'npm run dev',
  port: 3000,
  envKeys: ['NODE_ENV'],
  restart: 'always',
  state: 'running',
  pid: 4321,
  detail: null,
  logTail: 'vite ready\n',
  startedAt: 10,
  updatedAt: 20,
  ...patch
});

test('会话服务存储：读写往返、按任务 / 会话 / 机器查、upsert 不新增行、删除', async () => {
  const store = openSqliteStore(':memory:');
  const a = serviceOf();
  const b = serviceOf({
    id: asServiceId('svc_0a1b2c3e'),
    sessionId: null,
    workspaceId: 'ws_1' as SessionService['workspaceId'],
    port: null,
    envKeys: [],
    restart: 'on-demand',
    state: 'stopped',
    pid: null,
    logTail: '',
    startedAt: null,
    updatedAt: 12,
  });
  const c = serviceOf({ id: asServiceId('svc_0a1b2c3f'), taskId: asTaskId('t-2'), sessionId: null, workerId: 'remote-1', state: 'failed', detail: '30 秒内没有监听端口' });
  await store.sessionServices.save(a);
  await store.sessionServices.save(b);
  await store.sessionServices.save(c);

  assert.deepEqual(await store.sessionServices.byId(a.id), a);
  assert.equal(await store.sessionServices.byId(asServiceId('svc_ffffffff')), null);
  assert.deepEqual(
    (await store.sessionServices.listByTask(asTaskId('t-1'))).map((service) => service.id),
    [a.id, b.id],
  );
  assert.deepEqual(
    (await store.sessionServices.listBySession(asSessionId('s-1'))).map((service) => service.id),
    [a.id],
  );
  assert.deepEqual(
    (await store.sessionServices.listByWorker('remote-1')).map((service) => service.id),
    [c.id],
  );

  // 同 id upsert：状态变化落库，不新增行
  await store.sessionServices.save({ ...a, state: 'failed', pid: null, detail: '退出码 1', logTail: 'boom', updatedAt: 30 });
  const again = await store.sessionServices.byId(a.id);
  assert.equal(again?.state, 'failed');
  assert.equal(again?.detail, '退出码 1');
  assert.equal(again?.logTail, 'boom');
  assert.equal((await store.sessionServices.listByTask(asTaskId('t-1'))).length, 2);

  await store.sessionServices.remove(a.id);
  assert.equal(await store.sessionServices.byId(a.id), null);
});

test('状态 / 日志按列更新：旧状态帧不覆盖新状态，日志不碰 envKeys / command', async () => {
  const store = openSqliteStore(':memory:');
  const a = serviceOf();
  await store.sessionServices.save(a);

  // 正常推进
  const running = { ...a, state: 'running' as const, updatedAt: 30 };
  assert.equal(await store.sessionServices.updateState(running), true);
  assert.equal((await store.sessionServices.byId(a.id))?.state, 'running');

  // 晚到的旧帧：updatedAt 更小，写不进去
  const stale = { ...a, state: 'failed' as const, detail: '旧帧', updatedAt: 25 };
  assert.equal(await store.sessionServices.updateState(stale), false);
  assert.equal((await store.sessionServices.byId(a.id))?.state, 'running');
  assert.equal((await store.sessionServices.byId(a.id))?.detail, null);

  // 日志只追加 log_tail / updated_at，不碰状态 / envKeys / command
  await store.sessionServices.appendLogTail(a.id, 'hello\n', 40);
  const after = await store.sessionServices.byId(a.id);
  assert.equal(after?.logTail, 'vite ready\nhello\n');
  assert.equal(after?.updatedAt, 40);
  assert.deepEqual(after?.envKeys, a.envKeys);
  assert.equal(after?.command, a.command);
  assert.equal(after?.state, 'running');
});

test('日志原子追加：连续两段都保留，超出上限只留最后 8192 个字符（#233）', async () => {
  const store = openSqliteStore(':memory:');
  const a = serviceOf({ logTail: '' });
  await store.sessionServices.save(a);

  await store.sessionServices.appendLogTail(a.id, 'one\n', 41);
  await store.sessionServices.appendLogTail(a.id, 'two\n', 42);
  const both = await store.sessionServices.byId(a.id);
  assert.equal(both?.logTail, 'one\ntwo\n');
  assert.equal(both?.updatedAt, 42);

  const overflow = `${'x'.repeat(SERVICE_LOG_MAX)}tail`;
  await store.sessionServices.appendLogTail(a.id, overflow, 43);
  const capped = await store.sessionServices.byId(a.id);
  assert.equal(capped?.logTail.length, SERVICE_LOG_MAX);
  assert.equal(capped?.logTail, overflow.slice(-SERVICE_LOG_MAX));
});

test('老库 env 明文迁移成 envKeys：只留键名、删掉旧列、重复打开不重迁（#233）', async () => {
  const db = new DatabaseSync(':memory:');
  // 迁移前的表形状：env 列存的是完整 JSON 值。
  db.exec(`
    CREATE TABLE session_services (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      workspace_id TEXT,
      session_id TEXT,
      worker_id TEXT NOT NULL,
      root TEXT NOT NULL,
      command TEXT NOT NULL,
      port INTEGER,
      env TEXT NOT NULL DEFAULT '{}',
      restart TEXT NOT NULL,
      state TEXT NOT NULL,
      pid INTEGER,
      detail TEXT,
      log_tail TEXT NOT NULL DEFAULT '',
      started_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);
  const insert = db.prepare(`
    INSERT INTO session_services
      (id, project_id, task_id, workspace_id, session_id, worker_id, root, command, port, env, restart, state, pid, detail, log_tail, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('svc_00000001', 'p-1', null, null, null, 'local', '/tmp/demo', 'npm run dev', 3000,
    '{"NODE_ENV":"development","API_BASE":"https://example.test"}', 'always', 'running', 4321, null, 'ready\n', 10, 20);
  insert.run('svc_00000002', 'p-1', null, null, null, 'local', '/tmp/demo', 'npm test', null,
    'not-json', 'never', 'stopped', null, null, '', null, 21);
  insert.run('svc_00000003', 'p-1', null, null, null, 'local', '/tmp/demo', 'npm run build', null,
    '{}', 'never', 'stopped', null, null, '', null, 22);

  const services = createSqliteSessionServices(db);
  const migrated = await services.byId(asServiceId('svc_00000001'));
  assert.deepEqual(migrated?.envKeys, ['API_BASE', 'NODE_ENV']);
  assert.equal(migrated !== undefined && 'env' in migrated, false);
  assert.deepEqual((await services.byId(asServiceId('svc_00000002')))?.envKeys, []);
  assert.deepEqual((await services.byId(asServiceId('svc_00000003')))?.envKeys, []);

  // 旧列删掉后逻辑行里不再有明文；坏 JSON 也没有拖垮同一批。
  const columns = db.prepare('PRAGMA table_info(session_services)').all() as { name: string }[];
  assert.equal(columns.some((column) => column.name === 'env'), false);
  const raw = db.prepare('SELECT * FROM session_services WHERE id = ?').get('svc_00000001') as Record<string, unknown>;
  assert.equal('env' in raw, false);
  assert.doesNotMatch(JSON.stringify(raw), /development|example\.test/);

  // 幂等：再次打开同一个库不重复迁移，键名与行数都不变。
  const again = createSqliteSessionServices(db);
  assert.deepEqual((await again.byId(asServiceId('svc_00000001')))?.envKeys, ['API_BASE', 'NODE_ENV']);
  assert.equal(Number((db.prepare('SELECT count(*) AS n FROM session_services').get() as { n: number }).n), 3);
});
