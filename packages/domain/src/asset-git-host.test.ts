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
  assert.equal(gitUrlHost('git@[::1]:org/repo.git'), '::1');
  assert.equal(gitUrlHost('/etc'), null);
  assert.deepEqual(parseGitAllowedHosts(' a, ,b '), ['a', 'b']);
  assert.deepEqual(parseGitAllowedHosts(undefined), []);
  assert.equal(isBlockedGitHost('[::1]'), true);
  assert.equal(isBlockedGitHost('::1'), true);
  assert.equal(isBlockedGitHost('github.com'), false);
  assert.equal(isBlockedGitHost('localhost.'), true);
});

test('git 主机策略：非规范回环 / 简写 IP 不会被绕过（#224 补）', () => {
  const blocked = [
    'git@127.1:r.git',
    'git@0x7f.1:r.git',
    'git@0177.0.0.1:r.git',
    'git@[::1]:r.git',
    'ssh://git@0177.0.0.1/r.git',
    'ssh://git@127.1/r.git',
    'https://[::ffff:127.0.0.1]/x',
    'https://[::ffff:7f00:1]/x',
    'https://0x7f.1/x',
    'https://127.1/x',
    'https://10.0.0.5/x',
    'https://[fe80::1]/x',
    'https://[fd00::1]/x',
    'https://169.254.1.1/x'
  ];
  for (const url of blocked) {
    assert.equal(checkGitSourceUrl(url, DEFAULT_GIT_HOST_POLICY).ok, false, url);
  }
  // WHATWG URL 会把 https://127.1/ 与 https://0x7f.1/ 规范化成 127.0.0.1，
  // 所以这两条在旧版里本来就拦得住；scp 形式与 IPv4-mapped 靠本次的规范化才拦住。
  assert.equal(gitUrlHost('https://127.1/x'), '127.0.0.1');
  assert.equal(checkGitSourceUrl('https://gitlab.example.com/x/y.git', DEFAULT_GIT_HOST_POLICY).ok, true);
  assert.equal(checkGitSourceUrl('git@github.com:x/y.git', DEFAULT_GIT_HOST_POLICY).ok, true);
  assert.equal(checkGitSourceUrl('https://[2001:db8::1]/x.git', DEFAULT_GIT_HOST_POLICY).ok, true, '公网 IPv6 仍放行');
  assert.equal(isBlockedGitHost('::ffff:8.8.8.8'), false);
  assert.equal(isBlockedGitHost('fe80::1'), true);
  assert.equal(isBlockedGitHost('fd12::1'), true);
  assert.equal(isBlockedGitHost('172.15.0.1'), false);
});
