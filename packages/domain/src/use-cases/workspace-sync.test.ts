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

test('同步仓库：项目绑定多个仓库时拒绝补克隆同级目录，已有目录不动', async () => {
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
  const clonesBefore = w.git.calls.filter((call) => call.includes(':clone:')).length;
  const synced = await syncWorkspaceReposUseCase(w.deps, { workspaceId: w.workspace.id, actor: null });
  assert.ok(!synced.ok);
  assert.equal(synced.error.code, 'invalid');
  assert.match(synced.error.message, /组合工作空间/);
  assert.equal(w.git.calls.filter((call) => call.includes(':clone:')).length, clonesBefore, '多仓同步不得再克隆同级目录');
});

test('同步仓库：单仓项目只报告已在场的仓库，不克隆新目录', async () => {
  const w = await world();
  w.git.remotes.set(w.workspace.path, 'https://example.com/core.git');
  const clonesBefore = w.git.calls.filter((call) => call.includes(':clone:')).length;
  const synced = await syncWorkspaceReposUseCase(w.deps, { workspaceId: w.workspace.id, actor: null });
  assert.ok(synced.ok, synced.ok ? '' : synced.error.message);
  assert.deepEqual(synced.value.added, []);
  assert.deepEqual(synced.value.present, [{ name: 'core', path: w.workspace.path }]);
  assert.equal(w.git.calls.filter((call) => call.includes(':clone:')).length, clonesBefore, '单仓同步不得再克隆');
});

test('同步仓库：单仓项目里对不上的仓库不会自动克隆，说明原因并跳过', async () => {
  const w = await world();
  const updated = await updateProjectReposUseCase(w.deps, {
    projectId: w.project.id,
    repos: [{ name: 'docs', url: 'https://example.com/docs.git' }]
  });
  assert.ok(updated.ok, updated.ok ? '' : updated.error.message);
  w.git.remotes.set(w.workspace.path, 'https://example.com/core.git');
  const clonesBefore = w.git.calls.filter((call) => call.includes(':clone:')).length;
  const synced = await syncWorkspaceReposUseCase(w.deps, { workspaceId: w.workspace.id, actor: null });
  assert.ok(synced.ok, synced.ok ? '' : synced.error.message);
  assert.equal(synced.value.added.length, 0);
  assert.equal(synced.value.present.length, 0);
  assert.equal(synced.value.skipped[0]?.name, 'docs');
  assert.match(synced.value.skipped[0]?.reason ?? '', /组合工作空间|不会自动克隆/);
  assert.equal(w.git.calls.filter((call) => call.includes(':clone:')).length, clonesBefore);
});

test('同步仓库：只检查登记的工作空间路径，同级目录即使匹配也不看', async () => {
  const w = await world();
  const updated = await updateProjectReposUseCase(w.deps, {
    projectId: w.project.id,
    repos: [{ name: 'docs', url: 'https://example.com/docs.git' }]
  });
  assert.ok(updated.ok, updated.ok ? '' : updated.error.message);
  w.git.remotes.set(w.workspace.path, 'https://example.com/core.git');
  // 同级目录里放一个「匹配」的仓库：旧实现会扫描并认领它，新实现必须连 inspect 都不做。
  const sibling = '/srv/work/agent-hub-workspaces/docs';
  w.git.repos.add(sibling);
  w.git.remotes.set(sibling, 'https://example.com/docs.git');
  const scans: string[] = [];
  const listDirectories = w.deps.gateway.listDirectories;
  w.deps.gateway.listDirectories = async (workerId, path) => {
    scans.push(path);
    return listDirectories(workerId, path);
  };
  const synced = await syncWorkspaceReposUseCase(w.deps, { workspaceId: w.workspace.id, actor: null });
  assert.ok(synced.ok, synced.ok ? '' : synced.error.message);
  assert.deepEqual(scans, [], '不得扫描工作空间的上级目录');
  assert.deepEqual(synced.value.present, [], '不得认领同级目录');
  assert.equal(synced.value.skipped[0]?.name, 'docs');
  assert.match(synced.value.skipped[0]?.reason ?? '', /origin 和项目仓库对不上/);
  assert.deepEqual(
    w.git.calls.filter((call) => call.includes(':inspect:')),
    [`remote-1:inspect:${w.workspace.path}`],
    '只检查登记的工作空间路径'
  );
});

test('同步仓库：工作空间目录不是 git 仓库时跳过并说明原因，不改它', async () => {
  const w = await world();
  const updated = await updateProjectReposUseCase(w.deps, {
    projectId: w.project.id,
    repos: [{ name: 'tools', url: 'https://example.com/tools.git' }]
  });
  assert.ok(updated.ok, updated.ok ? '' : updated.error.message);
  w.git.repos.delete(w.workspace.path);
  const synced = await syncWorkspaceReposUseCase(w.deps, { workspaceId: w.workspace.id, actor: null });
  assert.ok(synced.ok, synced.ok ? '' : synced.error.message);
  assert.equal(synced.value.added.length, 0);
  assert.deepEqual(synced.value.skipped, [{ name: 'tools', reason: '工作空间目录不是 git 仓库，没有动它' }]);
  assert.ok(!w.git.calls.some((call) => call.includes(':clone:https://example.com/tools.git')));
});

test('同步仓库：工作空间目录不存在时如实跳过，不克隆', async () => {
  const w = await world();
  w.git.remotes.set(w.workspace.path, 'https://example.com/core.git');
  w.git.repos.delete(w.workspace.path);
  w.git.absent.add(w.workspace.path);
  const clonesBefore = w.git.calls.filter((call) => call.includes(':clone:')).length;
  const synced = await syncWorkspaceReposUseCase(w.deps, { workspaceId: w.workspace.id, actor: null });
  assert.ok(synced.ok, synced.ok ? '' : synced.error.message);
  assert.deepEqual(synced.value.present, []);
  assert.equal(synced.value.skipped[0]?.name, 'core');
  assert.match(synced.value.skipped[0]?.reason ?? '', /不存在/);
  assert.equal(w.git.calls.filter((call) => call.includes(':clone:')).length, clonesBefore);
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
