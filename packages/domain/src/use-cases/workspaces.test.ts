import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase, setProjectRepoUseCase } from './projects.ts';
import { parseRepo } from '../project.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { freeName, prepareLongLivedWorkspaceUseCase, workspaceViewsUseCase } from './workspaces.ts';

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
  models: [],
  defaultModel: '',
  options: []
};

async function folderless() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  w.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const project = await createProjectUseCase(w.deps, { name: 'Demo App' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '修登录' });
  assert.ok(task.ok);
  return { ...w, project: project.value, task: task.value };
}

test('新建项目可以不选目录：没有工作空间，派生时要求先选', async () => {
  const w = await folderless();
  assert.equal(w.project.rootPath, '');
  assert.equal((await w.deps.workspaces.byProject(w.project.id)).length, 0);
  const derived = await deriveSessionUseCase(w.deps, { taskId: w.task.id, agentId: 'fake', model: '' });
  assert.equal(derived.ok, false);
});

test('给了目录的新项目：目录登记成第一个持久工作空间（linked）', async () => {
  const w = inMemoryDeps();
  const project = await createProjectUseCase(w.deps, { name: 'x', rootPath: '/tmp/x' });
  assert.ok(project.ok);
  const [workspace] = await w.deps.workspaces.byProject(project.value.id);
  assert.equal(workspace?.path, '/tmp/x');
  assert.equal(workspace?.source, 'linked');
  assert.equal(workspace?.kind, 'long_lived');
});

test('新建持久工作空间：托管目录 <root>/agent-hub/<slug>，被占就 -2；再选已有目录是 linked', async () => {
  const w = await folderless();
  const created = await prepareLongLivedWorkspaceUseCase(w.deps, {
    projectId: w.project.id,
    workerId: 'remote-1',
    plan: { mode: 'create' },
    home: '/home/me'
  });
  assert.ok(created.ok);
  assert.equal(created.value.path, '/srv/work/agent-hub/demo-app');
  assert.equal(created.value.workerId, 'remote-1');
  assert.equal(created.value.source, 'created');

  // 本机：fakeFs 的目录列表里总有一个 demo → 名字被占
  const project2 = await createProjectUseCase(w.deps, { name: 'demo' });
  assert.ok(project2.ok);
  const local = await prepareLongLivedWorkspaceUseCase(w.deps, {
    projectId: project2.value.id,
    workerId: 'local',
    plan: { mode: 'create' },
    home: '/home/me'
  });
  assert.ok(local.ok);
  assert.equal(local.value.workerId, null, '本机 Worker 折叠成 null（和 Server 同机）');
  assert.equal(local.value.path, '/home/me/agent-hub/demo-2');

  const linked = await prepareLongLivedWorkspaceUseCase(w.deps, {
    projectId: w.project.id,
    workerId: 'remote-1',
    plan: { mode: 'link', path: '/srv/work/existing/' },
    home: '/home/me'
  });
  assert.ok(linked.ok);
  assert.equal(linked.value.source, 'linked');
  assert.equal(linked.value.path, '/srv/work/existing');
  const again = await prepareLongLivedWorkspaceUseCase(w.deps, {
    projectId: w.project.id,
    workerId: 'remote-1',
    plan: { mode: 'link', path: '/srv/work/existing' },
    home: '/home/me'
  });
  assert.ok(again.ok);
  assert.equal(again.value.id, linked.value.id, '同一目录再关联一次返回原来那条');
});

test('派生到选定的工作空间：会话跟着它去那台机器、那个目录；列表带上正在跑的任务', async () => {
  const w = await folderless();
  const workspace = await prepareLongLivedWorkspaceUseCase(w.deps, {
    projectId: w.project.id,
    workerId: 'remote-1',
    plan: { mode: 'create' },
    home: '/home/me'
  });
  assert.ok(workspace.ok);
  const session = await deriveSessionUseCase(w.deps, {
    taskId: w.task.id,
    agentId: 'fake',
    model: '',
    workspaceId: workspace.value.id
  });
  assert.ok(session.ok, session.ok ? '' : session.error.message);
  assert.equal(session.value.workerId, 'remote-1');
  assert.equal(session.value.workspaceId, workspace.value.id);
  const start = w.dispatched.at(-1);
  assert.equal(start?.kind === 'start_session' && start.workspaceRoot, '/srv/work/agent-hub/demo-app');

  const views = await workspaceViewsUseCase(w.deps, w.project.id);
  assert.ok(views.ok);
  assert.deepEqual(views.value[0]?.runningTaskIds, [w.task.id]);
});

