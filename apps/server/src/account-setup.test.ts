import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inMemoryAccounts } from '@agent-hub/domain/testing';
import { hubTokenWindow, seedTestAccount } from './account-setup.ts';

test('测试账号：密码写进 600 文件、日志里没有密码、重启沿用同一个密码', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-acct-'));
  const file = join(dir, 'sub', 'test-account');
  const accounts = inMemoryAccounts();
  const lines: string[] = [];
  await seedTestAccount(accounts, { email: 'test@agent-hub.local', passwordFile: file }, (l) => lines.push(l));
  const password = readFileSync(file, 'utf8').trim();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(password.length >= 20);
  assert.ok(lines.every((l) => !l.includes(password)));
  await seedTestAccount(accounts, { email: 'test@agent-hub.local', passwordFile: file }, () => undefined);
  assert.equal(readFileSync(file, 'utf8').trim(), password);
  assert.equal((await accounts.users.byEmail('test@agent-hub.local'))?.role, 'owner');
  rmSync(dir, { recursive: true });
});

test('HUB_TOKEN 过渡期：起点落盘，重启不续命，过期返回 null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-tok-'));
  const day = 86_400_000;
  assert.equal(await hubTokenWindow(dir, null, 30, 0), null);
  assert.equal((await hubTokenWindow(dir, 't', 30, 1000))?.until, 1000 + 30 * day);
  assert.equal((await hubTokenWindow(dir, 't', 30, 5 * day))?.until, 1000 + 30 * day);
  assert.equal(await hubTokenWindow(dir, 't', 30, 31 * day), null);
  rmSync(dir, { recursive: true });
});
