import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId, asTaskId, type SessionId, type TaskId } from '../ids.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { inMemoryDeliveries, inMemoryDeps, type InMemoryWorld } from '../testing/in-memory.ts';
import type { TaskGate } from '../ports/task-gate.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase, forkSessionUseCase } from './sessions.ts';
import { promptSessionUseCase } from './conversation.ts';
import { ensureHosted } from './hosting.ts';
import { startSessionUseCase } from './start-session.ts';
import { pumpDeliveries } from './delivery.ts';
import { createRewindService } from './rewind.ts';
import { continueElsewhereUseCase } from './continue-elsewhere.ts';
import type { Task } from '../task.ts';
import type { Project } from '../project.ts';

const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available }),
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

/**
 * 非等待的门禁：共享进入可嵌套，独占只在不被持有时成功。
 * 和 apps/server/src/task-gate.ts 语义一致，额外记录进入次数与最大并发，供测试断言。
 */
function recordingGate(): {
  gate: TaskGate;
  enters: () => number;
  max: () => number;
  held: (taskId: TaskId) => number;
} {
  const holders = new Map<TaskId, number>();
  let enters = 0;
  let max = 0;
  return {
    gate: {
      enter(taskId) {
        enters += 1;
        const current = holders.get(taskId) ?? 0;
        if (current < 0) return null;
        const next = current + 1;
        holders.set(taskId, next);
        max = Math.max(max, next);
        let left = false;
        return () => {
          if (left) return;
          left = true;
          const count = holders.get(taskId) ?? 0;
          if (count <= 1) holders.delete(taskId);
          else holders.set(taskId, count - 1);
        };
      },
      exclusive(taskId) {
        if ((holders.get(taskId) ?? 0) !== 0) return null;
        holders.set(taskId, -1);
        let left = false;
        return () => {
          if (left) return;
          left = true;
          holders.delete(taskId);
        };
      }
    },
    enters: () => enters,
    max: () => max,
    held: (taskId) => holders.get(taskId) ?? 0
  };
}

async function projectAndTask(gate?: TaskGate): Promise<{ w: InMemoryWorld; project: Project; task: Task }> {
  const w = inMemoryDeps(gate ? { taskGate: gate } : {});
  w.agents.push(fake);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/task-admission-demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  return { w, project: project.value, task: task.value };
}

