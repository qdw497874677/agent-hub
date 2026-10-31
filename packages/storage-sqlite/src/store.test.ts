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
    passwordHash: 'scrypt$x', emailVerifiedAt: null, disabledAt: null, createdAt: 1, teamId: null, hubAdmin: false, deletedAt: null
  };
  await store.users.save(owner);
  await store.users.save({ ...owner, id: asUserId('u2'), email: 'c@d.co', createdAt: 2 });
  assert.equal((await store.users.byEmail('a@b.co'))?.id, 'u1');
  assert.equal((await store.users.firstWithRole('owner'))?.id, 'u1');
  await store.users.save({ ...owner, disabledAt: 9 });
  assert.equal((await store.users.firstWithRole('owner'))?.id, 'u2');

  await store.logins.save({
    id: asLoginId('l1'), userId: asUserId('u1'), tokenHash: 'h1', method: 'password',
    userAgent: null, ip: null, createdAt: 10, lastSeenAt: 10, expiresAt: 100
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
    passwordHash: null, emailVerifiedAt: null, disabledAt: null, createdAt: 1, teamId: null, hubAdmin: false, deletedAt: null
  };
  await store.users.save(user);
  const login = (id: string, createdAt: number, expiresAt: number) => ({
    id: asLoginId(id), userId: user.id, tokenHash: `h-${id}`, method: 'password' as const,
    userAgent: null, ip: null, createdAt, lastSeenAt: createdAt, expiresAt
  });
  await store.logins.save(login('l1', 10, 1_000));
  await store.logins.save(login('l2', 20, 1_000));
  assert.deepEqual((await store.logins.recent(1)).map((row) => row.id), ['l2']);
  assert.deepEqual(await store.logins.activity(15), [{ userId: 'u1', lastSeenAt: 20, active: 2 }]);
  await store.logins.removeForUser(user.id, asLoginId('l2'));
  assert.deepEqual((await store.logins.recent(5)).map((row) => row.id), ['l2']);

  assert.deepEqual(await store.settings.get(), { openRegistration: false, membersCanAddMachines: true, localWorkerGrants: [], refuseWhenFull: [] });
  await store.settings.save({ openRegistration: true, membersCanAddMachines: true, localWorkerGrants: ['u1'], refuseWhenFull: [] });
  assert.deepEqual(await store.settings.get(), { openRegistration: true, membersCanAddMachines: true, localWorkerGrants: ['u1'], refuseWhenFull: [] });

  const entry = { id: 'a1', actorId: user.id, actorEmail: 'a@b.co', action: 'user.disable' as const, target: 'x', detail: '', at: 5 };
  await store.audit.append(entry);
  await store.audit.append({ ...entry, id: 'a2', at: 6 });
  assert.deepEqual((await store.audit.recent(10)).map((row) => row.id), ['a2', 'a1']);
  assert.deepEqual((await store.audit.recent(10))[1], { ...entry, ip: null, teamId: null });
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

test('账号 P3 迁移：老库的用户一次性记为已验证；一次性令牌只能用一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-p3-'));
  const file = join(dir, 'hub.db');
  const first = openSqliteStore(file);
  await first.users.save({
    id: asUserId('u1'), email: 'a@b.co', displayName: 'a', role: 'member', passwordHash: 'x',
    emailVerifiedAt: null, disabledAt: null, createdAt: 7, lastLoginAt: null
  } as never);
  first.close();
  const raw = new DatabaseSync(file);
  raw.exec('DROP TABLE one_time_tokens; UPDATE users SET email_verified_at = NULL');
  raw.close();
  const store = openSqliteStore(file);
  assert.equal((await store.users.byEmail('a@b.co'))?.emailVerifiedAt, 7);
  const token = { tokenHash: 'th', purpose: 'verify-email' as const, userId: asUserId('u1'), email: 'a@b.co', createdAt: 10, expiresAt: 100, usedAt: null };
  await store.oneTimeTokens.save(token);
  assert.equal(await store.oneTimeTokens.consume('th', 'reset-password', 20), null);
  assert.equal((await store.oneTimeTokens.consume('th', 'verify-email', 20))?.userId, 'u1');
  assert.equal(await store.oneTimeTokens.consume('th', 'verify-email', 21), null);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('团队迁移（ADR 0011）：老库的人和项目都并进最早那位主人的团队，他成为 hub 管理员；重复打开不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-teams-'));
  const file = join(dir, 'hub.db');
  const first = openSqliteStore(file);
  const base = { passwordHash: 'x', emailVerifiedAt: 1, disabledAt: null, teamId: null, hubAdmin: false, deletedAt: null };
  await first.users.save({ ...base, id: asUserId('m1'), email: 'm@b.co', displayName: 'm', role: 'member', createdAt: 1 });
  await first.users.save({ ...base, id: asUserId('d1'), email: 'd@b.co', displayName: 'David', role: 'owner', createdAt: 2 });
  const project = createProject({ name: 'old', now: 1 });
  assert.ok(project.ok);
  await first.projects.save(project.value);
  first.close();
  // 模拟老库：没有 teams 表，人和项目都没有团队
  const raw = new DatabaseSync(file);
  raw.exec('DROP TABLE teams; UPDATE users SET team_id = NULL, hub_admin = 0; UPDATE projects SET team_id = NULL, created_by = NULL');
  raw.close();

  for (let round = 0; round < 2; round++) {
    const store = openSqliteStore(file);
    const david = await store.users.byEmail('d@b.co');
    const member = await store.users.byEmail('m@b.co');
    assert.equal(david?.hubAdmin, true);
    assert.equal(member?.hubAdmin, false);
    assert.equal(david?.teamId, 'team-d1');
    assert.equal(member?.teamId, 'team-d1');
    assert.equal((await store.users.hubAdmin())?.id, 'd1');
    assert.deepEqual((await store.teams.list()).map((team) => [team.id, team.ownerId]), [['team-d1', 'd1']]);
    const migrated = await store.projects.byId(project.value.id);
    assert.equal(migrated?.teamId, 'team-d1');
    assert.equal(migrated?.createdBy, 'd1');
    assert.equal(migrated?.deletedAt, null);
    assert.deepEqual(migrated?.members, []);
    store.close();
  }
  rmSync(dir, { recursive: true, force: true });
});
