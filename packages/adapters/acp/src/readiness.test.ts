import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acpReadiness } from './readiness.ts';

test('acpReadiness：没装 = 未安装；列不出模型 = 未配置模型；列得出 = ready；超时 = 检测超时', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fake-acp-'));
  const script = async (name: string, body: string) => {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  };
  const config = (command: string) => ({ id: 'opencode', label: 'OpenCode', command, args: [], listModelsArgs: ['models'] });
  try {
    assert.deepEqual((await acpReadiness(config('/nonexistent/opencode-xyz')).probe()).readiness, { state: 'unavailable', reason: '未安装' });
    const empty = await script('empty', 'exit 0');
    assert.deepEqual((await acpReadiness(config(empty)).probe()).readiness, { state: 'unavailable', reason: '未配置模型' });
    const some = await script('some', 'echo opencode/big-pickle; echo anthropic/claude');
    const ready = await acpReadiness(config(some)).probe();
    assert.deepEqual(ready.readiness, { state: 'ready' });
    assert.deepEqual(ready.models, ['opencode/big-pickle', 'anthropic/claude']);
    const slow = await script('slow', 'sleep 5');
    assert.deepEqual((await acpReadiness(config(slow), 100).probe()).readiness, { state: 'unavailable', reason: '检测超时' });
    const failing = await script('failing', 'echo SECRET >&2; exit 3');
    const failed = await acpReadiness(config(failing)).probe();
    assert.deepEqual(failed.readiness, { state: 'unavailable', reason: '检测失败（退出码 3）' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
