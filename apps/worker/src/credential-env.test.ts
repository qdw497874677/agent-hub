import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewriteCredentialEnv } from './credential-env.ts';

test('轮换：只换 HUB_WORKER_CREDENTIAL 那一行，权限不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  const file = join(dir, 'worker.env');
  writeFileSync(file, 'HUB_URL=ws://x\nHUB_WORKER_CREDENTIAL=ahw_old\nWORKER_ID=a\n', { mode: 0o600 });
  assert.equal(rewriteCredentialEnv(file, 'ahw_new'), true);
  assert.equal(readFileSync(file, 'utf8'), 'HUB_URL=ws://x\nHUB_WORKER_CREDENTIAL=ahw_new\nWORKER_ID=a\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('轮换：没有那一行 / 文件不在 / 凭据带怪字符都不写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  const file = join(dir, 'worker.env');
  writeFileSync(file, 'HUB_URL=ws://x\n');
  assert.equal(rewriteCredentialEnv(file, 'ahw_new'), false);
  assert.equal(rewriteCredentialEnv(join(dir, 'nope.env'), 'ahw_new'), false);
  writeFileSync(file, 'HUB_WORKER_CREDENTIAL=ahw_old\n');
  assert.equal(rewriteCredentialEnv(file, 'a\nHUB_URL=evil'), false);
  assert.equal(readFileSync(file, 'utf8'), 'HUB_WORKER_CREDENTIAL=ahw_old\n');
});
