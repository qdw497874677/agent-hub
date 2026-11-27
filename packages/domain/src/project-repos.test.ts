import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_REPOS_MAX,
  REPO_TOKEN_PREFIX,
  createProject,
  isCanonicalRepoTokenKey,
  isHttpRepoUrl,
  isHttpsRepoUrl,
  legacyRepoTokenKey,
  parseRepoTokenName,
  repoIdOfTokenName,
  repoTokenKey,
  deriveRepoId,
  normalizeRepos,
  primaryRepo,
  repoNameFromUrl,
  withProjectRepos
} from './project.ts';

test('normalizeRepos：名字缺省时从 URL 派生，id 确定性生成', () => {
  const one = normalizeRepos([{ url: 'https://example.com/me/api.git' }]);
  assert.ok(one.ok);
  assert.deepEqual(one.value, [
    { id: deriveRepoId('api', 'https://example.com/me/api.git'), name: 'api', url: 'https://example.com/me/api.git', defaultBranch: null }
  ]);
  const again = normalizeRepos([{ url: 'https://example.com/me/api.git' }]);
  assert.ok(again.ok);
  assert.equal(again.value[0]!.id, one.value[0]!.id);
});

test('normalizeRepos：空数组合法；最多 8 个', () => {
  const empty = normalizeRepos([]);
  assert.ok(empty.ok);
  assert.deepEqual(empty.value, []);
  const eight = normalizeRepos(Array.from({ length: PROJECT_REPOS_MAX }, (_, i) => ({ name: `repo-${i}`, url: `https://x.test/${i}.git` })));
  assert.ok(eight.ok);
  const nine = normalizeRepos(Array.from({ length: PROJECT_REPOS_MAX + 1 }, (_, i) => ({ name: `repo-${i}`, url: `https://x.test/${i}.git` })));
  assert.equal(nine.ok, false);
});

test('normalizeRepos：重名 / 非法名 / 空地址 / 非法分支都报错', () => {
  const dup = normalizeRepos([
    { name: 'api', url: 'https://x.test/a.git' },
    { name: 'api', url: 'https://x.test/b.git' }
  ]);
  assert.equal(dup.ok, false);
  const bad = normalizeRepos([{ name: 'API', url: 'https://x.test/a.git' }]);
  assert.equal(bad.ok, false);
  const badStart = normalizeRepos([{ name: '1api', url: 'https://x.test/a.git' }]);
  assert.equal(badStart.ok, false);
  const emptyUrl = normalizeRepos([{ name: 'api', url: '  ' }]);
  assert.equal(emptyUrl.ok, false);
  const branch = normalizeRepos([{ name: 'api', url: 'https://x.test/a.git', defaultBranch: 'bad branch' }]);
  assert.equal(branch.ok, false);
});

test('normalizeRepos：保留调用方给的 id（改名不改 id）', () => {
  const kept = normalizeRepos([{ id: 'repo_deadbeef', name: 'api', url: 'https://x.test/a.git', defaultBranch: 'main' }]);
  assert.ok(kept.ok);
  assert.equal(kept.value[0]!.id, 'repo_deadbeef');
  assert.equal(kept.value[0]!.defaultBranch, 'main');
});

test('normalizeRepos：拒绝写入重复 id，但旧清单仍可读并修正', () => {
  const list = [
    { id: 'same', name: 'api', url: 'https://x.test/a.git' },
    { id: ' same ', name: 'web', url: 'https://x.test/b.git' }
  ];
  assert.equal(normalizeRepos(list, { acceptTokenSecret: false }).ok, false);
  assert.equal(normalizeRepos(list, { allowLegacyDuplicateIds: true }).ok, true);
});

test('repoNameFromUrl：从常见地址形态派生合法目录名', () => {
  assert.equal(repoNameFromUrl('git@github.com:me/Agent_Hub.git'), 'agent-hub');
  assert.equal(repoNameFromUrl('https://example.com/a/b/'), 'b');
  assert.equal(repoNameFromUrl('https://example.com/'), 'example-com');
  assert.equal(repoNameFromUrl('/tmp/123.git'), 'repo-123');
});

test('primaryRepo：优先 repos[0]；只有老 repo 时派生单成员', () => {
  const project = createProject({ name: 'p', now: 1, repo: { url: 'https://x.test/a.git', defaultBranch: 'main' } });
  assert.ok(project.ok);
  assert.deepEqual(project.value.repo, { url: 'https://x.test/a.git', defaultBranch: 'main' });
  assert.equal(project.value.repos.length, 1);
  assert.equal(primaryRepo(project.value)?.name, 'a');
  // 模拟老数据：repos 是空但 repo 有值
  assert.equal(primaryRepo({ repo: { url: 'git@x:me/api.git', defaultBranch: null }, repos: [] })?.id, deriveRepoId('api', 'git@x:me/api.git'));
  assert.equal(primaryRepo({ repo: null, repos: [] }), null);
});

