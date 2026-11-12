import assert from 'node:assert/strict';
import test from 'node:test';
import { execProbe } from './exec-probe.ts';

test('execProbe：找不到命令与退出码 127 都算没装，其它退出码算失败', async () => {
  assert.deepEqual(await execProbe('/nonexistent/agent-hub-xyz', ['--version'], 5000), { kind: 'missing' });
  // 调度垫片（ADR 0010）在 hub 与机器上都没有时用 127 退出，语义就是「这条命令不存在」。
  assert.deepEqual(await execProbe('sh', ['-c', 'exit 127'], 5000), { kind: 'missing' });
  assert.deepEqual(await execProbe('sh', ['-c', 'exit 3'], 5000), { kind: 'failed', code: 3 });
  assert.deepEqual(await execProbe('sh', ['-c', 'echo hi'], 5000), { kind: 'ok', stdout: 'hi\n' });
});
