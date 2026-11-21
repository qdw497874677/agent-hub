import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, legacyRepoTokenKey, repoTokenKey, withProjectRepos, normalizeRepos } from '@agent-hub/domain';
import { fakeProjects, fakeSecrets, fakeWorkspaces } from '@agent-hub/domain/testing';
import { asTaskId, newWorkspace } from '@agent-hub/domain';
import { authHeaderFor, repoAuthForPath, repoAuthForUrl, repoAuthFromCredential } from './repo-auth.ts';

const API = 'https://gitlab.test/me/api.git';
const WEB = 'https://gitlab.test/me/web.git';
const KEY = 'glpat-secret-123';
const HEADER = authHeaderFor(KEY, API).header;
const EXPECTED = { header: HEADER, url: API };

/** 一个绑了两个 HTTPS 仓库的项目，api 配了令牌；外加一台机器上的两个工作空间。 */
async function world() {
  const created = createProject({ name: 'p', now: 1 });
  assert.ok(created.ok);
  const normalized = normalizeRepos([
    { id: 'repo_aaaaaaaa', name: 'api', url: API, tokenSecret: repoTokenKey(created.value.id, 'repo_aaaaaaaa') },
    { id: 'repo_bbbbbbbb', name: 'web', url: WEB }
  ]);
  assert.ok(normalized.ok);
  const project = withProjectRepos(created.value, normalized.value);
  const projects = fakeProjects();
  await projects.save(project);
  const secrets = fakeSecrets();
  await secrets.put(repoTokenKey(project.id, 'repo_aaaaaaaa'), KEY, 1);

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

test('repoAuthForUrl：必须带当前项目 id，按规范化地址命中该项目仓库', async () => {
  const { deps, project } = await world();
  assert.equal(await repoAuthForUrl(deps, null, API), null, '没有 projectId 不扫全部项目（#233）');
  assert.deepEqual(await repoAuthForUrl(deps, null, API, project.id), EXPECTED);
  assert.deepEqual(await repoAuthForUrl(deps, null, 'https://gitlab.test/me/api', project.id), EXPECTED, '去掉 .git 仍命中');
  assert.equal(await repoAuthForUrl(deps, null, WEB, project.id), null, '没配令牌的仓库不返回 auth');
  assert.equal(await repoAuthForUrl(deps, null, 'https://gitlab.test/me/other.git', project.id), null);
});

test('repoAuthForUrl：SSH / 本地路径一律不传令牌', async () => {
  const { deps } = await world();
  assert.equal(await repoAuthForUrl(deps, null, 'git@gitlab.test:me/api.git'), null);
  assert.equal(await repoAuthForUrl(deps, null, '/srv/repos/api.git'), null);
});

test('repoAuthForUrl：只查当前项目，不把令牌漏到别的项目（#233）', async () => {
  const { deps, project } = await world();
  assert.deepEqual(await repoAuthForUrl(deps, null, API, project.id), EXPECTED);
  assert.equal(await repoAuthForUrl(deps, null, API, 'project_other'), null);
});

test('repoAuthForUrl：密钥箱里没有这条 = 不传（被清掉的情况）', async () => {
  const { deps, project } = await world();
  await deps.secrets.remove(repoTokenKey(project.id, 'repo_aaaaaaaa'));
  assert.equal(await repoAuthForUrl(deps, null, API, project.id), null);
});

test('repoAuthForUrl：旧格式 / 别的项目的 tokenSecret 都不解出令牌', async () => {
  const created = createProject({ name: 'p', now: 1 });
  assert.ok(created.ok);
  const legacy = legacyRepoTokenKey('repo_eeeeeeee');
  const foreign = repoTokenKey('project_other', 'repo_eeeeeeee');
  const normalized = normalizeRepos([
    { id: 'repo_eeeeeeee', name: 'api', url: API, tokenSecret: legacy },
    { id: 'repo_ffffffff', name: 'web', url: WEB, tokenSecret: foreign }
  ]);
  assert.ok(normalized.ok);
  const project = withProjectRepos(created.value, normalized.value);
  const projects = fakeProjects();
  await projects.save(project);
  const secrets = fakeSecrets();
  await secrets.put(legacy, KEY, 1);
  await secrets.put(foreign, KEY, 1);
  const deps = { projects, secrets };
  assert.equal(await repoAuthForUrl(deps, null, API, project.id), null);
  assert.equal(await repoAuthForUrl(deps, null, WEB, project.id), null);
});

test('repoAuthForPath：工作空间路径（含 worktree 子目录）反查仓库令牌', async () => {
  const { deps } = await world();
  assert.deepEqual(await repoAuthForPath(deps, 'w1', '/srv/work/api'), EXPECTED);
  assert.deepEqual(await repoAuthForPath(deps, 'w1', '/srv/work/api/.worktrees/fix-1'), EXPECTED);
  assert.equal(await repoAuthForPath(deps, 'w1', '/srv/work/web'), null);
  assert.equal(await repoAuthForPath(deps, 'w1', '/srv/work/nope'), null);
  // 别的机器上的同路径不命中（onMachine 按机器过滤）
  assert.equal(await repoAuthForPath(deps, 'w2', '/srv/work/api'), null);
});

test('repoAuthForUrl：明文 http / 配置成 http 的仓库都不给令牌（#233）', async () => {
  const created = createProject({ name: 'p', now: 1 });
  assert.ok(created.ok);
  const key = repoTokenKey(created.value.id, 'repo_cccccccc');
  const normalized = normalizeRepos([{ id: 'repo_cccccccc', name: 'api', url: 'http://gitlab.test/me/api.git', tokenSecret: key }]);
  assert.ok(normalized.ok);
  const project = withProjectRepos(created.value, normalized.value);
  const projects = fakeProjects();
  await projects.save(project);
  const secrets = fakeSecrets();
  await secrets.put(key, KEY, 1);
  const deps = { projects, secrets };
  // 目标是明文 http
  assert.equal(await repoAuthForUrl(deps, null, 'http://gitlab.test/me/api.git', project.id), null);
  // 目标写成 https，但项目里登记的地址是 http（sameRepoUrl 会忽略 scheme）
  assert.equal(await repoAuthForUrl(deps, null, API, project.id), null);
});

test('repoAuthForPath：明文 http 的工作空间登记不解出令牌', async () => {
  const created = createProject({ name: 'p', now: 1 });
  assert.ok(created.ok);
  const key = repoTokenKey(created.value.id, 'repo_dddddddd');
  const normalized = normalizeRepos([{ id: 'repo_dddddddd', name: 'api', url: API, tokenSecret: key }]);
  assert.ok(normalized.ok);
  const project = withProjectRepos(created.value, normalized.value);
  const projects = fakeProjects();
  await projects.save(project);
  const secrets = fakeSecrets();
  await secrets.put(key, KEY, 1);
  const workspaces = fakeWorkspaces();
  const plain = newWorkspace({ projectId: project.id, repoUrl: 'http://gitlab.test/me/api.git', workerId: 'w1', path: '/srv/work/plain', kind: 'long_lived', source: 'cloned', isGit: true, now: 1 });
  assert.ok(plain.ok);
  await workspaces.save(plain.value);
  assert.equal(await repoAuthForPath({ projects, workspaces, secrets }, 'w1', '/srv/work/plain'), null);
});

test('repoAuthFromCredential：只有 HTTPS 目标才把头带出去；空串 / 省略 = null', () => {
  assert.deepEqual(repoAuthFromCredential(' glpat-x ', API), authHeaderFor('glpat-x', API));
  assert.equal(repoAuthFromCredential('glpat-x', 'http://gitlab.test/me/api.git'), null);
  assert.equal(repoAuthFromCredential('glpat-x', 'git@gitlab.test:me/api.git'), null);
  assert.equal(repoAuthFromCredential('glpat-x', ''), null);
  assert.equal(repoAuthFromCredential('', API), null);
  assert.equal(repoAuthFromCredential('   ', API), null);
  assert.equal(repoAuthFromCredential(undefined, API), null);
  assert.equal(authHeaderFor('glpat-x', API).header.startsWith('Authorization: Basic '), true);
  // 头必须随令牌一起带上 hub 解析时绑定的 HTTPS 地址
  assert.equal(authHeaderFor('glpat-x', API).url, API);
});
