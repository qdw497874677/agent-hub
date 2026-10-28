import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piReadiness } from './readiness.ts';

test('piReadiness：没装 = 未安装', async () => {
  assert.deepEqual((await piReadiness('/nonexistent/pi-xyz').probe()).readiness, { state: 'unavailable', reason: '未安装' });
});

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 假 pi：--version 成功、rpc 报一个模型、list 按参数决定有没有 pi-mcp-adapter。 */
async function fakePi(listOutput: string, version = '0.1.0'): Promise<{ command: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-pi-'));
  const command = join(dir, 'pi');
  await writeFile(
    command,
    `#!/bin/sh
case "$1" in
  --version) echo ${version} ;;
  list) printf '%s\\n' ${JSON.stringify(listOutput)} ;;
  --mode) cat >/dev/null; echo '{"command":"get_available_models","data":{"models":[{"id":"m","provider":"p"}]}}'; echo '{"command":"get_state","data":{"model":{"id":"m","provider":"p"}}}' ;;
esac
`
  );
  await chmod(command, 0o755);
  return { command, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('piReadiness：装了 pi-mcp-adapter 就是干净的 ready；没装记在 lacks 里，交给 hub 按资产判', async () => {
  const withAdapter = await fakePi('User packages:\n  npm:pi-mcp-adapter');
  const without = await fakePi('User packages:\n  npm:pi-web-access');
  try {
    assert.deepEqual((await piReadiness(withAdapter.command).probe()).readiness, { state: 'ready' });
    assert.deepEqual((await piReadiness(without.command).probe()).readiness, { state: 'ready', lacks: ['mcp-adapter'] });
  } finally {
    await withAdapter.cleanup();
    await without.cleanup();
  }
});

test('piReadiness：Pi 0.99+ 自带 MCP，没装适配器也是干净的 ready', async () => {
  const modern = await fakePi('No packages installed.', '1.4.0');
  try {
    assert.deepEqual((await piReadiness(modern.command).probe()).readiness, { state: 'ready' });
  } finally {
    await modern.cleanup();
  }
});
