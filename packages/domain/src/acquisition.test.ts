import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sameAcquisitionStrategies,
  validateAcquisitionStrategies,
  type AcquisitionStrategy
} from './acquisition.ts';
import {
  BUILTIN_CHROMIUM,
  builtinStrategiesFor,
  trustedAcquisitionStrategies
} from './builtin-assets.ts';

const PLAYWRIGHT = BUILTIN_CHROMIUM.strategies.find((item) => item.id === 'playwright') as Extract<
  AcquisitionStrategy,
  { type: 'user-space-install' }
>;

const ARTIFACT = {
  packageName: BUILTIN_CHROMIUM.packageName,
  integrity: BUILTIN_CHROMIUM.integrity,
  source: 'npm' as const
};

function withLocate(locate: Record<string, unknown>): AcquisitionStrategy {
  return { ...PLAYWRIGHT, locate: { ...PLAYWRIGHT.locate, ...locate } } as AcquisitionStrategy;
}

function rejects(strategy: AcquisitionStrategy): void {
  const result = validateAcquisitionStrategies([strategy]);
  assert.equal(result.ok, false, `应该拒绝：${JSON.stringify(strategy)}`);
  if (!result.ok) assert.equal(result.error.code, 'invalid');
}

test('locate：只接受可移植的相对片段，多段内置路径仍然合法', () => {
  assert.equal(validateAcquisitionStrategies([...BUILTIN_CHROMIUM.strategies]).ok, true, '内置 locate 必须合法');
  assert.equal(validateAcquisitionStrategies([withLocate({ homeSubdir: '.cache/ms-playwright' })]).ok, true);

  for (const binaries of [['../chrome'], ['/usr/bin/chrome'], ['chrome-linux\\chrome'], ['chrome-linux//chrome'], ['chrome-linux/./chrome'], ['chrome\u0000']]) {
    rejects(withLocate({ binaries }));
  }
  for (const directoryPrefixes of [['..'], ['a/b'], ['/tmp'], ['chromium\\1234'], ['.']]) {
    rejects(withLocate({ directoryPrefixes }));
  }
  for (const homeSubdir of ['../.cache', '/tmp/ms-playwright', '.cache\\ms-playwright', 'a//b', '.']) {
    rejects(withLocate({ homeSubdir }));
  }
  for (const envRoot of ['PLAYWRIGHT-BROWSERS-PATH', 'A B', '1BAD', '']) {
    rejects(withLocate({ envRoot }));
  }
});

test('内置策略信任边界：非内置/不一致一律拒绝；没带策略的内置版本仍走内置值', () => {
  const builtin = builtinStrategiesFor(BUILTIN_CHROMIUM.componentId, BUILTIN_CHROMIUM.version);
  assert.ok(builtin?.length);

  // 普通 npm 包：不带执行策略照常安装，带了就拒绝
  assert.equal(trustedAcquisitionStrategies('demo', '1.0.0', undefined, ARTIFACT).ok, true);
  const plain = trustedAcquisitionStrategies('demo', '1.0.0', builtin, ARTIFACT);
  assert.equal(plain.ok, false);
  if (!plain.ok) assert.match(plain.error.message, /只接受内置清单/);

  // 内置组件：没带 = 用内置值（兼容老目录项 / 老任务）
  const legacy = trustedAcquisitionStrategies(BUILTIN_CHROMIUM.componentId, BUILTIN_CHROMIUM.version, undefined, ARTIFACT);
  assert.equal(legacy.ok, true);
  if (legacy.ok) assert.deepEqual(legacy.value, builtin);

  // 内置组件：逐字段一致才放行，并且返回的永远是内置值
  const supplied = structuredClone([...BUILTIN_CHROMIUM.strategies]) as AcquisitionStrategy[];
  const exact = trustedAcquisitionStrategies(BUILTIN_CHROMIUM.componentId, BUILTIN_CHROMIUM.version, supplied, ARTIFACT);
  assert.equal(exact.ok, true);
  if (exact.ok) assert.equal(exact.value, builtin, '执行时必须用内置清单的对象，不用目录里那份');

  // 任何一处被改都明确拒绝，不静默覆盖
  const tampered = structuredClone([...BUILTIN_CHROMIUM.strategies]) as AcquisitionStrategy[];
  (tampered[1] as unknown as { args: string[] }).args = ['install', 'chromium', '--with-evil'];
  const bad = trustedAcquisitionStrategies(BUILTIN_CHROMIUM.componentId, BUILTIN_CHROMIUM.version, tampered, ARTIFACT);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error.message, /不一致/);
  assert.equal(sameAcquisitionStrategies(builtin!, supplied), true);
  assert.equal(sameAcquisitionStrategies(builtin!, tampered), false);

  // id / version 不够：recipe 只能套在同包名、同钉住哈希的 npm 制品上
  for (const artifact of [
    { ...ARTIFACT, packageName: '@evil/playwright-core' },
    { ...ARTIFACT, integrity: `sha512-${'A'.repeat(86)}==` },
    { ...ARTIFACT, source: 'git' as const }
  ]) {
    const wrong = trustedAcquisitionStrategies(BUILTIN_CHROMIUM.componentId, BUILTIN_CHROMIUM.version, supplied, artifact);
    assert.equal(wrong.ok, false, `换制品来源必须拒绝：${artifact.packageName}`);
    if (!wrong.ok) assert.match(wrong.error.message, /只绑定内置包/);
  }

  // 即使目录没带策略，内置 id / 版本配上别的哈希也不能静默套用内置 recipe
  const implicitWrong = trustedAcquisitionStrategies(BUILTIN_CHROMIUM.componentId, BUILTIN_CHROMIUM.version, undefined, {
    ...ARTIFACT,
    integrity: `sha512-${'A'.repeat(86)}==`
  });
  assert.equal(implicitWrong.ok, false);
  if (!implicitWrong.ok) assert.match(implicitWrong.error.message, /只绑定内置包/);

  // 同 id 但版本不同：不属于内置清单，不能带策略
  const otherVersion = trustedAcquisitionStrategies(BUILTIN_CHROMIUM.componentId, '0.0.1', builtin, ARTIFACT);
  assert.equal(otherVersion.ok, false);
});
