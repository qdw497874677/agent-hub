import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { legacyRepoTokenKey, repoTokenKey, withProjectRepos, type Project } from '../project.ts';
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

/** 直接改持久化层：模拟历史数据里单段键的 tokenSecret（用例本身不再写这种）。 */
async function seedLegacy(deps: Deps, project: Project, index = 0) {
  const repo = project.repos[index]!;
  const legacy = legacyRepoTokenKey(repo.id);
  await deps.secrets.put(legacy, 'legacy-token', 1);
  const repos = project.repos.map((row, i) => (i === index ? { ...row, tokenSecret: legacy } : row));
  const next = withProjectRepos(project, repos);
  await deps.projects.save(next);
  return { legacy, project: next };
}

test('updateProjectReposUseCase：credential 存进密钥箱，仓库上只留规范密钥名', async () => {
  const { deps, project } = await world();
  const saved = await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: [
      { id: project.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', credential: '  glpat-abc  ' },
      { id: project.repos[1]!.id, name: 'web', url: 'https://git.example.test/me/web.git' }
    ]
  });
  assert.ok(saved.ok);
  const key = repoTokenKey(project.id, project.repos[0]!.id);
  assert.equal(saved.value.repos[0]!.tokenSecret, key);
  assert.equal(saved.value.repos[1]!.tokenSecret, undefined);
  // 明文只进密钥箱，且 trim 过
  assert.deepEqual(await deps.secrets.reveal([key]), { [key]: 'glpat-abc' });
  assert.equal(JSON.stringify(saved.value).includes('glpat-abc'), false);
});