async function derived(gate?: TaskGate): Promise<{ w: InMemoryWorld; project: Project; task: Task; sid: SessionId }> {
  const base = await projectAndTask(gate);
  const session = await deriveSessionUseCase(base.w.deps, { taskId: base.task.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  return { ...base, sid: session.value.id };
}

async function archive(w: InMemoryWorld, task: Task): Promise<void> {
  assert.equal(await w.deps.tasks.setArchived(task.id, 42, null), true);
}

function promptDispatches(w: InMemoryWorld): number {
  return w.dispatched.filter((command) => command.kind === 'prompt').length;
}

test('归档任务：派生在写会话和派发之前被拒，锁已释放', async () => {
  const g = recordingGate();
  const { w, task } = await projectAndTask(g.gate);
  await archive(w, task);

  const out = await deriveSessionUseCase(w.deps, { taskId: task.id, agentId: 'fake', model: 'm1' });

  assert.ok(!out.ok);
  assert.equal(out.error.code, 'conflict');
  assert.match(out.error.message, /归档/);
  assert.deepEqual(await w.deps.sessions.listByTask(task.id), []);
  assert.equal(w.dispatched.length, 0);
  assert.equal(g.held(task.id), 0);
});

test('任务不存在：派生返回 not_found，不写会话', async () => {
  const g = recordingGate();
  const { w } = await projectAndTask(g.gate);
  const missing = asTaskId('missing-task');

  const out = await deriveSessionUseCase(w.deps, { taskId: missing, agentId: 'fake', model: 'm1' });

  assert.ok(!out.ok);
  assert.equal(out.error.code, 'not_found');
  assert.equal(w.dispatched.length, 0);
  assert.equal(g.held(missing), 0);
});

test('确定性交错：派生持共享锁写完会话前归档拿不到独占权，放行后才可归档', async () => {
  const g = recordingGate();
  const { w, task } = await projectAndTask(g.gate);
  const realSave = w.deps.sessions.save;
  let saveEntered!: () => void;
  const entered = new Promise<void>((resolve) => (saveEntered = resolve));
  let releaseSave!: () => void;
  const blocked = new Promise<void>((resolve) => (releaseSave = resolve));
  let firstSave = true;
  w.deps.sessions.save = async (session) => {
    if (firstSave && session.taskId === task.id) {
      firstSave = false;
      saveEntered();
      await blocked;
    }
    return realSave(session);
  };

  const running = deriveSessionUseCase(w.deps, { taskId: task.id, agentId: 'fake', model: 'm1' });
  await entered;

  assert.equal(g.held(task.id), 1);
  assert.equal(g.gate.exclusive(task.id), null, '还有共享持有者时归档必须拿不到独占权');

  releaseSave();
  const out = await running;
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(w.dispatched.filter((command) => command.kind === 'start_session').length, 1);
  const saved = (await w.deps.sessions.listByTask(task.id))[0];
  assert.ok(saved, '派生应当落了一条会话');
  assert.equal(g.held(task.id), 0);
  assert.ok(g.max() >= 2, '派生内部调用启动漏斗时共享锁应当可嵌套');

  const archiveLease = g.gate.exclusive(task.id);
  assert.ok(archiveLease);
  archiveLease();
});

test('确定性交错：归档已持独占权时派生返回可重试冲突，不写会话', async () => {
  const g = recordingGate();
  const { w, task } = await projectAndTask(g.gate);
  const archiveLease = g.gate.exclusive(task.id);
  assert.ok(archiveLease);

  const out = await deriveSessionUseCase(w.deps, { taskId: task.id, agentId: 'fake', model: 'm1' });

  assert.ok(!out.ok);
  assert.equal(out.error.code, 'conflict');
  assert.match(out.error.message, /正在归档或恢复/);
  assert.deepEqual(await w.deps.sessions.listByTask(task.id), []);
  assert.equal(w.dispatched.length, 0);

  archiveLease();
  const after = await deriveSessionUseCase(w.deps, { taskId: task.id, agentId: 'fake', model: 'm1' });
  assert.ok(after.ok, JSON.stringify(after));
});

test('没有任务的容器会话不经过门禁', async () => {
  const g = recordingGate();
  const { w, project } = await projectAndTask(g.gate);

  const out = await deriveSessionUseCase(w.deps, { projectId: project.id, agentId: 'fake', model: 'm1' });

  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(g.enters(), 0);
  assert.equal(w.dispatched.filter((command) => command.kind === 'start_session').length, 1);
});

test('启动漏斗：归档后不派发 start_session，也不登记托管', async () => {
  const g = recordingGate();
  const { w, task, sid } = await derived(g.gate);
  const session = await w.deps.sessions.byId(sid);
  assert.ok(session);
  assert.ok(session.workerId);
  w.deps.hosting.drop(sid);
  await archive(w, task);
  const before = w.dispatched.length;

  const out = await startSessionUseCase(w.deps, { session: { ...session, workerId: session.workerId }, workspaceRoot: '/tmp/task-admission-demo', resume: null });

  assert.ok(!out.ok);
  assert.equal(out.error.code, 'conflict');
  assert.equal(w.dispatched.length, before);
  assert.equal(w.deps.hosting.has(sid), false);
  assert.equal(g.held(task.id), 0);
});

test('托管恢复：归档后不 drop 已托管进程，也不再派发', async () => {
  const g = recordingGate();
  const { w, task, sid } = await derived(g.gate);
  const session = await w.deps.sessions.byId(sid);
  assert.ok(session);
  assert.equal(w.deps.hosting.has(sid), true);
  await archive(w, task);
  const before = w.dispatched.length;

  const out = await ensureHosted(w.deps, session);

  assert.ok(!out.ok);
  assert.equal(out.error.code, 'conflict');
  assert.equal(w.deps.hosting.has(sid), true);
  assert.equal(w.dispatched.length, before);
  assert.equal(g.held(task.id), 0);
});

test('问话：归档后不写 journal、不派发 prompt', async () => {
  const g = recordingGate();
  const { w, task, sid } = await derived(g.gate);
  await archive(w, task);
  const beforeEvents = (await w.deps.sessions.eventsAfter(sid, 0 as never)).length;
  const beforePrompts = promptDispatches(w);

  const out = await promptSessionUseCase(w.deps, { sessionId: sid, text: '还做吗' });

  assert.ok(!out.ok);
  assert.equal(out.error.code, 'conflict');
  assert.equal((await w.deps.sessions.eventsAfter(sid, 0 as never)).length, beforeEvents);
  assert.equal(promptDispatches(w), beforePrompts);
  assert.equal(g.held(task.id), 0);
});

test('分叉：归档后不写新会话', async () => {
  const g = recordingGate();
  const { w, task, sid } = await derived(g.gate);
  const source = await w.deps.sessions.byId(sid);
  assert.ok(source);
  await w.deps.sessions.save({ ...source, lastSeq: 1 });
  await archive(w, task);
  const before = (await w.deps.sessions.listByTask(task.id)).length;

  const out = await forkSessionUseCase(w.deps, { sessionId: sid, agentId: 'fake', model: 'm1' });

  assert.ok(!out.ok);
  assert.equal(out.error.code, 'conflict');
  assert.equal((await w.deps.sessions.listByTask(task.id)).length, before);
  assert.equal(g.held(task.id), 0);
});

test('从这里重来：归档后不写新会话、不派发', async () => {
  const g = recordingGate();
  const { w, task, sid } = await derived(g.gate);
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: sid, text: '第一问' })).ok);
  const prompt = (await w.deps.sessions.eventsAfter(sid, 0 as never)).find((entry) => entry.event.kind === 'prompt');
  assert.ok(prompt);
  const service = createRewindService({
    ...w.deps,
    files: null as never,
    turnRefs: { record: async () => undefined, list: async () => new Map<number, string>() }
  });
  await archive(w, task);
  const before = (await w.deps.sessions.listByTask(task.id)).length;
  const beforeDispatch = w.dispatched.length;

  const out = await service.rewind(null, sid, prompt.seq, false);

  assert.ok(!out.ok);
  assert.equal(out.error.code, 'conflict');
  assert.equal((await w.deps.sessions.listByTask(task.id)).length, before);
  assert.equal(w.dispatched.length, beforeDispatch);
  assert.equal(g.held(task.id), 0);
});

