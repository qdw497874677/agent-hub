import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePrecheck, precheckShellVars, INSTALL_PRECHECK } from './install-precheck.ts';

const ok = { os: 'Linux', arch: 'x86_64', homeWritable: true, freeKb: 10_000_000, missingTools: [], hubReachable: true, skewSec: 3 };

test('全部满足时没有问题', () => {
  assert.deepEqual(evaluatePrecheck(ok), []);
});

test('所有失败项一起列出', () => {
  const issues = evaluatePrecheck({ os: 'FreeBSD', arch: 'riscv64', homeWritable: false, freeKb: 1000, missingTools: ['tar'], hubReachable: false, skewSec: -900 });
  assert.deepEqual(issues.map((i) => i.code), ['os', 'arch', 'home', 'disk', 'tool', 'hub', 'clock']);
});

test('拿不到空间或时间时不判失败', () => {
  assert.deepEqual(evaluatePrecheck({ ...ok, freeKb: null, skewSec: null }), []);
});

test('macOS arm64 可用；边界值通过', () => {
  assert.deepEqual(evaluatePrecheck({ ...ok, os: 'Darwin', arch: 'arm64', freeKb: INSTALL_PRECHECK.minFreeKb, skewSec: 300 }), []);
});

test('shell 变量只含安全字符', () => {
  const vars = precheckShellVars();
  assert.match(vars, /^PRE_MIN_FREE_KB=1572864$/m);
  assert.doesNotMatch(vars, /[$`;|&]/);
});
