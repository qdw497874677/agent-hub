import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentJobSpec } from '@agent-hub/domain';
import { hubComponentDirs, installComponent, uninstallComponent, type ComponentInstallOptions } from './components.ts';
import { runCommand } from './runtime-jobs.ts';
import { npmCli, startMockRegistry, type MockRegistry } from '../../../e2e/support/mock-npm-registry.ts';

const SCRIPT = 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'y\')"';

function options(root: string, registry: MockRegistry, extra: Partial<ComponentInstallOptions> = {}): ComponentInstallOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    root,
    node: process.execPath,
    npm: npmCli(),
    env: { PATH: process.env['PATH'] ?? '', npm_config_registry: registry.url },
    run: async (file, args, opts) => void (await runCommand(file, args, { ...opts, signal: AbortSignal.timeout(60_000), onLine: (line) => lines.push(line) })),
    log: (line) => lines.push(line),
    isRoot: false,
    lines,
    ...extra
  };
}

function spec(registry: MockRegistry, version: string, extra: Partial<ComponentJobSpec> = {}): ComponentJobSpec {
  return {
    componentId: 'demo',
    runtime: 'pi',
    packageName: 'demo-pi-ext',
    version,
    resolved: `${registry.url}/-/demo-pi-ext-${version}.tgz`,
    integrity: registry.integrity('demo-pi-ext', version),
    provides: [{ capability: 'tool:demo' }],
    ignoreScripts: false,
    expectedCurrent: null,
    ...extra
  };
}

test('组件安装：暂存 → 核对锁文件 → 切换 current；升级保留上一版；卸载', { timeout: 120_000 }, async () => {
  const registry = await startMockRegistry([
    { name: 'demo-pi-ext', version: '1.0.0', scripts: { postinstall: SCRIPT } },
    { name: 'demo-pi-ext', version: '1.1.0' }
  ]);
  try {
    const root = mkdtempSync(join(tmpdir(), 'comp-'));
    const opts = options(root, registry);
    const first = await installComponent(opts, spec(registry, '1.0.0'));
    assert.ok(first.ok, first.message);
    assert.deepEqual(first.result.scripts, [{ package: 'demo-pi-ext', script: 'postinstall' }]);
    const base = join(root, 'pi', 'demo');
    const v1 = readlinkSync(join(base, 'current'));
    assert.match(v1, /^v-/);
    assert.ok(existsSync(join(base, v1, 'node_modules', 'demo-pi-ext', 'ran.txt')), '脚本跑了');
    const meta = JSON.parse(readFileSync(join(base, v1, '.component.json'), 'utf8'));
    assert.equal(meta.version, '1.0.0');
    assert.deepEqual(hubComponentDirs(root, 'pi'), [realpathSync(join(base, v1, 'node_modules', 'demo-pi-ext'))]);

    // CAS：hub 以为没装，机器上有 1.0.0 → 拒绝
    const stale = await installComponent(opts, spec(registry, '1.1.0'));
    assert.equal(stale.refused, true);

    const second = await installComponent(opts, spec(registry, '1.1.0', { expectedCurrent: '1.0.0' }));
    assert.ok(second.ok, second.message);
    const v2 = readlinkSync(join(base, 'current'));
    assert.notEqual(v2, v1);
    assert.ok(existsSync(join(base, v1)), '上一版留着给还在跑的会话');
    assert.deepEqual(second.result.scripts, []);

    const removed = uninstallComponent(opts, spec(registry, '1.1.0', { expectedCurrent: '1.1.0' }));
    assert.ok(removed.ok);
    assert.equal(existsSync(base), false);
  } finally {
    await registry.close();
  }
});

test('制品被换：锁文件哈希和钉住的不符 → 丢弃暂存，current 不动', { timeout: 120_000 }, async () => {
  const registry = await startMockRegistry([{ name: 'demo-pi-ext', version: '1.0.0' }, { name: 'demo-pi-ext', version: '1.1.0' }]);
  try {
    const root = mkdtempSync(join(tmpdir(), 'comp-'));
    const opts = options(root, registry);
    assert.ok((await installComponent(opts, spec(registry, '1.0.0'))).ok);
    const before = readlinkSync(join(root, 'pi', 'demo', 'current'));
    const pinned = spec(registry, '1.1.0', { expectedCurrent: '1.0.0' });
    registry.tamper('demo-pi-ext', '1.1.0');
    const outcome = await installComponent(opts, pinned);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.result.integrityMismatch, true);
    assert.equal(readlinkSync(join(root, 'pi', 'demo', 'current')), before);
    assert.deepEqual(
      (await import('node:fs')).readdirSync(join(root, 'pi', 'demo')).filter((n) => n.startsWith('.staging-')),
      []
    );
  } finally {
    await registry.close();
  }
});

test('root 运行且允许脚本 → 拒绝；禁止安装脚本时 root 也能装，脚本不跑', { timeout: 120_000 }, async () => {
  const registry = await startMockRegistry([{ name: 'demo-pi-ext', version: '1.0.0', scripts: { postinstall: SCRIPT } }]);
  try {
    const root = mkdtempSync(join(tmpdir(), 'comp-'));
    const opts = options(root, registry, { isRoot: true });
    const refused = await installComponent(opts, spec(registry, '1.0.0'));
    assert.equal(refused.refused, true);
    assert.match(refused.message, /root/);
    const ok = await installComponent(opts, spec(registry, '1.0.0', { ignoreScripts: true }));
    assert.ok(ok.ok, ok.message);
    assert.equal(ok.result.ignoredScripts, true);
    const dir = readlinkSync(join(root, 'pi', 'demo', 'current'));
    assert.equal(existsSync(join(root, 'pi', 'demo', dir, 'node_modules', 'demo-pi-ext', 'ran.txt')), false);
  } finally {
    await registry.close();
  }
});

test('npm 失败（包不存在）→ 只删暂存，报失败', { timeout: 120_000 }, async () => {
  const registry = await startMockRegistry([{ name: 'other', version: '1.0.0' }]);
  try {
    const root = mkdtempSync(join(tmpdir(), 'comp-'));
    const outcome = await installComponent(options(root, registry), { ...spec(registry, '1.0.0'), integrity: `sha512-${'A'.repeat(86)}==` });
    assert.equal(outcome.ok, false);
    assert.equal(existsSync(join(root, 'pi', 'demo', 'current')), false);
  } finally {
    await registry.close();
  }
});
