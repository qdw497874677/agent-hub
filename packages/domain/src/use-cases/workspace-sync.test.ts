import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import type { WorkspaceGroupId } from '../ids.ts';
import { createProjectUseCase, updateProjectReposUseCase } from './projects.ts';
import { prepareLongLivedWorkspaceUseCase } from './workspaces.ts';
import { syncWorkspaceReposUseCase } from './workspace-sync.ts';

async function world() {
  const w = inMemoryDeps();
  w.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const project = await createProjectUseCase(w.deps, { name: 'Demo App', repoUrl: 'https://example.com/core.git' });
  assert.ok(project.ok);
  const long = await prepareLongLivedWorkspaceUseCase(w.deps, {
    projectId: project.value.id,
    workerId: 'remote-1',
    plan: { mode: 'create' },
    home: '/home/me'
  });
  assert.ok(long.ok, long.ok ? '' : long.error.message);
  return { ...w, project: project.value, workspace: long.value };
}

test('同步仓库：项目新加的仓库补克隆到工作空间的同级目录', async () => {
  const w = await world();
  const updated = await updateProjectReposUseCase(w.deps, {
    projectId: w.project.id,
    repos: [
      { name: 'core', url: 'https://example.com/core.git' },
      { name: 'docs', url: 'https://example.com/docs.git' }
    ]
  });
  assert.ok(updated.ok, updated.ok ? '' : updated.error.message);
  w.git.absent.add('/srv/work/agent-hub-workspaces/docs');
  const synced = await syncWorkspaceReposUseCase(w.deps, { workspaceId: w.workspace.id, actor: null });
  assert.ok(synced.ok, synced.ok ? '' : synced.error.message);
  assert.deepEqual(synced.value.added, [{ name: 'docs', path: '/srv/work/agent-hub-workspaces/docs' }]);
  assert.deepEqual(synced.value.present, [{ name: 'core', path: w.workspace.path }]);
  assert.ok(w.git.calls.some((call) => call === 'remote-1:clone:https://example.com/docs.git->/srv/work/agent-hub-workspaces/docs'));
});

test('同步仓库：已经在的不重复克隆，非 git 同名目录跳过并说明原因', async () => {
  const w = await world();
  const updated = await updateProjectReposUseCase(w.deps, {
    projectId: w.project.id,
    repos: [
      { name: 'core', url: 'https://example.com/core.git' },
      { name: 'tools', url: 'https://example.com/tools.git' }
    ]
  });
  assert.ok(updated.ok, updated.ok ? '' : updated.error.message);
  // /srv/work/agent-hub-workspaces/tools 存在但不是 git 仓库
  const synced = await syncWorkspaceReposUseCase(w.deps, { workspaceId: w.workspace.id, actor: null });
  assert.ok(synced.ok, synced.ok ? '' : synced.error.message);
  assert.equal(synced.value.added.length, 0);
  assert.deepEqual(synced.value.skipped, [{ name: 'tools', reason: '同名目录存在但不是 git 仓库，没有动它' }]);
  assert.ok(!w.git.calls.some((call) => call.includes(':clone:https://example.com/tools.git')));
});

test('同步仓库：按远端地址认已存在，目录名和仓库名不同也不重复克隆', async () => {
  const w = await world();
  // 工作空间目录叫 project-name，远端是 core.git（和清单里的 name "core" 不一致）
  w.git.remotes.set(w.workspace.path, 'https://example.com/core.git');
  const updated = await updateProjectReposUseCase(w.deps, {
    projectId: w.project.id,
    repos: [
      { name: 'core', url: 'https://example.com/core.git' },
      { name: 'docs', url: 'https://example.com/docs.git' }
    ]
  });
  assert.ok(updated.ok, updated.ok ? '' : updated.error.message);
  w.git.absent.add('/srv/work/agent-hub-workspaces/docs');
  const clonesBefore = w.git.calls.filter((call) => call.includes(':clone:')).length;
  const synced = await syncWorkspaceReposUseCase(w.deps, { workspaceId: w.workspace.id, actor: null });
  assert.ok(synced.ok, synced.ok ? '' : synced.error.message);
  assert.deepEqual(synced.value.present, [{ name: 'core', path: w.workspace.path }]);
  assert.deepEqual(synced.value.added, [{ name: 'docs', path: '/srv/work/agent-hub-workspaces/docs' }]);
  assert.equal(w.git.calls.filter((call) => call.includes(':clone:')).length, clonesBefore + 1, '只该克隆 docs 一次');
});

test('同步仓库：一个仓库失败不影响其它仓库，失败的单独报', async () => {
  const w = await world();
  const updated = await updateProjectReposUseCase(w.deps, {
    projectId: w.project.id,
    repos: [
      { name: 'core', url: 'https://example.com/core.git' },
      { name: 'broken', url: 'https://example.com/broken.git' },
      { name: 'docs', url: 'https://example.com/docs.git' }
    ]
  });
  assert.ok(updated.ok, updated.ok ? '' : updated.error.message);
  w.git.absent.add('/srv/work/agent-hub-workspaces/broken');
  w.git.absent.add('/srv/work/agent-hub-workspaces/docs');
  w.git.failNext = '远端返回 Project Not Found';
  const synced = await syncWorkspaceReposUseCase(w.deps, { workspaceId: w.workspace.id, actor: null });
  assert.ok(synced.ok, synced.ok ? '' : synced.error.message);
  assert.deepEqual(synced.value.failed, [{ name: 'broken', message: '远端返回 Project Not Found' }]);
  assert.deepEqual(synced.value.added, [{ name: 'docs', path: '/srv/work/agent-hub-workspaces/docs' }]);
});

test('同步仓库：组合工作空间不在这里处理', async () => {
  const w = await world();
  const member = await w.deps.workspaces.byId(w.workspace.id);
  assert.ok(member);
  await w.deps.workspaces.save({ ...member, groupId: 'wg_1234abcd' as WorkspaceGroupId });
  const synced = await syncWorkspaceReposUseCase(w.deps, { workspaceId: w.workspace.id, actor: null });
  assert.ok(!synced.ok);
  assert.equal(synced.error.code, 'invalid');
});
