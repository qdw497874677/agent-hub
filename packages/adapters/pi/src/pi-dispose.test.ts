import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
