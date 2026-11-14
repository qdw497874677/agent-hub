import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, deriveRepoId, normalizeRepos, repoNameFromUrl } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

const now = 1_700_000_000_000;

function twoRepoProject() {
  const repos = normalizeRepos([
    { name: 'api', url: 'https://example.test/me/api.git', defaultBranch: 'main' },
    { name: 'web', url: 'git@example.test:me/web.git' }
  ]);
  assert.ok(repos.ok);
  const project = createProject({ name: 'multi', now, repos: repos.value });
  assert.ok(project.ok);
  return project.value;
}

test('projects.repos 往返无损，老列双写第一个', async () => {
  const store = openSqliteStore(':memory:');
  const project = twoRepoProject();
  await store.projects.save(project);
  const read = await store.projects.byId(project.id);
  assert.deepEqual(read, project);
  const row = store.db
    .prepare('SELECT repo_url, repo_default_branch, repos FROM projects WHERE id = ?')
    .get(project.id) as { repo_url: string | null; repo_default_branch: string | null; repos: string | null };
  assert.equal(row.repo_url, 'https://example.test/me/api.git');
  assert.equal(row.repo_default_branch, 'main');
  assert.equal(JSON.parse(row.repos!).length, 2);
  store.close();
});

test('清空仓库清单：repos 写成 []、老列清空', async () => {
  const store = openSqliteStore(':memory:');
  const project = twoRepoProject();
  await store.projects.save(project);
  await store.projects.save({ ...project, repo: null, repos: [] });
  const read = await store.projects.byId(project.id);
  assert.deepEqual(read?.repos, []);
  assert.equal(read?.repo, null);
  const row = store.db.prepare('SELECT repo_url, repos FROM projects WHERE id = ?').get(project.id) as {
    repo_url: string | null;
    repos: string | null;
  };
  assert.equal(row.repo_url, null);
  assert.equal(row.repos, '[]');
  store.close();
});

test('老数据回填：repos 为 NULL 时从 repo_url 拼单成员（id 确定性）', async () => {
  const store = openSqliteStore(':memory:');
  const project = twoRepoProject();
  await store.projects.save(project);
  store.db.prepare("UPDATE projects SET repos = NULL, repo_url = ?, repo_default_branch = NULL WHERE id = ?").run(
    'git@example.test:me/legacy.git',
    project.id
  );
  const read = await store.projects.byId(project.id);
  const name = repoNameFromUrl('git@example.test:me/legacy.git');
  assert.deepEqual(read?.repos, [
    { id: deriveRepoId(name, 'git@example.test:me/legacy.git'), name, url: 'git@example.test:me/legacy.git', defaultBranch: null }
  ]);
  assert.deepEqual(read?.repo, { url: 'git@example.test:me/legacy.git', defaultBranch: null });
  store.close();
});

test('坏 repos JSON 不影响项目读取：回落到老列', async () => {
  const store = openSqliteStore(':memory:');
  const project = twoRepoProject();
  await store.projects.save(project);
  store.db.prepare('UPDATE projects SET repos = ? WHERE id = ?').run('{not json', project.id);
  const read = await store.projects.byId(project.id);
  assert.equal(read?.repos.length, 1);
  assert.equal(read?.repos[0]!.name, 'api');
  assert.deepEqual(read?.repo, { url: 'https://example.test/me/api.git', defaultBranch: 'main' });
  store.close();
});
