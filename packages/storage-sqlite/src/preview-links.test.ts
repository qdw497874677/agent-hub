import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  asAgentId,
  asSessionId,
  createProject,
  createTask,
  deriveSession,
  previewLinkIdFrom,
  type PreviewLink,
} from '@agent-hub/domain';
import { createSqlitePreviewLinks } from './preview-links.ts';
import { openSqliteStore } from './store.ts';

const linkOf = (patch: Partial<PreviewLink> & Pick<PreviewLink, 'id' | 'sessionId' | 'hubPort'>): PreviewLink => ({
  workerId: 'local',
  port: 3000,
  label: '端口 3000',
  source: 'manual',
  state: 'ready',
  createdAt: 10,
  lastSeenAt: 10,
  shareTokenHash: null,
  shareExpiresAt: null,
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

test('预览链接存储：分享哈希/到期时间往返，撤销后清空', async () => {
  const store = openSqliteStore(':memory:');
  const base = linkOf({ id: previewLinkIdFrom('0a1b2c3d'), sessionId: asSessionId('s-1'), hubPort: 17901 });
  await store.previewLinks.save({ ...base, shareTokenHash: 'a'.repeat(64), shareExpiresAt: 1_700_000_000_000 });
  const stored = await store.previewLinks.byId(base.id);
  assert.equal(stored?.shareTokenHash, 'a'.repeat(64));
  assert.equal(stored?.shareExpiresAt, 1_700_000_000_000);

  // 重新分享 = 覆盖哈希，旧令牌的哈希不残留。
  await store.previewLinks.save({ ...stored!, shareTokenHash: 'b'.repeat(64), shareExpiresAt: 1_800_000_000_000 });
  assert.equal((await store.previewLinks.byId(base.id))?.shareTokenHash, 'b'.repeat(64));

  // 撤销：两列都清空，能读回 null。
  await store.previewLinks.save({ ...stored!, shareTokenHash: null, shareExpiresAt: null });
  const cleared = await store.previewLinks.byId(base.id);
  assert.equal(cleared?.shareTokenHash, null);
  assert.equal(cleared?.shareExpiresAt, null);
  store.close();
});

test('预览链接存储：老表缺分享列时用 ALTER TABLE 补齐', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE preview_links (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, worker_id TEXT NOT NULL,
    port INTEGER NOT NULL, hub_port INTEGER NOT NULL UNIQUE, label TEXT NOT NULL,
    source TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL)`);
  // 老行先塞进去，补列后不应该丢。
  db.prepare(`INSERT INTO preview_links
    (id, session_id, worker_id, port, hub_port, label, source, state, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('pv_0a1b2c3d', 's-1', 'local', 3000, 17901, '端口 3000', 'manual', 'ready', 10, 10);
  const repo = createSqlitePreviewLinks(db);
  const old = await repo.byId(previewLinkIdFrom('0a1b2c3d'));
  assert.equal(old?.shareTokenHash, null);
  assert.equal(old?.shareExpiresAt, null);
  await repo.save({ ...old!, shareTokenHash: 'c'.repeat(64), shareExpiresAt: 123 });
  assert.equal((await repo.byId(previewLinkIdFrom('0a1b2c3d')))?.shareExpiresAt, 123);
  db.close();
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
