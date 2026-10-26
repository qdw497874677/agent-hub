import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  applyEvent,
  asAgentId,
  asProjectId,
  createArtifact,
  createProject,
  createTask,
  deriveSession,
  type Session,
  type SessionEvent
} from '@agent-hub/domain';
import { openSqliteStore, type SqliteStore } from './store.ts';
import { asLoginId, asUserId } from '@agent-hub/domain';

/**
 * 仓储往返测试：domain 对象存进去、读出来必须一模一样。
 * mappers.ts 是领域形状与行形状之间唯一的翻译点，这里是它的护栏。
 */
const now = 1_700_000_000_000;

function world() {
  const project = createProject({ name: 'demo', now, id: undefined });
  assert.ok(project.ok);
  const task = createTask({ projectId: project.value.id, title: '往返', goal: '一字不差', now, id: undefined });
  assert.ok(task.ok);
  const session = deriveSession({ task: task.value, agentId: asAgentId('grok'), model: 'grok-4', now });
  assert.ok(session.ok);
  const withOptions: Session = { ...session.value, options: { reasoning_effort: 'low', yolo: true } };
  return { project: project.value, task: task.value, session: withOptions };
}

async function seeded(store: SqliteStore) {
  const w = world();
  await store.projects.save(w.project);
  await store.tasks.save(w.task);
  await store.sessions.save(w.session);
  return w;
}

test('project / task / session 往返无损，含可调项', async () => {
  const store = openSqliteStore(':memory:');
  const { project, task, session } = await seeded(store);
  assert.deepEqual(await store.projects.byId(project.id), project);
  assert.deepEqual(await store.projects.list(), [project]);
  assert.deepEqual(await store.tasks.byId(task.id), task);
  assert.deepEqual(await store.tasks.listByProject(project.id), [task]);
  assert.deepEqual(await store.sessions.byId(session.id), session);
  assert.deepEqual(await store.sessions.listByTask(task.id), [session]);
  assert.deepEqual(await store.sessions.listByProject(project.id), [session]);
  store.close();
});

test('save 是 upsert：再次保存覆盖而不是新增', async () => {
  const store = openSqliteStore(':memory:');
  const { task } = await seeded(store);
  const renamed = { ...task, title: '改过的标题', updatedAt: now + 1 };
  await store.tasks.save(renamed);
  assert.deepEqual(await store.tasks.listByProject(task.projectId), [renamed]);
  store.close();
});

test('journal：append 分配连续序号，eventsAfter 与 tail 切片正确，结束事件落到会话状态', async () => {
  const store = openSqliteStore(':memory:');
  let { session } = await seeded(store);
  const events: SessionEvent[] = [
    { kind: 'prompt', text: '写个文件' },
    { kind: 'text', delta: '好' },
    { kind: 'artifact', path: 'a.txt', bytes: 2 },
    { kind: 'ended', outcome: 'done' }
  ];
  for (const [index, event] of events.entries()) {
    session = applyEvent(session, event, now + index);
    await store.sessions.append(session, event, now + index);
  }

  const all = await store.sessions.eventsAfter(session.id, 0);
  assert.deepEqual(all.map((entry) => entry.seq), [1, 2, 3, 4]);
  assert.deepEqual(all.map((entry) => entry.event), events);
  assert.deepEqual((await store.sessions.eventsAfter(session.id, 2)).map((entry) => entry.seq), [3, 4]);
  assert.deepEqual((await store.sessions.tail(session.id, 2)).map((entry) => entry.seq), [3, 4]);

  const stored = await store.sessions.byId(session.id);
  assert.equal(stored?.lastSeq, 4);
  assert.equal(stored?.status, 'done');

  await store.sessions.linkEntry(session.id, 2, 'entry-2');
  assert.equal(await store.sessions.entryIdAt(session.id, 2), 'entry-2');
  assert.equal(await store.sessions.entryIdAt(session.id, 3), null);
  store.close();
});

test('artifact 与画布布局往返', async () => {
  const store = openSqliteStore(':memory:');
  const { project, task, session } = await seeded(store);
  const artifact = createArtifact({ sessionId: session.id, taskId: task.id, path: 'out/hello.txt', bytes: 5, now });
  assert.ok(artifact.ok);
  await store.artifacts.save(artifact.value);
  assert.deepEqual(await store.artifacts.bySession(session.id), [artifact.value]);
  assert.deepEqual(await store.artifacts.byTask(task.id), [artifact.value]);

  assert.equal(await store.layout.load(project.id), null);
  const layout = {
    projectId: project.id,
    positions: { [task.id]: { x: 10, y: -4 } },
    sizes: { [task.id]: { width: 320, height: 180 } },
    updatedAt: now
  };
  await store.layout.save(layout);
  assert.deepEqual(await store.layout.load(project.id), layout);
  store.close();
});

