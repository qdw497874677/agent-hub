import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_REPOS_MAX,
  REPO_DEFAULT_BRANCH,
  emptyRepoRow,
  repoRowProblem,
  repoRowsProblem,
  repoRowsFrom,
  repoRowsValue,
  repoUrlPatch,
  repoNameFromUrl,
  cloneErrorHint,
  reposDirty,
  type ProjectRepoRow
} from './project-repos.ts';

const row = (over: Partial<ProjectRepoRow> = {}): ProjectRepoRow => ({
  id: '',
  name: 'api',
  url: 'git@github.com:acme/api.git',
  defaultBranch: 'main',
  ...over
});

test('repoRowsFrom：老项目没有 repos / 形状不对 → 空清单', () => {
  assert.deepEqual(repoRowsFrom({ id: 'p1', name: 'x' }), []);
  assert.deepEqual(repoRowsFrom(null), []);
  assert.deepEqual(repoRowsFrom({ repos: 'nope' }), []);
  // 库里老行的 defaultBranch 可能是 null，读成空串（保存时回 main）
  assert.deepEqual(repoRowsFrom({ repos: [{ id: 'repo_1', name: 'api', url: 'https://x/y.git', defaultBranch: null }] }), [
    { id: 'repo_1', name: 'api', url: 'https://x/y.git', defaultBranch: '' }
  ]);
});

test('repoRowProblem：空 name / url 各自说清', () => {
  assert.equal(repoRowProblem(row({ name: '' }), [row({ name: '' })]), '写上仓库名（会用作组合工作空间里的子目录名）');
  assert.equal(repoRowProblem(row({ url: '' }), [row({ url: '' })]), '写上仓库地址');
});

test('repoRowProblem：仓库名规则 = 小写字母开头，字母数字和 -，最多 41 个字符', () => {
  const bad = (name: string) => repoRowProblem(row({ name }), [row({ name })]);
  assert.equal(bad('Api'), '仓库名只能用小写字母、数字和 -，并且以字母开头');
  assert.equal(bad('1api'), '仓库名只能用小写字母、数字和 -，并且以字母开头');
  assert.equal(bad('api_v2'), '仓库名只能用小写字母、数字和 -，并且以字母开头');
  assert.equal(bad(`a${'b'.repeat(41)}`), '仓库名只能用小写字母、数字和 -，并且以字母开头');
  assert.equal(bad(`a${'b'.repeat(40)}`), null);
});

test('repoRowProblem：重名两行都报', () => {
  const rows = [row({ name: 'api' }), row({ name: 'api' })];
  assert.equal(repoRowProblem(rows[1]!, rows), '仓库名重复：api');
  assert.equal(repoRowsProblem(rows), '仓库名重复：api');
});

test('repoRowProblem：地址只认 http(s) / ssh / git@host:path', () => {
  const ok = (url: string) => repoRowProblem(row({ url }), [row({ url })]);
  assert.equal(ok('https://github.com/acme/api.git'), null);
  assert.equal(ok('http://git.example.com/api'), null);
  assert.equal(ok('ssh://git@github.com/acme/api.git'), null);
  assert.equal(ok('git@github.com:acme/api.git'), null);
  assert.equal(ok('/home/me/code/api'), '仓库地址要以 http(s):// 或 ssh:// 开头');
  assert.equal(ok('github.com/acme/api'), '仓库地址要以 http(s):// 或 ssh:// 开头');
});

test('repoRowProblem：最多 8 个仓库', () => {
  const rows = Array.from({ length: PROJECT_REPOS_MAX + 1 }, (_, i) => row({ name: `repo-${i}`, url: `https://x/${i}` }));
  assert.equal(repoRowProblem(rows[0]!, rows), `一个项目最多 ${PROJECT_REPOS_MAX} 个仓库`);
});

