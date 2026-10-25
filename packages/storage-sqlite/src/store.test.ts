import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyEvent,
  asAgentId,
  createArtifact,
  createProject,
  createTask,
  deriveSession,
  type Session,
  type SessionEvent
} from '@agent-hub/domain';
import { openSqliteStore, type SqliteStore } from './store.ts';

/**
 * 仓储往返测试：domain 对象存进去、读出来必须一模一样。
 * mappers.ts 是领域形状与行形状之间唯一的翻译点，这里是它的护栏。
 */
const now = 1_700_000_000_000;

function world() {
  const project = createProject({ name: 'demo', rootPath: '/tmp/demo', directoryExists: true, now, id: undefined });
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
  const layout = { projectId: project.id, positions: { [task.id]: { x: 10, y: -4 } }, updatedAt: now };
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
    assert.deepEqual(await second.sessions.byId(session.id), session);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