test('数据落在文件里：关掉重开还在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-store-'));
  try {
    const file = join(dir, 'hub.db');
    const first = openSqliteStore(file);
    const { session } = await seeded(first);
    first.close();
    const second = openSqliteStore(file);
    const reopened = await second.sessions.byId(session.id);
    // 新写的项目不再有旧的 root_path：重开时迁移什么都不补
    assert.deepEqual(reopened, session);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('老库迁移：layout 表没有 sizes 列时自动补上，旧布局读出来 sizes 为空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-store-'));
  try {
    const file = join(dir, 'hub.db');
    const legacy = new DatabaseSync(file);
    legacy.exec('CREATE TABLE layout (project_id TEXT PRIMARY KEY, positions TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    legacy.prepare('INSERT INTO layout VALUES (?, ?, ?)').run('p-old', JSON.stringify({ t: { x: 1, y: 2 } }), 7);
    legacy.close();

    const store = openSqliteStore(file);
    const loaded = await store.layout.load(asProjectId('p-old'));
    assert.deepEqual(loaded, { projectId: 'p-old', positions: { t: { x: 1, y: 2 } }, sizes: {}, updatedAt: 7 });
    await store.layout.save({ ...loaded!, sizes: { t: { width: 300, height: 200 } } });
    assert.deepEqual((await store.layout.load(asProjectId('p-old')))?.sizes, { t: { width: 300, height: 200 } });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal：带附件的用户提问原样往返（只存元数据）', async () => {
  const store = openSqliteStore(':memory:');
  const { session } = await seeded(store);
  const prompt: SessionEvent = {
    kind: 'prompt',
    text: '看图',
    attachments: [
      { kind: 'image', name: 'a.png', path: '.agent-hub/attachments/s/1-0-a.png', mimeType: 'image/png', bytes: 4 },
      { kind: 'mention', name: 'main.ts', path: 'src/main.ts' }
    ]
  };
  await store.sessions.append(applyEvent(session, prompt, now), prompt, now);
  const [entry] = await store.sessions.eventsAfter(session.id, 0);
  assert.deepEqual(entry?.event, prompt);
  store.close();
});

test('账号：用户按邮箱找回、登录态按哈希找回、停用的人不算 Owner、删人连带删登录态', async () => {
  const store = openSqliteStore(':memory:');
  const owner = {
    id: asUserId('u1'), email: 'a@b.co', displayName: 'a', role: 'owner' as const,
    passwordHash: 'scrypt$x', emailVerifiedAt: null, disabledAt: null, createdAt: 1
  };
  await store.users.save(owner);
  await store.users.save({ ...owner, id: asUserId('u2'), email: 'c@d.co', createdAt: 2 });
  assert.equal((await store.users.byEmail('a@b.co'))?.id, 'u1');
  assert.equal((await store.users.firstWithRole('owner'))?.id, 'u1');
  await store.users.save({ ...owner, disabledAt: 9 });
  assert.equal((await store.users.firstWithRole('owner'))?.id, 'u2');

  await store.logins.save({
    id: asLoginId('l1'), userId: asUserId('u1'), tokenHash: 'h1', method: 'password',
    userAgent: null, createdAt: 10, lastSeenAt: 10, expiresAt: 100
  });
  await store.logins.touch(asLoginId('l1'), 50, 500);
  assert.equal((await store.logins.byTokenHash('h1'))?.expiresAt, 500);
  await store.logins.removeForUser(asUserId('u1'));
  assert.equal(await store.logins.byTokenHash('h1'), null);
  store.close();
});

test('运营后台：登录活跃度、保留当前登录的踢下线、设置与审计往返', async () => {
  const store = openSqliteStore(':memory:');
  const user = {
    id: asUserId('u1'), email: 'a@b.co', displayName: 'a', role: 'owner' as const,
    passwordHash: null, emailVerifiedAt: null, disabledAt: null, createdAt: 1
  };
  await store.users.save(user);
  const login = (id: string, createdAt: number, expiresAt: number) => ({
    id: asLoginId(id), userId: user.id, tokenHash: `h-${id}`, method: 'password' as const,
    userAgent: null, createdAt, lastSeenAt: createdAt, expiresAt
  });
  await store.logins.save(login('l1', 10, 1_000));
  await store.logins.save(login('l2', 20, 1_000));
  assert.deepEqual((await store.logins.recent(1)).map((row) => row.id), ['l2']);
  assert.deepEqual(await store.logins.activity(15), [{ userId: 'u1', lastSeenAt: 20, active: 2 }]);
  await store.logins.removeForUser(user.id, asLoginId('l2'));
  assert.deepEqual((await store.logins.recent(5)).map((row) => row.id), ['l2']);

  assert.deepEqual(await store.settings.get(), { openRegistration: true, membersCanAddMachines: true });
  await store.settings.save({ openRegistration: false, membersCanAddMachines: true });
  assert.equal((await store.settings.get()).openRegistration, false);

  const entry = { id: 'a1', actorId: user.id, actorEmail: 'a@b.co', action: 'user.disable' as const, target: 'x', detail: '', at: 5 };
  await store.audit.append(entry);
  await store.audit.append({ ...entry, id: 'a2', at: 6 });
  assert.deepEqual((await store.audit.recent(10)).map((row) => row.id), ['a2', 'a1']);
  assert.deepEqual((await store.audit.recent(10))[1], entry);
  store.close();
});

test('projects.remove 一次提交删掉项目名下所有记录，别的项目不受影响', async () => {
  const store = openSqliteStore(':memory:');
  const { project, task, session } = await seeded(store);
  const other = await seeded(store);
  await store.sessions.append({ ...session, lastSeq: session.lastSeq + 1 }, { kind: 'text', delta: 'hi' } as SessionEvent, now);
  await store.layout.save({ projectId: project.id, positions: {}, sizes: {}, updatedAt: now });
  await store.projects.remove(project.id);
  assert.equal(await store.projects.byId(project.id), null);
  assert.equal(await store.tasks.byId(task.id), null);
  assert.equal(await store.sessions.byId(session.id), null);
  assert.equal(await store.layout.load(project.id), null);
  assert.deepEqual(await store.projects.list(), [other.project]);
  assert.ok(await store.sessions.byId(other.session.id));
  store.close();
});
