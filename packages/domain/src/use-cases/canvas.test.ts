import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { deriveSession } from '../session.ts';
import { newWorkspace } from '../workspace.ts';
import { inMemoryDeps, fakeSessionLinks } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase, recordEvent } from './sessions.ts';
import { linkSessionsUseCase, loadCanvas, unlinkSessionsUseCase } from './canvas.ts';

const agent: AgentDescriptor = {
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

test('画布：第一句话留在 openings，最近 24 条预览装不下它也还在', async () => {
  const w = inMemoryDeps();
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '同名任务' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  await recordEvent(w.deps, { sessionId: session.value.id, event: { kind: 'prompt', text: '第一条会话：看看日志' } });
  for (let i = 0; i < 30; i++) await recordEvent(w.deps, { sessionId: session.value.id, event: { kind: 'tool_call', name: 'bash', input: String(i) } });
  const canvas = await loadCanvas(w.deps, project.value.id);
  assert.ok(canvas.ok);
  assert.equal(canvas.value.openings[session.value.id], '第一条会话：看看日志');
  assert.equal(canvas.value.previews[session.value.id]?.some((entry) => entry.event.kind === 'prompt'), false);
  assert.equal(canvas.value.previews[session.value.id]?.length, 24);
});

test('画布：会话连线是无向边，断开后消失', async () => {
  const w = inMemoryDeps({ links: fakeSessionLinks() });
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'links', rootPath: '/tmp/links' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '连线' });
  assert.ok(task.ok);
  const one = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  const other = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(one.ok && other.ok);

  const linked = await linkSessionsUseCase(w.deps, project.value.id, one.value.id, other.value.id, 'alice');
  assert.ok(linked.ok);
  // 反向再连一次：同一份无向关系，不新增第二行
  const again = await linkSessionsUseCase(w.deps, project.value.id, other.value.id, one.value.id, 'bob');
  assert.ok(again.ok);

  const canvas = await loadCanvas(w.deps, project.value.id);
  assert.ok(canvas.ok);
  const links = canvas.value.edges.filter((edge) => edge.kind === 'link');
  assert.equal(links.length, 1);
  const link = links[0];
  assert.ok(link?.kind === 'link');
  assert.deepEqual(
    [link.aSessionId, link.bSessionId].sort(),
    [one.value.id, other.value.id].sort()
  );

  const removed = await unlinkSessionsUseCase(w.deps, project.value.id, other.value.id, one.value.id);
  assert.ok(removed.ok);
  const after = await loadCanvas(w.deps, project.value.id);
  assert.ok(after.ok);
  assert.equal(after.value.edges.some((edge) => edge.kind === 'link'), false);
});

test('画布：机器不在线时不能建立新连接', async () => {
  const w = inMemoryDeps({
    links: fakeSessionLinks(),
    workerPresence: { online: async () => false }
  });
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'offline', rootPath: '/tmp/offline' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '离线' });
  assert.ok(task.ok);
  const one = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  const other = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(one.ok && other.ok);

  const linked = await linkSessionsUseCase(w.deps, project.value.id, one.value.id, other.value.id, 'alice');
  assert.equal(linked.ok, false);
  if (!linked.ok) assert.match(linked.error.message, /不在线/);
});

test('画布：不能连接自己，也不能连接别的项目的会话', async () => {
  const w = inMemoryDeps({ links: fakeSessionLinks() });
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'links', rootPath: '/tmp/links' });
  const otherProject = await createProjectUseCase(w.deps, { name: 'other', rootPath: '/tmp/other' });
  assert.ok(project.ok && otherProject.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'a' });
  const foreign = await createTaskUseCase(w.deps, { projectId: otherProject.value.id, title: 'b' });
  assert.ok(task.ok && foreign.ok);
  const one = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  const two = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  const away = await deriveSessionUseCase(w.deps, { taskId: foreign.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(one.ok && two.ok && away.ok);

  assert.equal((await linkSessionsUseCase(w.deps, project.value.id, one.value.id, one.value.id, 'alice')).ok, false);
  assert.equal((await linkSessionsUseCase(w.deps, project.value.id, one.value.id, away.value.id, 'alice')).ok, false);
  assert.equal((await linkSessionsUseCase(w.deps, project.value.id, one.value.id, two.value.id, 'alice')).ok, true);
});

test('#243：连线按不可变来源项目判；容器会话有来源可连，旧容器失败关闭', async () => {
  const w = inMemoryDeps({ links: fakeSessionLinks() });
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'origin-links', rootPath: '/tmp/origin-links' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '连线' });
  assert.ok(task.ok);
  const taskSession = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(taskSession.ok);
  // 长期工作空间可以没有 projectId：来源只认会话自己落定的 originProjectId。
  const ws = newWorkspace({ projectId: null, workerId: 'local', path: '/tmp/origin-links-unowned', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(ws.ok);
  await w.deps.workspaces.save(ws.value);
  const input = { agentId: asAgentId('fake'), model: 'm1', now: 1, workspaceId: ws.value.id };
  const origin = deriveSession({ ...input, originProjectId: project.value.id });
  const legacy = deriveSession(input);
  assert.ok(origin.ok && legacy.ok);
  await w.deps.sessions.save(origin.value);
  await w.deps.sessions.save(legacy.value);

  const linked = await linkSessionsUseCase(w.deps, project.value.id, taskSession.value.id, origin.value.id, 'alice');
  assert.ok(linked.ok, linked.ok ? '' : linked.error.message);
  const denied = await linkSessionsUseCase(w.deps, project.value.id, taskSession.value.id, legacy.value.id, 'alice');
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, 'not_found');
});
