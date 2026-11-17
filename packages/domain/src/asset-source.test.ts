import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGitSourceUrl } from './asset.ts';

test('GitHub 网址：仓库主页只给 url，ref/path 留空', () => {
  assert.deepEqual(parseGitSourceUrl('https://github.com/acme/skills'), {
    url: 'https://github.com/acme/skills.git',
    ref: null,
    path: ''
  });
  assert.deepEqual(parseGitSourceUrl('https://github.com/acme/skills.git/'), {
    url: 'https://github.com/acme/skills.git',
    ref: null,
    path: ''
  });
});

test('GitHub 网址：tree / blob 拆成 ref 与 path', () => {
  assert.deepEqual(parseGitSourceUrl('https://github.com/acme/skills/tree/main/skills/review'), {
    url: 'https://github.com/acme/skills.git',
    ref: 'main',
    path: 'skills/review'
  });
  assert.deepEqual(parseGitSourceUrl('https://github.com/acme/skills/blob/master/AGENTS.md'), {
    url: 'https://github.com/acme/skills.git',
    ref: 'master',
    path: 'AGENTS.md'
  });
  assert.deepEqual(parseGitSourceUrl('https://github.com/acme/skills/tree/main'), {
    url: 'https://github.com/acme/skills.git',
    ref: 'main',
    path: ''
  });
});

test('GitHub 网址：带 / 的分支名用 knownRefs 按最长前缀消歧', () => {
  const url = 'https://github.com/acme/skills/tree/release/1.0/skills/review';
  assert.deepEqual(parseGitSourceUrl(url), {
    url: 'https://github.com/acme/skills.git',
    ref: 'release',
    path: '1.0/skills/review'
  });
  assert.deepEqual(parseGitSourceUrl(url, ['main', 'release/1.0']), {
    url: 'https://github.com/acme/skills.git',
    ref: 'release/1.0',
    path: 'skills/review'
  });
});

test('GitHub 网址：非 github 或空串返回 null，交给上层报错', () => {
  assert.equal(parseGitSourceUrl(''), null);
  assert.equal(parseGitSourceUrl('https://gitlab.com/acme/skills'), null);
  assert.equal(parseGitSourceUrl('not a url'), null);
});

test('GitHub 网址：坏掉的百分号编码不算地址，别抛异常', () => {
  assert.equal(parseGitSourceUrl('https://github.com/acme/skills/tree/ma%ZZin/x'), null);
  assert.equal(parseGitSourceUrl('https://github.com/acme/skills/tree/%E0%A4%A'), null);
});