test('换个地方继续：归档后不写新会话、不派发', async () => {
  const g = recordingGate();
  const { w, task, sid } = await derived(g.gate);
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: sid, text: '第一问' })).ok);
  await archive(w, task);
  const before = (await w.deps.sessions.listByTask(task.id)).length;
  const beforeDispatch = w.dispatched.length;

  const out = await continueElsewhereUseCase(w.deps, {
    sessionId: sid,
    target: { kind: 'temporary', workerId: 'local' },
    home: '/tmp'
  });

  assert.ok(!out.ok);
  assert.equal(out.error.code, 'conflict');
  assert.equal((await w.deps.sessions.listByTask(task.id)).length, before);
  assert.equal(w.dispatched.length, beforeDispatch);
  assert.equal(g.held(task.id), 0);
});

test('送达泵：归档后不认领、不派发，消息仍排队', async () => {
  const g = recordingGate();
  const deliveries = inMemoryDeliveries();
  const w = inMemoryDeps({ taskGate: g.gate, deliveries });
  w.agents.push(fake);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/task-admission-demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  const sid = session.value.id;
  await deliveries.claimPrompt({
    id: 'delivery-1',
    sessionId: sid,
    seq: 0,
    kind: 'prompt',
    payload: { text: '排队的话', parts: [] },
    state: 'queued',
    attempt: 0,
    nextAt: w.deps.now(),
    lastError: null,
    createdAt: w.deps.now(),
    updatedAt: w.deps.now()
  });
  await archive(w, task.value);
  const beforePrompts = promptDispatches(w);

  const pumped = await pumpDeliveries({ ...w.deps, deliveries });

  assert.equal(pumped, 1);
  assert.equal(promptDispatches(w), beforePrompts);
  const row = await deliveries.byId('delivery-1');
  assert.equal(row?.state, 'queued');
  assert.equal(g.held(task.value.id), 0);
});

test('动作抛错也会释放共享锁，之后可正常执行', async () => {
  const g = recordingGate();
  const { w, task } = await projectAndTask(g.gate);
  const realSave = w.deps.sessions.save;
  let fail = true;
  w.deps.sessions.save = async (session) => {
    if (fail && session.taskId === task.id) throw new Error('save boom');
    return realSave(session);
  };

  await assert.rejects(deriveSessionUseCase(w.deps, { taskId: task.id, agentId: 'fake', model: 'm1' }), /save boom/);
  assert.equal(g.held(task.id), 0);

  fail = false;
  const out = await deriveSessionUseCase(w.deps, { taskId: task.id, agentId: 'fake', model: 'm1' });
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(g.held(task.id), 0);
});
