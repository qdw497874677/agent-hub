import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoUrl, sameRepoUrl } from './repo-url.ts';

test('sameRepoUrl：忽略 .git、userinfo、末尾斜杠和大小写', () => {
  assert.equal(sameRepoUrl('https://gitlab.test/me/api.git', 'https://gitlab.test/me/api'), true);
  assert.equal(sameRepoUrl('https://x-access-token:tok@gitlab.test/Me/API.git', 'https://gitlab.test/me/api'), true);
  assert.equal(sameRepoUrl('https://gitlab.test/me/api/', 'HTTPS://GITLAB.TEST/me/api.git'), true);
  assert.equal(sameRepoUrl('https://gitlab.test/me/api.git', 'https://gitlab.test/me/web.git'), false);
});

test('normalizeRepoUrl：空串为 null；SSH / 本地路径做 trim 精确比较', () => {
  assert.equal(normalizeRepoUrl(''), null);
  assert.equal(normalizeRepoUrl('   '), null);
  assert.equal(sameRepoUrl('git@gitlab.test:me/api.git', 'git@gitlab.test:me/api.git'), true);
  assert.equal(sameRepoUrl('/srv/repos/api.git', '/srv/repos/api.git'), true);
});
