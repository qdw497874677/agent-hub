import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asAgentId,
  asSessionId,
  createProject,
  createTask,
  deriveSession,
  previewLinkIdFrom,
  type PreviewLink,
} from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

const linkOf = (patch: Partial<PreviewLink> & Pick<PreviewLink, 'id' | 'sessionId' | 'hubPort'>): PreviewLink => ({
  workerId: 'local',
  port: 3000,
  label: '端口 3000',
  source: 'manual',
  state: 'ready',
  createdAt: 10,
  lastSeenAt: 10,
  ...patch,
});

test('预览链接存储：读写往返，按会话/端口查，删除', async () => {
  const store = openSqliteStore(':memory:');
  const session = asSessionId('s-1');
  const other = asSessionId('s-2');
  const a = linkOf({ id: previewLinkIdFrom('0a1b2c3d'), sessionId: session, hubPort: 17901 });
  const b = linkOf({ id: previewLinkIdFrom('0a1b2c3e'), sessionId: session, hubPort: 17902, port: 4000, label: '端口 4000', createdAt: 12 });
  const c = linkOf({ id: previewLinkIdFrom('0a1b2c3f'), sessionId: other, hubPort: 17903, state: 'offline' });
  await store.previewLinks.save(a);
  await store.previewLinks.save(b);
  await store.previewLinks.save(c);

  assert.deepEqual(await store.previewLinks.byId(a.id), a);
  assert.deepEqual(await store.previewLinks.byHubPort(17902), b);
  assert.equal(await store.previewLinks.byHubPort(17999), null);
  assert.deepEqual(
    (await store.previewLinks.listBySession(session)).map((link) => link.id),
    [a.id, b.id],
  );
  assert.equal((await store.previewLinks.listAll()).length, 3);

  // 同 id upsert：状态变化落库，不新增行
  await store.previewLinks.save({ ...a, state: 'offline', lastSeenAt: 20 });
  assert.equal((await store.previewLinks.byId(a.id))?.state, 'offline');
  assert.equal((await store.previewLinks.listAll()).length, 3);

  await store.previewLinks.remove(a.id);
  assert.equal(await store.previewLinks.byId(a.id), null);
  await store.previewLinks.removeBySession(session);
  assert.equal((await store.previewLinks.listBySession(session)).length, 0);
  assert.equal((await store.previewLinks.listAll()).length, 1);
  store.close();
});

test('预览链接存储：hub_port 全库唯一', async () => {
  const store = openSqliteStore(':memory:');
  await store.previewLinks.save(linkOf({ id: previewLinkIdFrom('aaaaaaaa'), sessionId: asSessionId('s-1'), hubPort: 17901 }));
  await assert.rejects(
    () => store.previewLinks.save(linkOf({ id: previewLinkIdFrom('bbbbbbbb'), sessionId: asSessionId('s-2'), hubPort: 17901 })),
    /UNIQUE|constraint/i,
  );
  await store.previewLinks.save(linkOf({ id: previewLinkIdFrom('bbbbbbbb'), sessionId: asSessionId('s-2'), hubPort: 17902 }));
  // 已存在的行把 hub_port 改到别人占用的值也要报错
  await assert.rejects(
    () => store.previewLinks.save(linkOf({ id: previewLinkIdFrom('bbbbbbbb'), sessionId: asSessionId('s-2'), hubPort: 17901 })),
    /UNIQUE|constraint/i,
  );
  store.close();
});

test('彻底删除会话：预览链接跟着清掉', async () => {
  const store = openSqliteStore(':memory:');
  const project = createProject({ name: 'demo', now: 1, teamId: 't1', createdBy: 'u1' });
  assert.ok(project.ok);
  const task = createTask({ projectId: project.value.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1, createdBy: 'u1' });
  assert.ok(session.ok);
  await store.projects.save(project.value);
  await store.tasks.save(task.value);
  await store.sessions.save(session.value);
  await store.previewLinks.save(
    linkOf({ id: previewLinkIdFrom('0a1b2c3d'), sessionId: session.value.id, hubPort: 17901 }),
  );
  assert.equal((await store.previewLinks.listBySession(session.value.id)).length, 1);

  await store.sessions.remove(session.value.id);
  assert.equal((await store.previewLinks.listBySession(session.value.id)).length, 0);
  assert.equal((await store.previewLinks.listAll()).length, 0);
  store.close();
});
