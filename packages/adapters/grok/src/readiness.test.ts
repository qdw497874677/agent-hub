import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grokReadiness, parseGrokModels } from './readiness.ts';

const LOGGED_IN = 'You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n';
const LOGGED_OUT = 'You are not authenticated.\n\nDefault model: grok-4.6\n';

async function fakeGrok(output: string): Promise<{ command: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-grok-'));
  const command = join(dir, 'grok');
  await writeFile(command, `#!/bin/sh\ncat <<'OUT'\n${output}OUT\n`);
  await chmod(command, 0o755);
  return { command, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('parseGrokModels：登录状态、模型清单与默认', () => {
  assert.deepEqual(parseGrokModels(LOGGED_IN), { authenticated: true, models: ['grok-4.7', 'grok-4.6'], defaultModel: 'grok-4.7' });
  assert.equal(parseGrokModels(LOGGED_OUT).authenticated, false);
});

test('grokReadiness：登录了 = ready；没登录 = 未登录；有 XAI_API_KEY 视为能用；没装 = 未安装', async () => {
  const yes = await fakeGrok(LOGGED_IN);
  const no = await fakeGrok(LOGGED_OUT);
  try {
    const ready = await grokReadiness(yes.command, {}).probe();
    assert.deepEqual(ready.readiness, { state: 'ready' });
    assert.equal(ready.defaultModel, 'grok-4.7');
    assert.deepEqual((await grokReadiness(no.command, {}).probe()).readiness, { state: 'unavailable', reason: '未登录' });
    assert.deepEqual((await grokReadiness(no.command, { XAI_API_KEY: 'x' }).probe()).readiness, { state: 'ready' });
    assert.deepEqual((await grokReadiness('/nonexistent/grok-xyz', {}).probe()).readiness, { state: 'unavailable', reason: '未安装' });
  } finally {
    await yes.cleanup();
    await no.cleanup();
  }
});
