import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GIT_HOST_POLICY,
  checkGitSourceUrl,
  gitHostPolicyFromEnv,
  gitUrlHost,
  isBlockedGitHost,
  parseGitAllowedHosts
} from './asset-git-host.ts';

test('git 主机策略：内网 / 回环 / 保留地址被拒，公网主机通过', () => {
  const blocked = [
    'https://localhost/x.git',
    'https://127.0.0.1/x.git',
    'https://127.1.2.3/x.git',
    'https://10.1.2.3/x.git',
    'https://172.16.0.1/x.git',
    'https://172.31.255.255/x.git',
    'https://192.168.1.1/x.git',
    'https://169.254.169.254/latest/meta-data',
    'https://0.0.0.0/x.git',
    'https://[::1]/x.git',
    'https://git.local/x.git',
    'https://git.internal/x.git',
    'git@10.0.0.7:org/repo.git'
  ];
  for (const url of blocked) {
    const got = checkGitSourceUrl(url, DEFAULT_GIT_HOST_POLICY);
    assert.equal(got.ok, false, url);
  }
  assert.equal(checkGitSourceUrl('https://github.com/x/y.git', DEFAULT_GIT_HOST_POLICY).ok, true);
  assert.equal(checkGitSourceUrl('git@github.com:x/y.git', DEFAULT_GIT_HOST_POLICY).ok, true);
  assert.equal(checkGitSourceUrl('ssh://git@gitlab.example.com/x/y.git', DEFAULT_GIT_HOST_POLICY).ok, true);
  assert.equal(checkGitSourceUrl('https://172.15.0.1/x.git', DEFAULT_GIT_HOST_POLICY).ok, true, '172.15 不在 172.16/12');
  assert.equal(checkGitSourceUrl('file:///etc', DEFAULT_GIT_HOST_POLICY).ok, false);
  assert.equal(checkGitSourceUrl('https://exa mple.com/x.git', DEFAULT_GIT_HOST_POLICY).ok, false);
});

test('git 主机策略：ASSET_GIT_ALLOWED_HOSTS 追加放行，ASSET_GIT_ALLOW_ANY_HOST 放开全部', () => {
  const policy = gitHostPolicyFromEnv({ ASSET_GIT_ALLOWED_HOSTS: 'git.corp, .example.com' });
  assert.deepEqual(policy.allowedHosts, ['git.corp', '.example.com']);
  assert.equal(checkGitSourceUrl('https://git.corp/x.git', policy).ok, true);
  assert.equal(checkGitSourceUrl('https://git.local/x.git', policy).ok, false, '名单之外的内网仍拒');
  assert.equal(checkGitSourceUrl('https://mirror.example.com/x.git', policy).ok, true, '点开头放行后缀');
  const any = gitHostPolicyFromEnv({ ASSET_GIT_ALLOW_ANY_HOST: '1' });
  assert.equal(any.allowAnyHost, true);
  assert.equal(checkGitSourceUrl('https://127.0.0.1/x.git', any).ok, true);
  assert.equal(gitHostPolicyFromEnv({ ASSET_GIT_ALLOW_ANY_HOST: 'true' }).allowAnyHost, false, '只认 =1');
});

test('git 主机策略：解析主机名与主机列表', () => {
  assert.equal(gitUrlHost('https://GitHub.com/x/y.git'), 'github.com');
  assert.equal(gitUrlHost('ssh://git@github.com:22/x/y.git'), 'github.com');
  assert.equal(gitUrlHost('git@github.com:x/y.git'), 'github.com');
  assert.equal(gitUrlHost('git@github.com:org/repo.git'), 'github.com');
  assert.equal(gitUrlHost('/etc'), null);
  assert.deepEqual(parseGitAllowedHosts(' a, ,b '), ['a', 'b']);
  assert.deepEqual(parseGitAllowedHosts(undefined), []);
  assert.equal(isBlockedGitHost('[::1]'), true);
  assert.equal(isBlockedGitHost('::1'), true);
  assert.equal(isBlockedGitHost('github.com'), false);
  assert.equal(isBlockedGitHost('localhost.'), true);
});
