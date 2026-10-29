import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fallbackDirs, missingCommandHint, resolveCommand } from './command-resolver.ts';

const fake = (files: readonly string[]) => ({ isExecutable: (file: string) => files.includes(file), listDir: () => [], readLink: () => null });

test('resolveCommand：X_COMMAND 优先，其次 PATH，再其次常见位置，都没有就是 missing', () => {
  const home = '/h';
  assert.deepEqual(resolveCommand('pi', { explicit: '/opt/pi', path: '/usr/bin', home, ...fake([]) }), { source: 'explicit', command: '/opt/pi' });
  assert.deepEqual(resolveCommand('pi', { path: '/usr/bin:/a', home, ...fake(['/a/pi', '/h/.local/bin/pi']) }), { source: 'path', command: 'pi' });
  assert.deepEqual(resolveCommand('pi', { path: '/usr/bin', home, ...fake(['/h/.local/bin/pi']) }), {
    source: 'fallback',
    command: '/h/.local/bin/pi',
    dir: '/h/.local/bin'
  });
  assert.deepEqual(resolveCommand('pi', { path: '', home, ...fake([]) }), { source: 'missing', command: 'pi' });
  // 带路径的命令不去找，只看它在不在
  assert.equal(resolveCommand('/x/pi', { home, ...fake([]) }).source, 'missing');
});

test('fallbackDirs：npm 全局、nvm 当前与最新版、~/.local/bin、pi 自带 node、bun、volta、/usr/local/bin', () => {
  const listDir = (dir: string) => (dir.endsWith('versions/node') ? ['v20.1.0', 'v22.10.0', 'v22.3.0'] : dir.endsWith('pi-node') ? ['node-v22.23.2-linux-x64'] : []);
  const dirs = fallbackDirs({ home: '/h', env: { NVM_BIN: '/n/bin' }, listDir, readLink: () => null });
  assert.deepEqual(dirs, [
    '/h/.npm-global/bin',
    '/n/bin',
    '/h/.nvm/versions/node/v22.10.0/bin',
    '/h/.nvm/versions/node/v22.3.0/bin',
    '/h/.nvm/versions/node/v20.1.0/bin',
    '/h/.local/bin',
    '/h/.local/share/pi-node/node-v22.23.2-linux-x64/bin',
    '/h/.bun/bin',
    '/h/.volta/bin',
    '/usr/local/bin'
  ]);
});

test('resolveCommand 读真实文件系统：只认可执行文件，nvm current 链接也认', () => {
  const home = mkdtempSync(join(tmpdir(), 'resolver-'));
  try {
    const bin = join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'opencode'), '#!/bin/sh\n');
    assert.equal(resolveCommand('opencode', { path: '/nonexistent', home }).source, 'missing');
    chmodSync(join(bin, 'opencode'), 0o755);
    symlinkSync(join(home, '.nvm', 'versions', 'node', 'v24.1.0'), join(home, '.nvm', 'current'));
    assert.deepEqual(resolveCommand('opencode', { path: '/nonexistent', home, env: {} }), { source: 'fallback', command: join(bin, 'opencode'), dir: bin });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('missingCommandHint', () => {
  assert.equal(missingCommandHint('pi', 'PI_COMMAND'), 'PATH 里找不到 pi，可设 PI_COMMAND 指定路径');
});
