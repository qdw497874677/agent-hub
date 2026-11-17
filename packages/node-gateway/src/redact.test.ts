import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from './redact.ts';

/**
 * 统一打码：进程命令行 / 服务日志共用。
 * 每种形态一条，断言「只留键名 / 前缀」，值不出现在结果里。
 */

test('redactSecrets：--token 用空格分隔', () => {
  const got = redactSecrets('deploy --token abc123 --verbose');
  assert.equal(got, 'deploy --token *** --verbose');
  assert.ok(!got.includes('abc123'));
});

test('redactSecrets：--token=xxx 用等号分隔', () => {
  assert.equal(redactSecrets('deploy --token=abc123'), 'deploy --token=***');
});

test('redactSecrets：--password / --db-password', () => {
  assert.equal(redactSecrets('mysql --password hunter2'), 'mysql --password ***');
  assert.equal(redactSecrets('db --db-password=hunter2'), 'db --db-password=***');
});

test('redactSecrets：Authorization: Bearer（短 token 也抹）', () => {
  assert.equal(
    redactSecrets('curl -H "Authorization: Bearer abc"'),
    'curl -H "Authorization: Bearer ***"'
  );
});

test('redactSecrets：KEY=value（键名含 KEY/TOKEN/SECRET/PASSWORD/SALT）', () => {
  assert.equal(redactSecrets('API_TOKEN=abc123 node app.js'), 'API_TOKEN=*** node app.js');
  assert.equal(redactSecrets('DB_PASSWORD=abc123 psql'), 'DB_PASSWORD=*** psql');
  assert.equal(redactSecrets('AWS_SECRET_ACCESS_KEY=abc123 aws s3 ls'), 'AWS_SECRET_ACCESS_KEY=*** aws s3 ls');
  assert.equal(redactSecrets('HASH_SALT=abc123 run'), 'HASH_SALT=*** run');
  // 非敏感键不动
  assert.equal(redactSecrets('NODE_ENV=production node app.js'), 'NODE_ENV=production node app.js');
});

test('redactSecrets：sk- / ghp_ / AKIA', () => {
  assert.equal(redactSecrets('key sk-abcdefghijklmnop in argv'), 'key sk-*** in argv');
  assert.equal(redactSecrets('token ghp_abcdefghijklmnopqrstuvwxyz0123'), 'token gh*_***');
  assert.equal(redactSecrets('AWS AKIAABCDEFGHIJKLMNOP used'), 'AWS AKIA*** used');
});

test('redactSecrets：URL 里的 user:pass@（短密码也抹）', () => {
  assert.equal(redactSecrets('git clone https://user:secret1234@host/x'), 'git clone https://user:***@host/x');
  assert.equal(redactSecrets('git clone https://u:p@host/x'), 'git clone https://u:***@host/x');
});
