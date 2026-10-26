import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase, setTaskStatusUseCase } from './tasks.ts';
import { prepareLongLivedWorkspaceUseCase } from './workspaces.ts';
import { prepareTemporaryWorkspaceUseCase } from './temporary-workspaces.ts';
import { removeWorkspaceUseCase, sweepTemporaryWorkspacesUseCase, unsavedReason } from './workspace-cleanup.ts';

async function world(repoUrl?: string) {
  const w = inMemoryDeps();
  w.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const project = await createProjectUseCase(w.deps, { name: 'Demo', ...(repoUrl ? { repoUrl } : {}) });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'fix' });
  assert.ok(task.ok);
  const temp = await prepareTemporaryWorkspaceUseCase(w.deps, { projectId: project.value.id, taskId: task.value.id, workerId: 'remote-1', home: '/home/me' });
  assert.ok(temp.ok, temp.ok ? '' : temp.error.message);
  const finish = () => setTaskStatusUseCase(w.deps, task.value.id, 'done', 'user');
  return { ...w, project: project.value, task: task.value, temp: temp.value, finish };
}

test('改动说成人话', () => {
  assert.equal(unsavedReason({ dirty: false, untracked: 0, unpushed: 0, branch: 'x', upstream: null }), null);
  assert.equal(unsavedReason({ dirty: true, untracked: 2, unpushed: 1, branch: 'x', upstream: null }), '有未提交的改动，有 2 个未跟踪的文件，有 1 个提交还没推送或合并');
});

test('任务没结束不清理；结束且干净就删', async () => {
  const w = await world('https://example.com/demo.git');
  assert.equal((await sweepTemporaryWorkspacesUseCase(w.deps)).removed.length, 0);
  await w.finish();
  const report = await sweepTemporaryWorkspacesUseCase(w.deps, { taskId: w.task.id });
  assert.deepEqual(report.removed, [w.temp.id]);
  assert.equal((await w.deps.workspaces.byId(w.temp.id))?.state, 'removed');
});

test('有没推送的提交：不删，标已保留并写明原因；强制删除才删', async () => {
  const w = await world('https://example.com/demo.git');
  w.git.statuses.set(w.temp.path, { dirty: false, untracked: 0, unpushed: 3, branch: w.temp.branch, upstream: null });
  await w.finish();
  const report = await sweepTemporaryWorkspacesUseCase(w.deps);
  assert.deepEqual(report.kept, [w.temp.id]);
  const kept = await w.deps.workspaces.byId(w.temp.id);
  assert.equal(kept?.state, 'kept');
  assert.match(kept?.keptReason ?? '', /3 个提交/);
  const plain = await removeWorkspaceUseCase(w.deps, { workspaceId: w.temp.id, deleteDirectory: true });
  assert.ok(!plain.ok);
  const forced = await removeWorkspaceUseCase(w.deps, { workspaceId: w.temp.id, deleteDirectory: true, force: true });
  assert.ok(forced.ok);
  assert.ok(w.git.calls.some((call) => call.endsWith(':force')));
});

test('机器离线：跳过，下次再查', async () => {
  const w = await world('https://example.com/demo.git');
  await w.finish();
  w.git.failNext = 'offline';
  const report = await sweepTemporaryWorkspacesUseCase(w.deps);
  assert.deepEqual(report.skipped, [w.temp.id]);
  assert.equal((await w.deps.workspaces.byId(w.temp.id))?.state, 'ready');
});

test('非 git 项目也能清理临时目录', async () => {
  const w = await world();
  assert.equal(w.temp.isGit, false);
  await w.finish();
  const report = await sweepTemporaryWorkspacesUseCase(w.deps);
  assert.deepEqual(report.removed, [w.temp.id]);
});

test('人自己的目录只能移除登记，不能删；还有临时工作空间时不能删持久目录', async () => {
  const w = await world('https://example.com/demo.git');
  const all = await w.deps.workspaces.byProject(w.project.id);
  const cloned = all.find((ws) => ws.kind === 'long_lived');
  assert.ok(cloned);
  const blocked = await removeWorkspaceUseCase(w.deps, { workspaceId: cloned.id, deleteDirectory: true, force: true });
  assert.ok(!blocked.ok);
  assert.match(blocked.error.message, /临时工作空间/);
  w.git.repos.add('/home/me/mine');
  const linked = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/mine' }, home: '/home/me' });
  if (linked.ok) {
    const refused = await removeWorkspaceUseCase(w.deps, { workspaceId: linked.value.id, deleteDirectory: true });
    assert.ok(!refused.ok);
    const unregistered = await removeWorkspaceUseCase(w.deps, { workspaceId: linked.value.id, deleteDirectory: false });
    assert.ok(unregistered.ok);
  }
});
