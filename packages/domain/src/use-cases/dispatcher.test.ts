import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asProjectId, asTaskId } from '../ids.ts';
import type { TaskGate } from '../ports/task-gate.ts';
import type { AgentTaskRequest } from '../ports/agent-task-store.ts';
import type { TaskDispatch, TaskDispatchStore } from '../ports/task-dispatch-store.ts';
import { ok, type Result } from '../result.ts';
import type { DomainError } from '../errors.ts';
import { createTask } from '../task.ts';
import { fakeTasks } from '../testing/fakes/repos.ts';
import { createDispatcher, type DispatcherDeps } from './dispatcher.ts';

function fakeStore(): TaskDispatchStore & { readonly rows: Map<string, TaskDispatch> } {
  const rows = new Map<string, TaskDispatch>();
  return {
    rows,
    async insert(d) {
      const same = [...rows.values()].find((row) => row.taskId === d.taskId);
      if (same) return same;
      rows.set(d.id, d);
      return d;
    },
    async save(d) {
      rows.set(d.id, d);
    },
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async bySession(sessionId) {
      return [...rows.values()].find((row) => row.sessionId === sessionId) ?? null;
    },
    async active() {
      return [...rows.values()].filter((row) => row.state === 'queued' || row.state === 'running');
    },
    async unnotified() {
      return [...rows.values()].filter((row) => row.state !== 'queued' && row.state !== 'running' && !row.notified);
    },
    async recent(accountId) {
      return [...rows.values()].filter((row) => row.accountId === accountId).sort((a, b) => b.createdAt - a.createdAt);
    },
    async byTaskIds(taskIds) {
      return [...rows.values()].filter((row) => taskIds.includes(row.taskId));
    }
  };
}

function request(taskId: string): AgentTaskRequest {
  return {
    id: `r-${taskId}`,
    taskId,
    accountId: 'u1',
    agent: 'boss',
    sessionId: 'bot',
    projectId: asProjectId('p1'),
    title: '任务',
    goal: 'g',
    originConnector: null,
    originExternalId: null,
    wakeKey: 'run1',
    counted: true,
    approval: 'none',
    createdAt: 1,
    updatedAt: 1
  };
}

interface World {
  readonly tasks: ReturnType<typeof fakeTasks>;
  readonly store: ReturnType<typeof fakeStore>;
  readonly started: string[];
  readonly logs: string[];
  readonly dispatcher: ReturnType<typeof createDispatcher>;
}

async function world(taskGate?: TaskGate): Promise<World> {
  const tasks = fakeTasks();
  const created = createTask({ projectId: asProjectId('p1'), title: '任务', now: 1 });
  assert.ok(created.ok);
  await tasks.save(created.value);
  const store = fakeStore();
  const started: string[] = [];
  const logs: string[] = [];
  let clock = 100;
  const deps: DispatcherDeps = {
    now: () => ++clock,
    store,
    tasks,
    ...(taskGate ? { taskGate } : {}),
    placement: async () => ({ workerId: 'w1', online: true }),
    start: async (d): Promise<Result<{ sessionId: string; workerId: string | null }, DomainError>> => {
      started.push(d.taskId);
      return ok({ sessionId: `s-${d.taskId}`, workerId: 'w1' });
    },
    sessionState: async () => null,
    busy: async () => false,
    notify: async () => ok(undefined),
    abandonTask: async () => undefined,
    log: (line) => void logs.push(line)
  };
  return { tasks, store, started, logs, dispatcher: createDispatcher(deps) };
}

test('调度：任务归档后不再入队', async () => {
  const w = await world();
  const taskId = asTaskId([...w.tasks.rows.keys()][0]!);
  assert.equal(await w.tasks.setArchived(taskId, 50, null), true);

  const queued = await w.dispatcher.enqueue(request(taskId), { agentId: 'pi', model: 'm' });

  assert.equal(queued, null);
  assert.equal(w.store.rows.size, 0);
  assert.match(w.logs.at(-1) ?? '', /已归档/);
});

test('调度：入队后归档，领取时拒绝启动且不留下 running', async () => {
  const w = await world();
  const taskId = asTaskId([...w.tasks.rows.keys()][0]!);
  assert.ok(await w.dispatcher.enqueue(request(taskId), { agentId: 'pi', model: 'm' }));

  assert.equal(await w.tasks.setArchived(taskId, 50, null), true);
  await w.dispatcher.tick();

  assert.deepEqual(w.started, []);
  const row = [...w.store.rows.values()][0]!;
  assert.equal(row.state, 'failed');
  assert.equal(row.sessionId, null);
  assert.equal(row.startedAt, null);
  assert.match(row.result ?? '', /归档/);
});

test('调度：独占归档锁期间入队失败，锁释放后可以入队', async () => {
  let holding = false;
  const gate: TaskGate = {
    enter() {
      return holding ? null : () => undefined;
    },
    exclusive() {
      return null;
    }
  };
  const w = await world(gate);
  const taskId = asTaskId([...w.tasks.rows.keys()][0]!);

  holding = true;
  assert.equal(await w.dispatcher.enqueue(request(taskId), { agentId: 'pi', model: 'm' }), null);
  assert.equal(w.store.rows.size, 0);

  holding = false;
  assert.ok(await w.dispatcher.enqueue(request(taskId), { agentId: 'pi', model: 'm' }));
  assert.equal(w.store.rows.size, 1);
});
