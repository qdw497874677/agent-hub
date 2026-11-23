import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { deriveSession } from '../session.ts';
import { newWorkspace } from '../workspace.ts';
import { inMemoryDeps, fakeSessionLinks } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { linkSessionsUseCase, unlinkSessionsUseCase } from './session-links.ts';

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

async function twoSessions() {
  const links = fakeSessionLinks();
  const w = inMemoryDeps({ links });
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'links', rootPath: '/tmp/links' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '连线' });
  assert.ok(task.ok);
  const one = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  const other = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(one.ok && other.ok);
  return { w, links, project: project.value, one: one.value, other: other.value };
}

test('连线：无向幂等，反向再连不新增第二行', async () => {
  const { w, links, project, one, other } = await twoSessions();
  const linked = await linkSessionsUseCase(w.deps, project.id, one.id, other.id, 'alice');
  assert.ok(linked.ok);
  assert.equal(linked.value.aSessionId < linked.value.bSessionId, true, '存的是规范化顺序');
  assert.deepEqual([linked.value.aSessionId, linked.value.bSessionId].sort(), [one.id, other.id].sort());

  const again = await linkSessionsUseCase(w.deps, project.id, other.id, one.id, 'bob');
  assert.ok(again.ok);
  assert.equal(links.rows.size, 1);
});

test('断开：哪个方向都能断，重复断开也成功', async () => {
  const { w, links, project, one, other } = await twoSessions();
  assert.ok((await linkSessionsUseCase(w.deps, project.id, one.id, other.id, 'alice')).ok);

  // 反向断开（规范化顺序对调用方不可见）
  assert.ok((await unlinkSessionsUseCase(w.deps, project.id, other.id, one.id)).ok);
  assert.equal(links.rows.size, 0);

  // 重复断开仍然成功
  assert.ok((await unlinkSessionsUseCase(w.deps, project.id, one.id, other.id)).ok);
  // 反向连接后再正向断开
  assert.ok((await linkSessionsUseCase(w.deps, project.id, other.id, one.id, 'alice')).ok);
  assert.equal(links.rows.size, 1);
  assert.ok((await unlinkSessionsUseCase(w.deps, project.id, one.id, other.id)).ok);
  assert.equal(links.rows.size, 0);
});

test('机器在线状态：两端都不在线 / 当前会话一端 / 对方会话一端', async () => {
  const ws = newWorkspace({ projectId: null, workerId: 'w1', path: '/tmp/offline-links', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(ws.ok);
  const w = inMemoryDeps({
    links: fakeSessionLinks(),
    workerPresence: { online: async (workerId) => workerId === 'w2' }
  });
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'offline-links', rootPath: '/tmp/offline-links' });
  assert.ok(project.ok);
  await w.deps.workspaces.save(ws.value);
  const input = { agentId: asAgentId('fake'), model: 'm1', now: 1, workspaceId: ws.value.id, originProjectId: project.value.id };
  const first = deriveSession({ ...input, workerId: 'w1' });
  const second = deriveSession({ ...input, workerId: 'w2' });
  assert.ok(first.ok && second.ok);
  await w.deps.sessions.save(first.value);
  await w.deps.sessions.save(second.value);

  const deniedCurrent = await linkSessionsUseCase(w.deps, project.value.id, first.value.id, second.value.id, 'alice');
  assert.equal(deniedCurrent.ok, false);
  if (!deniedCurrent.ok) {
    assert.equal(deniedCurrent.error.code, 'conflict');
    assert.match(deniedCurrent.error.message, /当前会话所在的机器不在线/);
  }

  const deniedOther = await linkSessionsUseCase(w.deps, project.value.id, second.value.id, first.value.id, 'alice');
  assert.equal(deniedOther.ok, false);
  if (!deniedOther.ok) assert.match(deniedOther.error.message, /对方会话所在的机器不在线/);

  const offline = { ...w.deps, workerPresence: { online: async () => false } };
  const deniedBoth = await linkSessionsUseCase(offline, project.value.id, first.value.id, second.value.id, 'alice');
  assert.equal(deniedBoth.ok, false);
  if (!deniedBoth.ok) assert.match(deniedBoth.error.message, /都不在线/);
});

test('不能连接自己，也不能连接别的项目的会话', async () => {
  const { w, project, one, other } = await twoSessions();
  const otherProject = await createProjectUseCase(w.deps, { name: 'other', rootPath: '/tmp/other' });
  assert.ok(otherProject.ok);
  const foreign = await createTaskUseCase(w.deps, { projectId: otherProject.value.id, title: 'b' });
  assert.ok(foreign.ok);
  const away = await deriveSessionUseCase(w.deps, { taskId: foreign.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(away.ok);

  const self = await linkSessionsUseCase(w.deps, project.id, one.id, one.id, 'alice');
  assert.equal(self.ok, false);
  if (!self.ok) assert.equal(self.error.code, 'invalid');

  const crossProject = await linkSessionsUseCase(w.deps, project.id, one.id, away.value.id, 'alice');
  assert.equal(crossProject.ok, false);
  if (!crossProject.ok) assert.equal(crossProject.error.code, 'not_found');

  assert.equal((await linkSessionsUseCase(w.deps, project.id, one.id, other.id, 'alice')).ok, true);
});

test('项目或会话不存在时失败，缺连线端口返回 not_implemented', async () => {
  const { w, project, one, other } = await twoSessions();
  const missingProject = await linkSessionsUseCase(w.deps, 'nope', one.id, other.id, 'alice');
  assert.equal(missingProject.ok, false);
  if (!missingProject.ok) assert.equal(missingProject.error.code, 'not_found');

  const missingSession = await linkSessionsUseCase(w.deps, project.id, one.id, 'nope', 'alice');
  assert.equal(missingSession.ok, false);
  if (!missingSession.ok) assert.equal(missingSession.error.code, 'not_found');

  const bare = inMemoryDeps();
  const notImplementedLink = await linkSessionsUseCase(bare.deps, project.id, one.id, other.id, 'alice');
  assert.equal(notImplementedLink.ok, false);
  if (!notImplementedLink.ok) assert.equal(notImplementedLink.error.code, 'not_implemented');
  const notImplementedUnlink = await unlinkSessionsUseCase(bare.deps, project.id, one.id, other.id);
  assert.equal(notImplementedUnlink.ok, false);
  if (!notImplementedUnlink.ok) assert.equal(notImplementedUnlink.error.code, 'not_implemented');
});

test('断开：不能断自己，项目不存在失败，缺端口返回 not_implemented', async () => {
  const { w, project, one } = await twoSessions();
  const self = await unlinkSessionsUseCase(w.deps, project.id, one.id, one.id);
  assert.equal(self.ok, false);
  if (!self.ok) assert.equal(self.error.code, 'invalid');

  const missingProject = await unlinkSessionsUseCase(w.deps, 'nope', one.id, one.id);
  assert.equal(missingProject.ok, false);
  if (!missingProject.ok) assert.equal(missingProject.error.code, 'not_found');

  const bare = inMemoryDeps({ links: undefined });
  const noPort = await unlinkSessionsUseCase(bare.deps, project.id, one.id, one.id);
  assert.equal(noPort.ok, false);
  if (!noPort.ok) assert.equal(noPort.error.code, 'not_implemented');
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