test('repoRowsValue：默认分支留空写 null（用仓库自己的默认分支），原本有 id 就带上', () => {
  assert.deepEqual(repoRowsValue([row({ id: 'repo_1', defaultBranch: '' }), row({ name: 'web', url: 'https://x/web.git', defaultBranch: '' })]), [
    { id: 'repo_1', name: 'api', url: 'git@github.com:acme/api.git', defaultBranch: REPO_DEFAULT_BRANCH },
    { name: 'web', url: 'https://x/web.git', defaultBranch: REPO_DEFAULT_BRANCH }
  ]);
  // 两端的空白不进请求
  assert.deepEqual(repoRowsValue([row({ name: ' api ', url: ' https://x/y ', defaultBranch: ' dev ' })]), [
    { name: 'api', url: 'https://x/y', defaultBranch: 'dev' }
  ]);
});

test('reposDirty：空默认分支和 main 等价，不算改动', () => {
  const saved = repoRowsFrom({ repos: [{ id: 'repo_1', name: 'api', url: 'https://x/y.git', defaultBranch: null }] });
  assert.equal(reposDirty(repoRowsFrom({ repos: [{ id: 'repo_1', name: 'api', url: 'https://x/y.git', defaultBranch: null }] }), saved), false);
  assert.equal(reposDirty([row({ id: 'repo_1', url: 'https://x/y.git', defaultBranch: 'dev' })], saved), true);
});

test('emptyRepoRow：新行没有 id，保存时才带上名字和地址', () => {
  const blank = emptyRepoRow();
  assert.deepEqual(blank, { id: '', name: '', url: '', defaultBranch: '' });
  assert.equal(repoRowProblem(blank, [blank]), '写上仓库名（会用作组合工作空间里的子目录名）');
  // 0 个仓库是合法状态（不绑仓库）
  assert.equal(repoRowsProblem([]), null);
});

test('repoNameFromUrl：https / scp 写法都能猜出子目录名，猜不出就空', () => {
  assert.equal(repoNameFromUrl('https://github.com/acme/api.git'), 'api');
  assert.equal(repoNameFromUrl('git@github.com:acme/api.git'), 'api');
  assert.equal(repoNameFromUrl('ssh://git@host/acme/web-app.git/'), 'web-app');
  assert.equal(repoNameFromUrl('https://github.com/acme/My_Repo.git'), 'my-repo');
  assert.equal(repoNameFromUrl(''), '');
  assert.equal(repoNameFromUrl('https://github.com/'), '');
});

test('repoUrlPatch：名字还空着或还是自动填的，就跟着地址走；自己改过就不动', () => {
  assert.deepEqual(repoUrlPatch(row({ name: '', url: '' }), 'https://h/acme/api.git'), {
    url: 'https://h/acme/api.git',
    name: 'api'
  });
  assert.deepEqual(repoUrlPatch(row({ name: 'api', url: 'https://h/acme/api.git' }), 'https://h/acme/web.git'), {
    url: 'https://h/acme/web.git',
    name: 'web'
  });
  assert.deepEqual(repoUrlPatch(row({ name: 'backend', url: 'https://h/acme/api.git' }), 'https://h/acme/web.git'), {
    url: 'https://h/acme/web.git'
  });
  assert.deepEqual(repoUrlPatch(row({ name: '', url: '' }), 'https://github.com/'), { url: 'https://github.com/' });
});

test('cloneErrorHint：分支不存在 / 域名解析不了 / 没凭据各给一句可执行的建议', () => {
  assert.match(
    cloneErrorHint("下载仓库失败：Cloning into 'agent-hub'... fatal: Remote branch main not found in upstream origin") ?? '',
    /默认分支/
  );
  assert.match(cloneErrorHint('fatal: Could not resolve host: github.com') ?? '', /镜像地址|clone 好/);
  assert.match(cloneErrorHint('fatal: Authentication failed for repo') ?? '', /凭据/);
  assert.equal(cloneErrorHint('下载仓库失败：磁盘满了'), null);
});
