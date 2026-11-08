import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asSessionId } from '@agent-hub/domain';
import { PiSession } from './pi-runtime.ts';

test('dispose 之后再发指令：直接拒，不抛 ERR_STREAM_WRITE_AFTER_END 打崩 worker', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = new PiSession(asSessionId('s-1'), child, []);
  await session.dispose();
  const changed = await session.changeOption('thinking', 'high');
  assert.equal(changed.ok, false);
  assert.deepEqual(await session.loadOptions(), [], '问不到就当没有可调项，进程不崩');
  child.kill('SIGKILL');
});

test('工作目录在启动前就没了：仍记失败，原因写明目录，不单写退出码 -2', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pi-missing-'));
  const missing = join(parent, 'gone');
  try {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { cwd: missing, stdio: ['pipe', 'pipe', 'pipe'] });
    const session = new PiSession(asSessionId('s-missing'), child, [], undefined, undefined, missing);
    const ended = [];
    for await (const event of session.events()) if (event.kind === 'ended') ended.push(event);
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.outcome, 'failed');
    assert.match(ended[0]?.reason ?? '', new RegExp(`工作目录不存在：${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal((ended[0]?.reason ?? '').includes('退出码 -2'), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