test('withProjectRepos：repo 始终等于 repos[0]', () => {
  const project = createProject({ name: 'p', now: 1 });
  assert.ok(project.ok);
  const repos = normalizeRepos([
    { name: 'api', url: 'https://x.test/api.git' },
    { name: 'web', url: 'https://x.test/web.git' }
  ]);
  assert.ok(repos.ok);
  const next = withProjectRepos(project.value, repos.value);
  assert.deepEqual(next.repo, { url: 'https://x.test/api.git', defaultBranch: null });
  assert.equal(next.repos.length, 2);
  const cleared = withProjectRepos(next, []);
  assert.equal(cleared.repo, null);
  assert.deepEqual(cleared.repos, []);
});

test('normalizeRepos：保留 tokenSecret（trim），空串 / 没给就不写字段', () => {
  const kept = normalizeRepos([{ name: 'api', url: 'https://x.test/a.git', tokenSecret: '  repo-git:repo_deadbeef  ' }]);
  assert.ok(kept.ok);
  assert.equal(kept.value[0]!.tokenSecret, 'repo-git:repo_deadbeef');

  const blank = normalizeRepos([{ name: 'api', url: 'https://x.test/a.git', tokenSecret: '   ' }]);
  assert.ok(blank.ok);
  assert.equal('tokenSecret' in blank.value[0]!, false);

  const absent = normalizeRepos([{ name: 'api', url: 'https://x.test/a.git' }]);
  assert.ok(absent.ok);
  assert.equal('tokenSecret' in absent.value[0]!, false);
});

test('normalizeRepos：acceptTokenSecret: false 时忽略调用方塞的 tokenSecret', () => {
  const ignored = normalizeRepos(
    [{ name: 'api', url: 'https://x.test/a.git', tokenSecret: 'repo-git:project_other:repo_deadbeef' }],
    { acceptTokenSecret: false }
  );
  assert.ok(ignored.ok);
  assert.equal('tokenSecret' in ignored.value[0]!, false);
});

test('repoTokenKey / parseRepoTokenName / isCanonicalRepoTokenKey：新键按项目 + 仓库双作用域', () => {
  assert.equal(repoTokenKey('project_a', 'repo_deadbeef'), 'repo-git:project_a:repo_deadbeef');
  assert.equal(legacyRepoTokenKey('repo_deadbeef'), 'repo-git:repo_deadbeef');
  assert.equal(REPO_TOKEN_PREFIX, 'repo-git:');

  assert.deepEqual(parseRepoTokenName('repo-git:project_a:repo_deadbeef'), {
    projectId: 'project_a',
    repoId: 'repo_deadbeef',
    legacy: false
  });
  assert.deepEqual(parseRepoTokenName('repo-git:repo_deadbeef'), {
    projectId: null,
    repoId: 'repo_deadbeef',
    legacy: true
  });
  assert.equal(parseRepoTokenName('repo-git:project_a:a:b'), null, '多余的冒号不认');
  assert.equal(parseRepoTokenName('repo-git::repo_deadbeef'), null);
  assert.equal(parseRepoTokenName('repo-git:project_a:'), null);
  assert.equal(parseRepoTokenName('repo-git:'), null);
  assert.equal(parseRepoTokenName('asset-git:a1'), null);

  assert.equal(repoIdOfTokenName('repo-git:project_a:repo_deadbeef'), 'repo_deadbeef');
  assert.equal(repoIdOfTokenName('repo-git:repo_deadbeef'), 'repo_deadbeef');
  assert.equal(repoIdOfTokenName('asset-git:a1'), null);

  assert.equal(isCanonicalRepoTokenKey('project_a', 'repo_deadbeef', 'repo-git:project_a:repo_deadbeef'), true);
  assert.equal(isCanonicalRepoTokenKey('project_a', 'repo_deadbeef', 'repo-git:project_b:repo_deadbeef'), false);
  assert.equal(isCanonicalRepoTokenKey('project_a', 'repo_deadbeef', 'repo-git:repo_deadbeef'), false, '旧格式不认');
  assert.equal(isCanonicalRepoTokenKey('project_a', 'repo_deadbeef', null), false);
});

test('isHttpRepoUrl / isHttpsRepoUrl：地址判定', () => {
  assert.equal(isHttpRepoUrl('https://gitlab.test/me/api.git'), true);
  assert.equal(isHttpRepoUrl(' http://gitlab.test/me/api.git '), true);
  assert.equal(isHttpRepoUrl('git@gitlab.test:me/api.git'), false);
  assert.equal(isHttpRepoUrl('/srv/repos/api.git'), false);
  assert.equal(isHttpsRepoUrl('https://gitlab.test/me/api.git'), true);
  assert.equal(isHttpsRepoUrl(' HTTPS://gitlab.test/me/api.git '), true);
  assert.equal(isHttpsRepoUrl('http://gitlab.test/me/api.git'), false);
  assert.equal(isHttpsRepoUrl('git@gitlab.test:me/api.git'), false);
  assert.equal(isHttpsRepoUrl('/srv/repos/api.git'), false);
});
