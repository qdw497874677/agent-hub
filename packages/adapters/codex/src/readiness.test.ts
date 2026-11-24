import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexReadiness } from './readiness.ts';

async function fakeCodex(body: string): Promise<{ command: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-'));
  const command = join(dir, 'codex');
  await writeFile(command, `#!/bin/sh\n${body}\n`);
  await chmod(command, 0o755);
  return { command, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('codexReadiness：ENOENT 与退出码 127 都算没装，127 保留 Codex 自己的提示', async () => {
  assert.deepEqual((await codexReadiness('/nonexistent/codex-xyz', { env: { OPENAI_API_KEY: 'x' } }).probe()).readiness, {
    state: 'unavailable',
    reason: '没装 codex（mise use -g codex@0.168.0）',
    hint: '装好后重开 worker：mise use -g codex@0.168.0'
  });
  const shim = await fakeCodex('exit 127');
  try {
    assert.deepEqual((await codexReadiness(shim.command, { env: { OPENAI_API_KEY: 'x' } }).probe()).readiness, {
      state: 'unavailable',
      reason: '没装 codex（mise use -g codex@0.168.0）',
      hint: '装好后重开 worker：mise use -g codex@0.168.0'
    });
  } finally {
    await shim.cleanup();
  }
});

test('codexReadiness：命令能跑且给了 key = ready；没 key 也没 auth.json = 没登录', async () => {
  const ok = await fakeCodex('echo codex 0.168.0');
  try {
    const ready = await codexReadiness(ok.command, { env: { OPENAI_API_KEY: 'x' }, home: '/nonexistent/home' }).probe();
    assert.deepEqual(ready.readiness, { state: 'ready' });
    assert.ok(ready.models.length > 0);
    assert.deepEqual((await codexReadiness(ok.command, { env: {}, home: '/nonexistent/home' }).probe()).readiness.state, 'unavailable');
  } finally {
    await ok.cleanup();
  }
});
