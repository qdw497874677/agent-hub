import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, repoTokenKey, withProjectRepos, normalizeRepos } from '@agent-hub/domain';
import { fakeProjects, fakeSecrets, fakeWorkspaces } from '@agent-hub/domain/testing';
import { asTaskId, newWorkspace } from '@agent-hub/domain';
import { authHeaderFor, repoAuthForPath, repoAuthForUrl, repoAuthFromCredential } from './repo-auth.ts';

const API = 'https://gitlab.test/me/api.git';
const WEB = 'https://gitlab.test/me/web.git';
const KEY = 'glpat-secret-123';
const HEADER = authHeaderFor(KEY).header;

/** 一个绑了两个 HTTPS 仓库的项目，api 配了令牌；外加一台机器上的两个工作空间。 */
async function world() {
  const normalized = normalizeRepos([
    { id: 'repo_aaaaaaaa', name: 'api', url: API, tokenSecret: repoTokenKey('repo_aaaaaaaa') },
    { id: 'repo_bbbbbbbb', name: 'web', url: WEB }
  ]);
  assert.ok(normalized.ok);
  const created = createProject({ name: 'p', now: 1 });
  assert.ok(created.ok);
  const project = withProjectRepos(created.value, normalized.value);
  const projects = fakeProjects();
  await projects.save(project);
  const secrets = fakeSecrets();
  await secrets.put(repoTokenKey('repo_aaaaaaaa'), KEY, 1);

  const workspaces = fakeWorkspaces();
  const base = newWorkspace({ projectId: project.id, repoUrl: API, workerId: 'w1', path: '/srv/work/api', kind: 'long_lived', source: 'cloned', isGit: true, now: 1 });
  assert.ok(base.ok);
  await workspaces.save(base.value);
  const worktree = newWorkspace({ projectId: project.id, repoUrl: API, workerId: 'w1', path: '/srv/work/api/.worktrees/fix-1', kind: 'temporary', ownerTaskId: asTaskId('task_1'), source: 'worktree', isGit: true, now: 2 });
  assert.ok(worktree.ok);
  await workspaces.save(worktree.value);
  const other = newWorkspace({ projectId: project.id, repoUrl: WEB, workerId: 'w1', path: '/srv/work/web', kind: 'long_lived', source: 'cloned', isGit: true, now: 3 });
  assert.ok(other.ok);
  await workspaces.save(other.value);

  return { deps: { projects, workspaces, secrets }, project };
}

test('repoAuthForUrl：按地址命中项目仓库，解出密钥箱里的令牌', async () => {
  const { deps } = await world();
  assert.deepEqual(await repoAuthForUrl(deps, null, API), { header: HEADER });
  assert.equal(await repoAuthForUrl(deps, null, WEB), null, '没配令牌的仓库不返回 auth');
  assert.equal(await repoAuthForUrl(deps, null, 'https://gitlab.test/me/other.git'), null);
});

test('repoAuthForUrl：SSH / 本地路径一律不传令牌', async () => {
  const { deps } = await world();
  assert.equal(await repoAuthForUrl(deps, null, 'git@gitlab.test:me/api.git'), null);
  assert.equal(await repoAuthForUrl(deps, null, '/srv/repos/api.git'), null);
});

test('repoAuthForUrl：projectId 只是「先看这个项目」的提示，找不到再按 URL 全量找', async () => {
  const { deps, project } = await world();
  assert.deepEqual(await repoAuthForUrl(deps, null, API, project.id), { header: HEADER });
  // 同一个 URL 就是同一个仓库：提示没命中时全量找仍然能解出令牌
  assert.deepEqual(await repoAuthForUrl(deps, null, API, 'project_other'), { header: HEADER });
});

test('repoAuthForUrl：密钥箱里没有这条 = 不传（被清掉的情况）', async () => {
  const { deps } = await world();
  await deps.secrets.remove(repoTokenKey('repo_aaaaaaaa'));
  assert.equal(await repoAuthForUrl(deps, null, API), null);
});

test('repoAuthForPath：工作空间路径（含 worktree 子目录）反查仓库令牌', async () => {
  const { deps } = await world();
  assert.deepEqual(await repoAuthForPath(deps, 'w1', '/srv/work/api'), { header: HEADER });
  assert.deepEqual(await repoAuthForPath(deps, 'w1', '/srv/work/api/.worktrees/fix-1'), { header: HEADER });
  assert.equal(await repoAuthForPath(deps, 'w1', '/srv/work/web'), null);
  assert.equal(await repoAuthForPath(deps, 'w1', '/srv/work/nope'), null);
  // 别的机器上的同路径不命中（onMachine 按机器过滤）
  assert.equal(await repoAuthForPath(deps, 'w2', '/srv/work/api'), null);
});

test('repoAuthFromCredential：请求里的明文令牌 → 头；空串 / 省略 = null', () => {
  assert.deepEqual(repoAuthFromCredential(' glpat-x '), authHeaderFor('glpat-x'));
  assert.equal(repoAuthFromCredential(''), null);
  assert.equal(repoAuthFromCredential('   '), null);
  assert.equal(repoAuthFromCredential(undefined), null);
  assert.equal(authHeaderFor('glpat-x').header.startsWith('Authorization: Basic '), true);
});
