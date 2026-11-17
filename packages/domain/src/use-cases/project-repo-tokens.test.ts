import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { repoTokenKey } from '../project.ts';
import type { Deps } from './deps.ts';
import { createProjectUseCase, setProjectRepoUseCase, updateProjectReposUseCase } from './projects.ts';

/** 一个带两个 HTTPS 仓库的项目 + 空的密钥箱。 */
async function world() {
  const memory = inMemoryDeps();
  const deps: Deps = memory.deps;
  const created = await createProjectUseCase(deps, { name: 'Private' });
  assert.ok(created.ok);
  const repos = await updateProjectReposUseCase(deps, {
    projectId: created.value.id,
    repos: [
      { name: 'api', url: 'https://git.example.test/me/api.git' },
      { name: 'web', url: 'https://git.example.test/me/web.git' }
    ]
  });
  assert.ok(repos.ok);
  return { deps, project: repos.value };
}

test('updateProjectReposUseCase：credential 存进密钥箱，仓库上只留密钥名', async () => {
  const { deps, project } = await world();
  const saved = await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: [
      { id: project.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', credential: '  glpat-abc  ' },
      { id: project.repos[1]!.id, name: 'web', url: 'https://git.example.test/me/web.git' }
    ]
  });
  assert.ok(saved.ok);
  const key = repoTokenKey(project.repos[0]!.id);
  assert.equal(saved.value.repos[0]!.tokenSecret, key);
  assert.equal(saved.value.repos[1]!.tokenSecret, undefined);
  // 明文只进密钥箱，且 trim 过
  assert.deepEqual(await deps.secrets.reveal([key]), { [key]: 'glpat-abc' });
  assert.equal(JSON.stringify(saved.value).includes('glpat-abc'), false);
});

test('updateProjectReposUseCase：不带 credential 不清除，空串清除', async () => {
  const { deps, project } = await world();
  const key = repoTokenKey(project.repos[0]!.id);
  await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: [{ id: project.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', credential: 'glpat-abc' }]
  });
  // 只改分支，不带 credential：令牌还在
  const kept = await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: [{ id: project.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', defaultBranch: 'main' }]
  });
  assert.ok(kept.ok);
  assert.equal(kept.value.repos[0]!.tokenSecret, key);
  assert.deepEqual(await deps.secrets.reveal([key]), { [key]: 'glpat-abc' });

  const cleared = await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: [{ id: project.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', credential: '' }]
  });
  assert.ok(cleared.ok);
  assert.equal(cleared.value.repos[0]!.tokenSecret, undefined);
  assert.deepEqual(await deps.secrets.reveal([key]), {});
});

test('updateProjectReposUseCase：从清单里移除的仓库，密钥一起回收', async () => {
  const { deps, project } = await world();
  await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: [
      { id: project.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', credential: 'glpat-api' },
      { id: project.repos[1]!.id, name: 'web', url: 'https://git.example.test/me/web.git', credential: 'glpat-web' }
    ]
  });
  const apiKey = repoTokenKey(project.repos[0]!.id);
  const webKey = repoTokenKey(project.repos[1]!.id);
  assert.deepEqual(Object.keys(await deps.secrets.reveal([apiKey, webKey])).sort(), [apiKey, webKey].sort());

  const removed = await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: [{ id: project.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git' }]
  });
  assert.ok(removed.ok);
  assert.equal(removed.value.repos.length, 1);
  assert.deepEqual(await deps.secrets.reveal([apiKey, webKey]), { [apiKey]: 'glpat-api' });
});

test('updateProjectReposUseCase：换地址就回收旧令牌（可能是另一台主机）', async () => {
  const { deps, project } = await world();
  const key = repoTokenKey(project.repos[0]!.id);
  await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: [{ id: project.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', credential: 'glpat-abc' }]
  });
  const moved = await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: [{ id: project.repos[0]!.id, name: 'api', url: 'https://elsewhere.test/me/api.git' }]
  });
  assert.ok(moved.ok);
  assert.equal(moved.value.repos[0]!.tokenSecret, undefined);
  assert.deepEqual(await deps.secrets.reveal([key]), {});
});

test('setProjectRepoUseCase：地址不变保留令牌，清空仓库回收密钥', async () => {
  const { deps, project } = await world();
  const key = repoTokenKey(project.repos[0]!.id);
  await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: [{ id: project.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', credential: 'glpat-abc' }]
  });
  const same = await setProjectRepoUseCase(deps, { projectId: project.id, repoUrl: 'https://git.example.test/me/api.git' });
  assert.ok(same.ok);
  assert.equal(same.value.repos[0]!.tokenSecret, key);

  const cleared = await setProjectRepoUseCase(deps, { projectId: project.id, repoUrl: null });
  assert.ok(cleared.ok);
  assert.deepEqual(cleared.value.repos, []);
  assert.deepEqual(await deps.secrets.reveal([key]), {});
});

test('deleteSecret：repo-git: 是内部密钥，不能从密钥接口单独删', async () => {
  const { deleteSecret } = await import('./assets.ts');
  const memory = inMemoryDeps();
  await memory.deps.secrets.put(repoTokenKey('repo_deadbeef'), 'tok', 1);
  const result = await deleteSecret({ secrets: memory.deps.secrets }, repoTokenKey('repo_deadbeef'));
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error.message, /项目设置/);
  assert.deepEqual(await memory.deps.secrets.reveal([repoTokenKey('repo_deadbeef')]), { [repoTokenKey('repo_deadbeef')]: 'tok' });
});
