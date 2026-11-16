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
  asSessionId,
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

test('侧聊会话往返：kind 与 parentSessionId 不丢', async () => {
  const store = openSqliteStore(':memory:');
  const w = await seeded(store);
  const side: Session = {
    ...w.session,
    id: asSessionId('side-1'),
    kind: 'side',
    parentSessionId: w.session.id
  };
  await store.sessions.save(side);
  assert.deepEqual(await store.sessions.byId(side.id), side);
  store.close();
});

test('bot 会话往返：botId 不丢，后续保存不会把它清掉（#221）', async () => {
  const store = openSqliteStore(':memory:');
  const w = await seeded(store);
  const botSession: Session = { ...w.session, id: asSessionId('bot-1'), botId: 'bot_0123456789abcdef' };
  await store.sessions.save(botSession);
  assert.deepEqual(await store.sessions.byId(botSession.id), botSession);
  // 老代码重新保存一份没有 botId 的对象：bot_id 只在 insert 时写，不能被 NULL 覆盖。
  await store.sessions.save({ ...botSession, botId: null, updatedAt: now + 1 });
  assert.equal((await store.sessions.byId(botSession.id))?.botId, 'bot_0123456789abcdef');
  store.close();
});

test('sessions.bot_id 迁移幂等：同一个库连开两次不报错（#221）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-bot-migrate-'));
  const file = join(dir, 'hub.db');
  try {
    openSqliteStore(file).close();
    const store = openSqliteStore(file);
    const columns = store.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    assert.ok(columns.some((column) => column.name === 'bot_id'));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const opening = await store.sessions.firstPrompt(session.id);
  assert.equal(opening?.seq, 1);
  assert.equal(opening?.event.kind === 'prompt' ? opening.event.text : '', '写个文件');

  const stored = await store.sessions.byId(session.id);
  assert.equal(stored?.lastSeq, 4);
  assert.equal(stored?.status, 'done');
  session = applyEvent(session, { kind: 'prompt', text: '后一句' }, now + 4);
  await store.sessions.append(session, { kind: 'prompt', text: '后一句' }, now + 4);
  const stillFirst = await store.sessions.firstPrompt(session.id);
  assert.equal(stillFirst?.event.kind === 'prompt' ? stillFirst.event.text : '', '写个文件');

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
    passwordHash: 'scrypt$x', emailVerifiedAt: null, disabledAt: null, createdAt: 1, teamId: null, clusterAdmin: false, deletedAt: null
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
    passwordHash: null, emailVerifiedAt: null, disabledAt: null, createdAt: 1, teamId: null, clusterAdmin: false, deletedAt: null
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

  assert.deepEqual(await store.settings.get(), { openRegistration: false, membersCanAddMachines: true, refuseWhenFull: [] });
  await store.settings.save({ openRegistration: true, membersCanAddMachines: true, refuseWhenFull: [] });
  assert.deepEqual(await store.settings.get(), { openRegistration: true, membersCanAddMachines: true, refuseWhenFull: [] });

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
  const base = { passwordHash: 'x', emailVerifiedAt: 1, disabledAt: null, teamId: null, clusterAdmin: false, deletedAt: null };
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
    assert.equal(david?.clusterAdmin, true);
    assert.equal(member?.clusterAdmin, false);
    assert.equal(david?.teamId, 'team-d1');
    assert.equal(member?.teamId, 'team-d1');
    assert.equal((await store.users.firstClusterAdmin())?.id, 'd1');
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

test('会话名：setTitle 落库；之后的 save（跑着的会话拿旧对象）不会冲掉名字；null 清掉', async () => {
  const store = openSqliteStore(':memory:');
  const { session } = await seeded(store);
  await store.sessions.setTitle(session.id, '查登录 bug', now + 1);
  assert.equal((await store.sessions.byId(session.id))?.title, '查登录 bug');
  await store.sessions.save({ ...session, updatedAt: now + 2 });
  assert.equal((await store.sessions.byId(session.id))?.title, '查登录 bug');
  assert.equal((await store.sessions.listByTask(session.taskId!))[0]?.title, '查登录 bug');
  await store.sessions.setTitle(session.id, null, now + 3);
  assert.equal((await store.sessions.byId(session.id))?.title, undefined);
  store.close();
});

test('会话状态按 last_seq 单调写回：更旧的会话对象不会把 done 翻回 running', async () => {
  const store = openSqliteStore(':memory:');
  const { session } = await seeded(store);
  // 模拟两个写方：一个已经把这个会话推到 done（游标 12），另一个手里还是游标 3 的 running
  await store.sessions.save({ ...session, status: 'done', lastSeq: 12, updatedAt: now + 10 });
  await store.sessions.save({ ...session, status: 'running', lastSeq: 3, updatedAt: now + 11 });
  const after = await store.sessions.byId(session.id);
  assert.equal(after?.status, 'done');
  assert.equal(after?.lastSeq, 12);
  store.close();
});

test('任务分支只写不抹：branch 为 null 的旧对象不会清掉已经回写的分支', async () => {
  const store = openSqliteStore(':memory:');
  const { project, task } = await seeded(store);
  await store.tasks.save({ ...task, branch: 'agent-hub/feat-x', updatedAt: now + 1 });
  await store.tasks.save({ ...task, branch: null, summary: '换了说明', updatedAt: now + 2 });
  const after = await store.tasks.byId(task.id);
  assert.equal(after?.branch, 'agent-hub/feat-x');
  assert.equal(after?.summary, '换了说明');
  assert.equal((await store.tasks.listByProject(project.id))[0]?.branch, 'agent-hub/feat-x');
  store.close();
});

test('sessions.markInterrupted 是条件写：只有库里还是 running 才降级，返回是否真的改了', async () => {
  const store = openSqliteStore(':memory:');
  const { session } = await seeded(store);
  await store.sessions.save({ ...session, status: 'running', updatedAt: now + 1 });
  assert.equal(await store.sessions.markInterrupted(session.id, now + 2), true);
  const after = await store.sessions.byId(session.id);
  assert.equal(after?.status, 'interrupted');
  assert.equal(after?.updatedAt, now + 2);
  // 已经结束的会话（agent 的 ended 先落地）：迟到的掉线收尾不能把它翻回 interrupted
  await store.sessions.save({ ...session, status: 'done', lastSeq: 9, updatedAt: now + 3 });
  assert.equal(await store.sessions.markInterrupted(session.id, now + 4), false);
  const done = await store.sessions.byId(session.id);
  assert.equal(done?.status, 'done');
  assert.equal(done?.updatedAt, now + 3, '没改就不该动 updatedAt');
  store.close();
});

test('tasks.setBranch 只写 branch：并发改过的 status / 标题不会被旧快照回滚', async () => {
  const store = openSqliteStore(':memory:');
  const { task } = await seeded(store);
  const stale = { ...task, status: 'in_progress' as const, branch: null };
  // 另一个事务先把任务标成 done，然后掉线/工作空间那一路拿旧快照只回写 branch
  await store.tasks.save({ ...task, status: 'done', title: '改过的标题', updatedAt: now + 1 });
  await store.tasks.setBranch(task.id, 'agent-hub/fix-login-ab12');
  const after = await store.tasks.byId(task.id);
  assert.equal(after?.branch, 'agent-hub/fix-login-ab12');
  assert.equal(after?.status, 'done', 'setBranch 不碰 status');
  assert.equal(after?.title, '改过的标题');
  assert.notEqual(stale.branch, after?.branch);
  store.close();
});

test('收起时间存得下、恢复后读回不带这个字段（和没收起的会话一样）', async () => {
  const store = openSqliteStore(':memory:');
  const { session } = await seeded(store);
  await store.sessions.save({ ...session, settledAt: now + 5 });
  assert.equal((await store.sessions.byId(session.id))?.settledAt, now + 5);
  await store.sessions.save({ ...session, settledAt: null });
  const restored = await store.sessions.byId(session.id);
  assert.equal(restored?.settledAt, undefined);
  assert.deepEqual(restored, session);
  store.close();
});

/** 把 sessions 表改回旧形状（task_id NOT NULL），模拟 #221 步骤 7 之前的库。 */
function rebuildSessionsWithNotNullTaskId(file: string) {
  const raw = new DatabaseSync(file);
  const columns = raw.prepare('PRAGMA table_info(sessions)').all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  const defs = columns.map((column) =>
    column.name === 'task_id'
      ? 'task_id TEXT NOT NULL REFERENCES tasks(id)'
      : `${column.name} ${column.type}${column.notnull ? ' NOT NULL' : ''}${
          column.dflt_value === null ? '' : ` DEFAULT ${column.dflt_value}`
        }${column.pk ? ' PRIMARY KEY' : ''}`
  );
  const names = columns.map((column) => column.name).join(', ');
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec(`CREATE TABLE sessions_old (${defs.join(', ')})`);
  raw.exec(`INSERT INTO sessions_old (${names}) SELECT ${names} FROM sessions`);
  raw.exec('DROP TABLE sessions');
  raw.exec('ALTER TABLE sessions_old RENAME TO sessions');
  raw.exec('CREATE INDEX IF NOT EXISTS sessions_by_task ON sessions(task_id)');
  raw.close();
}

test('sessions.task_id 迁移：旧库 NOT NULL 放宽为可空，旧会话与任务都不丢（#221 步骤 7）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-container-migrate-'));
  const file = join(dir, 'hub.db');
  try {
    const before = openSqliteStore(file);
    const seededWorld = await seeded(before);
    before.close();

    rebuildSessionsWithNotNullTaskId(file);
    const old = new DatabaseSync(file);
    const oldTaskId = old.prepare('PRAGMA table_info(sessions)').all() as { name: string; notnull: number }[];
    assert.equal(oldTaskId.find((column) => column.name === 'task_id')?.notnull, 1);
    old.close();

    const store = openSqliteStore(file);
    const columns = store.db.prepare('PRAGMA table_info(sessions)').all() as { name: string; notnull: number }[];
    assert.equal(columns.find((column) => column.name === 'task_id')?.notnull, 0);
    // 旧数据原样可读，任务行不变。
    assert.deepEqual(await store.sessions.byId(seededWorld.session.id), seededWorld.session);
    assert.deepEqual(await store.tasks.byId(seededWorld.task.id), seededWorld.task);
    assert.deepEqual(await store.sessions.listByTask(seededWorld.task.id), [seededWorld.session]);

    // 迁移之后可以插入不属于任何任务的会话。
    const container = deriveSession({ agentId: asAgentId('grok'), model: 'grok-4', now: now + 10 });
    assert.ok(container.ok);
    await store.sessions.save(container.value);
    const restored = await store.sessions.byId(container.value.id);
    assert.equal(restored?.taskId, null);
    assert.deepEqual(await store.sessions.listByTask(seededWorld.task.id), [seededWorld.session]);
    assert.equal((await store.sessions.listAll()).length, 2);
    store.close();

    // 再开一次是幂等的：不会再重建，也不会丢新写入的容器会话。
    const again = openSqliteStore(file);
    assert.equal((await again.sessions.byId(container.value.id))?.taskId, null);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('轮次：每句提问开启一轮，journal 事件带所属轮次，会话记最近一轮', async () => {
  const store = openSqliteStore(':memory:');
  let { session } = await seeded(store);
  const events: SessionEvent[] = [
    { kind: 'prompt', text: '第一句' },
    { kind: 'text', delta: '回一句' },
    { kind: 'ended', outcome: 'done' },
    { kind: 'prompt', text: '第二句' }
  ];
  for (const [index, event] of events.entries()) {
    session = applyEvent(session, event, now + index);
    await store.sessions.append(session, event, now + index);
  }
  const entries = await store.sessions.eventsAfter(session.id, 0);
  assert.deepEqual(entries.map((entry) => entry.turn), [1, 1, 1, 2]);
  const stored = await store.sessions.byId(session.id);
  assert.equal(stored?.turn, 2);
});

test('打开库时把 sessions.turn 从 journal 回填：老会话下一句提问不会从 1 重新数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-turn-'));
  const path = join(dir, 'hub.db');
  try {
    const store = openSqliteStore(path);
    const { session } = await seeded(store);
    const prompt = { kind: 'prompt', text: '第一句' } as SessionEvent;
    await store.sessions.append(applyEvent(session, prompt, now), prompt, now);
    store.close();

    // 模拟引入 turn 列之前的老库：历史都在，但会话上的轮次还是 0。
    const raw = new DatabaseSync(path);
    raw.exec('UPDATE sessions SET turn = 0');
    raw.close();

    const reopened = openSqliteStore(path);
    const after = await reopened.sessions.byId(session.id);
    assert.equal(after?.turn, 1, '按 journal 里的最大轮次回填');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('常驻：setPinned 落库；整行 save 拿旧对象回写也不会把标记冲掉', async () => {
  const store = openSqliteStore(':memory:');
  const { session } = await seeded(store);
  assert.equal(await store.sessions.setPinned(session.id, true, now + 1), true);
  assert.equal((await store.sessions.byId(session.id))?.pinned, true);

  // 跑着的会话拿着不含 pinned 的旧快照整行回写。
  await store.sessions.save({ ...session });
  assert.equal((await store.sessions.byId(session.id))?.pinned, true);

  assert.equal(await store.sessions.setPinned(session.id, false, now + 2), true);
  assert.equal((await store.sessions.byId(session.id))?.pinned, undefined);
  store.close();
});

test('资产组合引用：项目 / 会话的 assetSetIds 往返；旧快照回写不会冲掉', async () => {
  const store = openSqliteStore(':memory:');
  const { project, session } = await seeded(store);
  assert.deepEqual(project.assetSetIds, []);

  await store.projects.save({ ...project, assetSetIds: ['aset_1', 'aset_2'] });
  assert.deepEqual((await store.projects.byId(project.id))?.assetSetIds, ['aset_1', 'aset_2']);
  // 旧项目对象（不含这一列）整行回写不能把绑定冲掉。
  await store.projects.save({ ...project, assetSetIds: undefined as never });
  assert.deepEqual((await store.projects.byId(project.id))?.assetSetIds, ['aset_1', 'aset_2']);

  await store.sessions.save({ ...session, assetSetIds: ['aset_1'] });
  assert.deepEqual((await store.sessions.byId(session.id))?.assetSetIds, ['aset_1']);
  await store.sessions.save({ ...session });
  assert.deepEqual((await store.sessions.byId(session.id))?.assetSetIds, ['aset_1']);
  store.close();
});

test('会话级资产：assetIds 落库往返；旧快照回写不会把选择冲掉', async () => {
  const store = openSqliteStore(':memory:');
  const { session } = await seeded(store);
  const chosen = { ...session, assetIds: ['a1', 'a2'] as const };
  await store.sessions.save(chosen);
  assert.deepEqual((await store.sessions.byId(session.id))?.assetIds, ['a1', 'a2']);

  // 跑着的会话拿着不含 assetIds 的旧对象整行回写。
  await store.sessions.save({ ...session });
  assert.deepEqual((await store.sessions.byId(session.id))?.assetIds, ['a1', 'a2']);
  store.close();
});
