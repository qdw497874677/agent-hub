import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asAgentId,
  createProject,
  createTask,
  deriveSession,
  recordEvent,
  type Deps
} from '@agent-hub/domain';
import { openSqliteStore } from '@agent-hub/storage-sqlite';
import { createLiveCatalog } from './agent-catalog.ts';
import { createLocalFs } from '@agent-hub/node-gateway';
import { createSessionQueue } from './session-queue.ts';
import { createMemoryHosting } from './session-hosting.ts';
import { createStreamHub } from './stream-hub.ts';

/**
 * 回归测试：并发落盘会把事件丢掉。
 *
 * 这不是理论风险。Pi 的一次回复会以几十条 text delta 推上来，每条都是独立的
 * async 任务；`recordEvent` 读改写同一个 `lastSeq`，两条并发就撞出同一个 seq，
 * journal 的 `INSERT OR IGNORE` 静默丢一条。曾经的表现是：卡片上少一句话，
 * 而 `session_text` 投影里是完整的——两个副本自己打架。
 */
async function seed(deps: Deps, store: ReturnType<typeof openSqliteStore>) {
  const project = createProject({ name: 'demo', rootPath: '/tmp/demo', directoryExists: true, now: 1 });
  assert.ok(project.ok);
  const task = createTask({ projectId: project.value.id, title: '并发落盘', now: 1 });
  assert.ok(task.ok);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: '', now: 1 });
  assert.ok(session.ok);
  await deps.projects.save(project.value);
  await deps.tasks.save(task.value);
  await deps.sessions.save(session.value);
  return { project: project.value, task: task.value, session: session.value, store };
}

function harness() {
  const store = openSqliteStore(':memory:');
  const hub = createStreamHub();
  const deps: Deps = {
    projects: store.projects,
    tasks: store.tasks,
    workLog: store.workLog,
    sessions: store.sessions,
    workspaces: store.workspaces,
    artifacts: store.artifacts,
    layout: store.layout,
    stream: hub.stream,
    gateway: {
      status: async () => [],
      dispatch: async () => ({ ok: true, value: undefined }),
      listDirectories: async () => ({ ok: true, value: { path: '/', exists: false, entries: [] } }),
      makeDirectory: async () => ({ ok: true, value: { path: '/' } }),
      listFiles: async () => ({ ok: true, value: { files: [], truncated: false } }),
      readFile: async () => ({ ok: true, value: null })
    },
    agents: createLiveCatalog(),
    fs: createLocalFs(),
    search: store.search,
    hosting: createMemoryHosting(),
    queue: createSessionQueue(),
    now: () => 1_700_000_000_000
  };
  return { deps, store };
}

const DELTAS = ['E', '2', 'E', '-', 'O', 'K', '-', 'R', 'E', 'A', 'L'];

test('串行队列下，逐条 delta 一条都不丢', async () => {
  const { deps, store } = harness();
  const { session } = await seed(deps, store);
  const queue = createSessionQueue();

  // 模拟网关：一秒内推来十几条，全部不 await（这正是原来的写法）
  await Promise.all(
    DELTAS.map((delta) =>
      queue.run(session.id, async () => {
        const result = await recordEvent(deps, { sessionId: session.id, event: { kind: 'text', delta } });
        assert.ok(result.ok);
      })
    )
  );

  const entries = await deps.sessions.tail(session.id, 100);
  const text = entries
    .filter((entry) => entry.event.kind === 'text')
    .map((entry) => (entry.event.kind === 'text' ? entry.event.delta : ''))
    .join('');
  assert.equal(text, DELTAS.join(''), 'journal 里必须是完整的一句话');
  assert.equal(entries.length, DELTAS.length);

  const reloaded = await deps.sessions.byId(session.id);
  assert.equal(reloaded?.lastSeq, DELTAS.length, '游标也必须跟着走满');
  store.close();
});

test('不排队时确实会丢——这条用例是上面那条的理由', async () => {
  const { deps, store } = harness();
  const { session } = await seed(deps, store);

  await Promise.all(
    DELTAS.map((delta) =>
      recordEvent(deps, { sessionId: session.id, event: { kind: 'text', delta } }).then((result) =>
        assert.ok(result.ok)
      )
    )
  );

  const entries = await deps.sessions.tail(session.id, 100);
  const text = entries
    .filter((entry) => entry.event.kind === 'text')
    .map((entry) => (entry.event.kind === 'text' ? entry.event.delta : ''))
    .join('');
  assert.notEqual(text, DELTAS.join(''), '并发读改写会撞 seq，事件被 INSERT OR IGNORE 静默吞掉');
  store.close();
});