test('updateProjectReposUseCase：不带 credential 不清除，空串清除', async () => {
  const { deps, project } = await world();
  const key = repoTokenKey(project.id, project.repos[0]!.id);
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
  const apiKey = repoTokenKey(project.id, project.repos[0]!.id);
  const webKey = repoTokenKey(project.id, project.repos[1]!.id);
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
  const key = repoTokenKey(project.id, project.repos[0]!.id);
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
  const key = repoTokenKey(project.id, project.repos[0]!.id);
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

test('两个项目绑同一个仓库（同 name + url = 同一个 repoId）时令牌互不串', async () => {
  const { deps, project: a } = await world();
  const created = await createProjectUseCase(deps, { name: 'Other' });
  assert.ok(created.ok);
  const bound = await updateProjectReposUseCase(deps, {
    projectId: created.value.id,
    repos: [{ name: 'api', url: 'https://git.example.test/me/api.git' }]
  });
  assert.ok(bound.ok);
  const b = bound.value;

  // 历史碰撞的前提：派生 id 相同。
  assert.equal(a.repos[0]!.id, b.repos[0]!.id);
  const aKey = repoTokenKey(a.id, a.repos[0]!.id);
  const bKey = repoTokenKey(b.id, b.repos[0]!.id);
  assert.notEqual(aKey, bKey, '项目 id 把同一个 repoId 分开');

  await updateProjectReposUseCase(deps, {
    projectId: a.id,
    repos: [{ id: a.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', credential: 'token-a' }]
  });
  await updateProjectReposUseCase(deps, {
    projectId: b.id,
    repos: [{ id: b.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', credential: 'token-b' }]
  });
  assert.deepEqual(await deps.secrets.reveal([aKey]), { [aKey]: 'token-a' });
  assert.deepEqual(await deps.secrets.reveal([bKey]), { [bKey]: 'token-b' });

  // 清掉 A 的令牌，B 不受影响。
  const clearedA = await updateProjectReposUseCase(deps, {
    projectId: a.id,
    repos: [{ id: a.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', credential: '' }]
  });
  assert.ok(clearedA.ok);
  assert.deepEqual(await deps.secrets.reveal([aKey, bKey]), { [bKey]: 'token-b' });

  // 把 A 的仓库整个移除，也不动 B 的键。
  const removedA = await updateProjectReposUseCase(deps, { projectId: a.id, repos: [] });
  assert.ok(removedA.ok);
  assert.deepEqual(await deps.secrets.reveal([bKey]), { [bKey]: 'token-b' });
});

test('updateProjectReposUseCase：忽略调用方自带的 tokenSecret，也不删它指向的键', async () => {
  const { deps, project } = await world();
  const foreign = repoTokenKey('project_other', project.repos[0]!.id);
  await deps.secrets.put(foreign, 'foreign-token', 1);

  const saved = await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: [{ id: project.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', tokenSecret: foreign }]
  });
  assert.ok(saved.ok);
  assert.equal(saved.value.repos[0]!.tokenSecret, undefined);
  assert.deepEqual(await deps.secrets.reveal([foreign]), { [foreign]: 'foreign-token' });

  // 同时给 credential：只写本项目规范键，调用方的名字仍然不采用。
  const canonical = repoTokenKey(project.id, project.repos[0]!.id);
  const withCredential = await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: [{ id: project.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', tokenSecret: foreign, credential: 'glpat-own' }]
  });
  assert.ok(withCredential.ok);
  assert.equal(withCredential.value.repos[0]!.tokenSecret, canonical);
  assert.deepEqual(await deps.secrets.reveal([canonical]), { [canonical]: 'glpat-own' });
  assert.deepEqual(await deps.secrets.reveal([foreign]), { [foreign]: 'foreign-token' });
});

test('旧格式 tokenSecret：不读、不沿用、不删除；重新输入 credential 后写规范键', async () => {
  const { deps, project } = await world();
  const seeded = await seedLegacy(deps, project);

  // 不带 credential：仓库上丢掉旧引用，但旧键留在原地（归属不明，不能替用户删）。
  const kept = await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: project.repos.map((repo) => ({ id: repo.id, name: repo.name, url: repo.url, defaultBranch: repo.defaultBranch }))
  });
  assert.ok(kept.ok);
  assert.equal(kept.value.repos[0]!.tokenSecret, undefined);
  assert.deepEqual(await deps.secrets.reveal([seeded.legacy]), { [seeded.legacy]: 'legacy-token' });

  // 显式空串：只清本项目规范键，旧键仍然不动。
  const cleared = await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: [{ id: project.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', credential: '' }]
  });
  assert.ok(cleared.ok);
  assert.equal(cleared.value.repos[0]!.tokenSecret, undefined);
  assert.deepEqual(await deps.secrets.reveal([seeded.legacy]), { [seeded.legacy]: 'legacy-token' });

  // 用户重新输入：写规范键，旧键依旧留给历史数据（不自动迁移）。
  const canonical = repoTokenKey(project.id, project.repos[0]!.id);
  const reentered = await updateProjectReposUseCase(deps, {
    projectId: project.id,
    repos: [{ id: project.repos[0]!.id, name: 'api', url: 'https://git.example.test/me/api.git', credential: 'glpat-new' }]
  });
  assert.ok(reentered.ok);
  assert.equal(reentered.value.repos[0]!.tokenSecret, canonical);
  assert.deepEqual(await deps.secrets.reveal([canonical, seeded.legacy]), { [canonical]: 'glpat-new', [seeded.legacy]: 'legacy-token' });
});

test('setProjectRepoUseCase：旧格式令牌不沿用也不回收', async () => {
  const { deps, project } = await world();
  const seeded = await seedLegacy(deps, project);
  const same = await setProjectRepoUseCase(deps, { projectId: project.id, repoUrl: 'https://git.example.test/me/api.git' });
  assert.ok(same.ok);
  assert.equal(same.value.repos[0]!.tokenSecret, undefined);
  assert.deepEqual(await deps.secrets.reveal([seeded.legacy]), { [seeded.legacy]: 'legacy-token' });

  const cleared = await setProjectRepoUseCase(deps, { projectId: project.id, repoUrl: null });
  assert.ok(cleared.ok);
  assert.deepEqual(await deps.secrets.reveal([seeded.legacy]), { [seeded.legacy]: 'legacy-token' });
});

test('deleteSecret：repo-git: 新旧两种格式都是内部密钥，不能从密钥接口单独删', async () => {
  const { deleteSecret } = await import('./assets.ts');
  const keys = [legacyRepoTokenKey('repo_deadbeef'), repoTokenKey('project_a', 'repo_deadbeef')];
  for (const key of keys) {
    const memory = inMemoryDeps();
    await memory.deps.secrets.put(key, 'tok', 1);
    const result = await deleteSecret({ secrets: memory.deps.secrets }, key);
    assert.equal(result.ok, false, key);
    assert.match(result.ok ? '' : result.error.message, /项目设置/);
    assert.deepEqual(await memory.deps.secrets.reveal([key]), { [key]: 'tok' });
  }
});