test('派生：别的项目的工作空间不认', async () => {
  const w = await folderless();
  const other = await createProjectUseCase(w.deps, { name: 'other', rootPath: '/tmp/other' });
  assert.ok(other.ok);
  const [foreign] = await w.deps.workspaces.byProject(other.value.id);
  assert.ok(foreign);
  const derived = await deriveSessionUseCase(w.deps, { taskId: w.task.id, agentId: 'fake', model: '', workspaceId: foreign.id });
  assert.equal(derived.ok, false);
});

test('托管目录名冲突：slug、slug-2、slug-3', () => {
  assert.equal(freeName('a', new Set()), 'a');
  assert.equal(freeName('a', new Set(['a', 'a-2'])), 'a-3');
});

test('项目带仓库：新建持久工作空间在那台机器上 clone，来源 cloned；关联已有目录会读出分支', async () => {
  const w = inMemoryDeps();
  w.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const project = await createProjectUseCase(w.deps, { name: 'Demo App', repoUrl: 'git@github.com:me/demo.git', defaultBranch: 'main' });
  assert.ok(project.ok);
  assert.deepEqual(project.value.repo, { url: 'git@github.com:me/demo.git', defaultBranch: 'main' });
  const cloned = await prepareLongLivedWorkspaceUseCase(w.deps, {
    projectId: project.value.id,
    workerId: 'remote-1',
    plan: { mode: 'create' },
    home: '/home/me'
  });
  assert.ok(cloned.ok, cloned.ok ? '' : cloned.error.message);
  assert.equal(cloned.value.source, 'cloned');
  assert.ok(w.git.calls.includes('remote-1:clone:git@github.com:me/demo.git->/srv/work/agent-hub/demo-app'));

  w.git.repos.add('/srv/work/old');
  const linked = await prepareLongLivedWorkspaceUseCase(w.deps, {
    projectId: project.value.id,
    workerId: 'remote-1',
    plan: { mode: 'link', path: '/srv/work/old' },
    home: '/home/me'
  });
  assert.ok(linked.ok);
  assert.equal(linked.value.isGit, true);
  assert.equal(linked.value.branch, 'main');
});

test('clone 失败：不登记工作空间，把原因带回去', async () => {
  const w = inMemoryDeps();
  w.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const project = await createProjectUseCase(w.deps, { name: 'x', repoUrl: 'https://example.com/x.git' });
  assert.ok(project.ok);
  w.git.failNext = '没有权限';
  const result = await prepareLongLivedWorkspaceUseCase(w.deps, {
    projectId: project.value.id,
    workerId: 'remote-1',
    plan: { mode: 'create' },
    home: '/home/me'
  });
  assert.equal(result.ok, false);
  assert.equal((await w.deps.workspaces.byProject(project.value.id)).length, 0);
});

test('仓库地址校验；改仓库可以清空', async () => {
  assert.equal(parseRepo('not a url').ok, false);
  assert.equal(parseRepo('https://x/y.git', 'bad branch').ok, false);
  const none = parseRepo('  ');
  assert.ok(none.ok);
  assert.equal(none.value, null);
  const w = inMemoryDeps();
  const project = await createProjectUseCase(w.deps, { name: 'x' });
  assert.ok(project.ok);
  const set = await setProjectRepoUseCase(w.deps, { projectId: project.value.id, repoUrl: 'https://x/y.git' });
  assert.ok(set.ok);
  assert.equal((await w.deps.projects.byId(project.value.id))?.repo?.url, 'https://x/y.git');
  const cleared = await setProjectRepoUseCase(w.deps, { projectId: project.value.id, repoUrl: null });
  assert.ok(cleared.ok);
  assert.equal(cleared.value.repo, null);
});
