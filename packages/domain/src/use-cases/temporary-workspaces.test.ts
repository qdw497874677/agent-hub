import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { prepareLongLivedWorkspaceUseCase } from './workspaces.ts';
import { branchSlug, prepareTemporaryWorkspaceUseCase, taskBranch } from './temporary-workspaces.ts';

async function world(repoUrl?: string) {
  const w = inMemoryDeps();
  w.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const project = await createProjectUseCase(w.deps, { name: 'Demo App', ...(repoUrl ? { repoUrl } : {}) });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'Fix login 登录' });
  assert.ok(task.ok);
  const temp = () =>
    prepareTemporaryWorkspaceUseCase(w.deps, { projectId: project.value.id, taskId: task.value.id, workerId: 'remote-1', home: '/home/me' });
  return { ...w, project: project.value, task: task.value, temp };
}

test('分支名：agent-hub/<ascii slug>-<短 id>；纯中文标题退回 task', () => {
  assert.equal(branchSlug('Fix login 登录'), 'fix-login');
  assert.equal(branchSlug('修登录'), 'task');
  assert.equal(taskBranch('修登录', 'ab12'), 'agent-hub/task-ab12');
});

test('git 项目：从这台机器上的持久工作空间开 worktree，放在仓库旁的 .worktrees/，新分支', async () => {
  const w = await world('https://example.com/demo.git');
  const long = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'remote-1', plan: { mode: 'create' }, home: '/home/me' });
  assert.ok(long.ok);
  const made = await w.temp();
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.equal(made.value.kind, 'temporary');
  assert.equal(made.value.source, 'worktree');
  assert.equal(made.value.ownerTaskId, w.task.id);
  assert.equal(made.value.baseWorkspaceId, long.value.id);
  assert.match(made.value.branch ?? '', /^agent-hub\/fix-login-[0-9a-f]{4}$/);
  assert.match(made.value.path, /^\/srv\/work\/agent-hub-workspaces\/\.worktrees\/demo-app\/fix-login-[0-9a-f]{4}$/);
  assert.ok(w.git.calls.some((call) => call.startsWith('remote-1:worktree:/srv/work/agent-hub-workspaces/demo-app->')));
  // 不限数量：再开一个，分支不同
  const again = await w.temp();
  assert.ok(again.ok);
  assert.notEqual(again.value.branch, made.value.branch);
});

test('有仓库但这台机器上还没下载：先 clone 一个持久的，再开 worktree', async () => {
  const w = await world('https://example.com/demo.git');
  const made = await w.temp();
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.equal(made.value.source, 'worktree');
  const all = await w.deps.workspaces.byProject(w.project.id);
  assert.equal(all.filter((ws) => ws.kind === 'long_lived' && ws.source === 'cloned').length, 1);
});

test('非 git 项目：新建空目录 <root>/agent-hub-workspaces/.tmp/<slug>-<短 id>', async () => {
  const w = await world();
  const made = await w.temp();
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.equal(made.value.source, 'created');
  assert.equal(made.value.isGit, false);
  assert.equal(made.value.branch, null);
  assert.match(made.value.path, /^\/srv\/work\/agent-hub-workspaces\/\.tmp\/fix-login-[0-9a-f]{4}$/);
});

test('worktree 失败（同名分支已在别处检出等）：不登记，原因带回去', async () => {
  const w = await world('https://example.com/demo.git');
  const long = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'remote-1', plan: { mode: 'create' }, home: '/home/me' });
  assert.ok(long.ok);
  w.git.failNext = '分支已存在';
  const made = await w.temp();
  assert.equal(made.ok, false);
  assert.equal((await w.deps.workspaces.byTask(w.task.id)).length, 0);
});

test('一个目录只属于一个项目：别的项目登记过的目录、它的上下级都不能再关联', async () => {
  const w = await world();
  const other = await createProjectUseCase(w.deps, { name: 'other' });
  assert.ok(other.ok);
  const link = (projectId: string, path: string) =>
    prepareLongLivedWorkspaceUseCase(w.deps, { projectId, workerId: 'remote-1', plan: { mode: 'link', path }, home: '/home/me' });
  assert.ok((await link(w.project.id, '/srv/work/shared')).ok);
  for (const path of ['/srv/work/shared', '/srv/work/shared/sub', '/srv/work']) {
    const result = await link(other.value.id, path);
    assert.equal(result.ok, false, path);
    if (!result.ok) assert.match(result.error.message, /已经属于项目「Demo App」/);
  }
  assert.ok((await link(other.value.id, '/srv/work/elsewhere')).ok, '兄弟目录没问题');
  assert.ok((await link(w.project.id, '/srv/work/shared/sub')).ok, '同一项目的不算');
  // 建项目时直接给目录也查
  const third = await createProjectUseCase(w.deps, { name: 'third', rootPath: '/tmp/x' });
  assert.ok(third.ok);
  const fourth = await createProjectUseCase(w.deps, { name: 'fourth', rootPath: '/tmp/x' });
  assert.equal(fourth.ok, false);
});
