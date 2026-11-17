import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteStore } from './store.ts';
import { asServiceId, asSessionId, asTaskId, type SessionService } from '@agent-hub/domain';

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
  env: { NODE_ENV: 'development' },
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
    env: {},
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

test('状态 / 日志按列更新：旧状态帧不覆盖新状态，日志不碰 env / command', async () => {
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

  // 日志只改 log_tail / updated_at
  await store.sessionServices.appendLogTail(a.id, 'hello\n', 40);
  const after = await store.sessionServices.byId(a.id);
  assert.equal(after?.logTail, 'hello\n');
  assert.equal(after?.updatedAt, 40);
  assert.deepEqual(after?.env, a.env);
  assert.equal(after?.command, a.command);
  assert.equal(after?.state, 'running');
});
