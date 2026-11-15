import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from './agent.ts';
import { asAgentId } from './ids.ts';
import { deriveSession, isContainerSession } from './session.ts';
import { inMemoryDeps } from './testing/in-memory.ts';
import { promptSessionUseCase } from './use-cases/conversation.ts';
import { createProjectUseCase } from './use-cases/projects.ts';
import { deriveSessionUseCase, forkSessionUseCase } from './use-cases/sessions.ts';
import { startCommand } from './use-cases/start-session.ts';
import { createTaskToolProvider } from './tools/task-tools.ts';
import type { ToolGrant } from './tool.ts';

const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: {
    prompt: { state: 'available' },
    interrupt: { state: 'available' },
    fork: { state: 'available' },
    resume: { state: 'available' },
    tool_calls: { state: 'available' },
    artifacts: { state: 'available' },
    structured_events: { state: 'available' },
    attachments: { state: 'available' }
  },
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

async function world() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const project = await createProjectUseCase(w.deps, { name: 'hub', rootPath: '/tmp/hub' });
  assert.ok(project.ok);
  return { ...w, project: project.value };
}

test('isContainerSession：没有任务的会话才算容器会话', async () => {
  const made = deriveSession({ agentId: asAgentId('fake'), model: 'm1', now: 1 });
  assert.ok(made.ok);
  assert.equal(made.value.taskId, null);
  assert.equal(isContainerSession(made.value), true);
  // 启动命令里的 taskId 跟着会话走（运行时目前不读它）。
  const command = startCommand({ ...made.value, workerId: 'local' }, '/tmp/hub', null);
  assert.equal(command.kind, 'start_session');
  assert.equal(command.taskId, null);
});

test('派生容器会话：只给 projectId 也能建、能跑一轮，不合成假任务', async () => {
  const w = await world();
  const made = await deriveSessionUseCase(w.deps, { projectId: w.project.id, agentId: 'fake', model: 'm1' });
  assert.ok(made.ok, JSON.stringify(made));
  assert.equal(made.value.taskId, null);
  assert.equal(isContainerSession(made.value), true);
  // 不再为它造任务：任务表还是空的。
  assert.equal((await w.deps.tasks.listByProject(w.project.id)).length, 0);
  // 一次都没派发过（deriveSessionUseCase 会先启动会话，这里确认启动命令没带任务）
  const start = w.dispatched.find((c) => c.kind === 'start_session');
  assert.ok(start);
  assert.equal(start.kind === 'start_session' ? start.taskId : 'missing', null);

  const prompted = await promptSessionUseCase(w.deps, { sessionId: made.value.id, text: '在吗' });
  assert.ok(prompted.ok, JSON.stringify(prompted));
  const after = await w.deps.sessions.byId(made.value.id);
  assert.ok(after);
  assert.equal(after.taskId, null);
  assert.ok(after.lastSeq > 0);
});

test('task.* 工具：容器会话被拒，错误话说得清', async () => {
  const w = await world();
  const made = await deriveSessionUseCase(w.deps, { projectId: w.project.id, agentId: 'fake', model: 'm1' });
  assert.ok(made.ok);
  const tools = createTaskToolProvider(w.deps);
  const grant = {
    grant: {
      sessionId: made.value.id,
      taskId: null,
      scopes: ['task:read', 'task:log:write', 'task:status:write'],
      workerId: 'local'
    } as unknown as ToolGrant,
    now: 0
  };
  for (const name of tools.tools().map((tool) => tool.name)) {
    const result = await tools.call(name, {}, grant);
    assert.equal(result.ok, false, name);
    if (!result.ok) {
      assert.equal(result.error.code, 'forbidden', name);
      assert.match(result.error.message, /不属于任何任务/, name);
    }
  }
});

test('容器会话不能分叉，也不开任务日志', async () => {
  const w = await world();
  const made = await deriveSessionUseCase(w.deps, { projectId: w.project.id, agentId: 'fake', model: 'm1' });
  assert.ok(made.ok);
  // 先跑一轮，让分叉点存在（否则会先撞上「还没有内容」）。
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: made.value.id, text: '在吗' })).ok);
  const forked = await forkSessionUseCase(w.deps, { sessionId: made.value.id, agentId: 'fake', model: 'm1' });
  assert.equal(forked.ok, false);
  if (!forked.ok) assert.match(forked.error.message, /容器会话/);
  // 开跑只记系统日志到会话里，不往任何任务日志里写东西。
  const logs = (w.deps.workLog as unknown as { rows: unknown[] }).rows;
  assert.equal(logs.length, 0);
});
