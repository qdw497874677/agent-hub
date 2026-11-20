import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_CHROMIUM, type ComponentJobSpec } from '@agent-hub/domain';
import { hubComponentDirs, installBundle, installComponent, installsBrowser, machineToolOnly, uninstallComponent, type ComponentInstallOptions } from './components.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runCommand } from './runtime-jobs.ts';
import { npmCli, startMockRegistry, type MockRegistry } from './testing/mock-npm-registry.ts';

const SCRIPT = 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'y\')"';

function options(root: string, registry: MockRegistry, extra: Partial<ComponentInstallOptions> = {}): ComponentInstallOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    root,
    node: process.execPath,
    npm: npmCli(),
    env: { PATH: process.env['PATH'] ?? '', npm_config_registry: registry.url },
    run: async (file, args, opts) => runCommand(file, args, { ...opts, signal: AbortSignal.timeout(60_000), onLine: (line) => lines.push(line) }),
    log: (line) => lines.push(line),
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
    ignoreScripts: true,
    expectedCurrent: null,
    ...extra
  };
}

test('组件安装：暂存 → 核对锁文件 → 切换 current；升级保留上一版；卸载', { timeout: 120_000, skip: process.env['HUB_TEST_INSTALL'] !== '1' }, async () => {
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
    assert.ok(!existsSync(join(base, v1, 'node_modules', 'demo-pi-ext', 'ran.txt')), '安装脚本一律不执行（--ignore-scripts）');
    assert.equal(first.result.ignoredScripts, true);
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

test('制品被换：锁文件哈希和钉住的不符 → 丢弃暂存，current 不动', { timeout: 120_000, skip: process.env['HUB_TEST_INSTALL'] !== '1' }, async () => {
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

test('npm 失败（包不存在）→ 只删暂存，报失败', { timeout: 120_000, skip: process.env['HUB_TEST_INSTALL'] !== '1' }, async () => {
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

test('整套安装（P3）：任何一个核对失败 → 一个都不切换；全部通过才一起切换', { timeout: 120_000, skip: process.env['HUB_TEST_INSTALL'] !== '1' }, async () => {
  const registry = await startMockRegistry([
    { name: 'demo-pi-ext', version: '1.0.0' },
    { name: 'other-pi-ext', version: '2.0.0' }
  ]);
  try {
    const root = mkdtempSync(join(tmpdir(), 'comp-bundle-'));
    const opts = options(root, registry);
    const a = spec(registry, '1.0.0');
    const b = spec(registry, '2.0.0', { componentId: 'other', packageName: 'other-pi-ext', resolved: `${registry.url}/-/other-pi-ext-2.0.0.tgz`, integrity: registry.integrity('other-pi-ext', '2.0.0') });
    const broken = await installBundle(opts, [a, { ...b, integrity: registry.integrity('demo-pi-ext', '1.0.0') }]);
    assert.equal(broken.ok, false);
    assert.match(broken.message, /整套安装已取消/);
    assert.equal(broken.result.integrityMismatch, true);
    assert.ok(!existsSync(join(root, 'pi', 'demo', 'current')), '第一个已经暂存好也不切换');
    assert.ok(!existsSync(join(root, 'pi', 'other', 'current')));
    const good = await installBundle(opts, [a, b]);
    assert.ok(good.ok, good.message);
    assert.equal(hubComponentDirs(root, 'pi').length, 2);
  } finally {
    await registry.close();
  }
});

test('git 来源（P4）：锁文件钉住的必须是审核时的提交；opencode 组件放在自己的运行时目录下', async () => {
  const root = mkdtempSync(join(tmpdir(), 'comp-git-'));
  const commit = 'a'.repeat(40);
  let lockCommit = commit;
  const fake: ComponentInstallOptions = {
    root,
    node: process.execPath,
    npm: '/fake/npm-cli.js',
    env: {},
    log: () => undefined,
    run: async (_file, args, opts) => {
      assert.ok(args.includes('--ignore-scripts'));
      const pkg = JSON.parse(readFileSync(join(opts.cwd, 'package.json'), 'utf8'));
      assert.equal(pkg.dependencies['oc-plugin'], `git+https://example.com/org/oc-plugin.git#${commit}`);
      mkdirSync(join(opts.cwd, 'node_modules', 'oc-plugin'), { recursive: true });
      writeFileSync(join(opts.cwd, 'node_modules', 'oc-plugin', 'package.json'), JSON.stringify({ name: 'oc-plugin', version: '0.1.0' }));
      writeFileSync(join(opts.cwd, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/oc-plugin': { version: '0.1.0', resolved: `git+ssh://git@example.com/org/oc-plugin.git#${lockCommit}` } } }));
      return '';
    }
  };
  const gitSpec: ComponentJobSpec = {
    componentId: 'oc-plugin',
    runtime: 'opencode',
    git: { url: 'https://example.com/org/oc-plugin.git', commit },
    packageName: 'oc-plugin',
    version: '0.1.0',
    resolved: `git+https://example.com/org/oc-plugin.git#${commit}`,
    integrity: `git:${commit}`,
    provides: [],
    ignoreScripts: true,
    expectedCurrent: null
  };
  lockCommit = 'b'.repeat(40);
  const moved = await installComponent(fake, gitSpec);
  assert.equal(moved.ok, false);
  assert.equal(moved.result.integrityMismatch, true);
  assert.ok(!existsSync(join(root, 'opencode', 'oc-plugin', 'current')));
  lockCommit = commit;
  const ok = await installComponent(fake, gitSpec);
  assert.ok(ok.ok, ok.message);
  assert.equal(hubComponentDirs(root, 'opencode').length, 1);
  assert.equal(hubComponentDirs(root, 'pi').length, 0);
});

test('内置浏览器组件：声明了获取策略（或旧的 playwright-core + browser:chromium）才跑选定；机器工具不交给运行时当插件加载', async () => {
  const provides = [{ capability: 'browser:chromium', mode: 'machine-tool' }];
  assert.equal(installsBrowser({ packageName: 'playwright-core', provides, strategies: [...BUILTIN_CHROMIUM.strategies] }), true);
  assert.equal(installsBrowser({ packageName: 'playwright-core', provides }), true, '旧目录项没带策略时仍认内置包名');
  assert.equal(installsBrowser({ packageName: 'evil-pkg', provides }), false, '换个包名且没有策略不行');
  assert.equal(installsBrowser({ packageName: 'playwright-core', provides: [{ capability: 'tool:x' }] }), false);
  assert.equal(machineToolOnly(provides), true);
  assert.equal(machineToolOnly([...provides, { capability: 'tool:x' }]), false);
  assert.equal(machineToolOnly([]), false);
  const root = mkdtempSync(join(tmpdir(), 'comp-tool-'));
  const V = 'v-00000000-0000-4000-8000-000000000001';
  for (const [id, pkg, prov] of [
    ['chromium', 'playwright-core', provides],
    ['demo', 'demo-pi-ext', [{ capability: 'tool:demo' }]]
  ] as const) {
    const dir = join(root, 'pi', id, V);
    mkdirSync(join(dir, 'node_modules', pkg), { recursive: true });
    writeFileSync(join(dir, '.component.json'), JSON.stringify({ id, version: '1.0.0', packageName: pkg, enabled: true, provides: prov }));
    const { symlinkSync } = await import('node:fs');
    symlinkSync(V, join(root, 'pi', id, 'current'));
  }
  assert.deepEqual(hubComponentDirs(root, 'pi').map((dir) => dir.split('/').pop()), ['demo-pi-ext']);
});

function browserSpec(integrity: string): ComponentJobSpec {
  return {
    componentId: 'chromium',
    runtime: 'pi',
    packageName: 'playwright-core',
    version: '0.55.0',
    resolved: 'https://registry.example.com/playwright-core/-/playwright-core-0.55.0.tgz',
    integrity,
    provides: [{ capability: 'browser:chromium', mode: 'machine-tool' }],
    strategies: [...BUILTIN_CHROMIUM.strategies],
    ignoreScripts: true,
    expectedCurrent: null
  };
}

function plantNpm(opts: { cwd: string }, spec: ComponentJobSpec, integrity: string): void {
  mkdirSync(join(opts.cwd, 'node_modules', 'playwright-core'), { recursive: true });
  writeFileSync(join(opts.cwd, 'node_modules', 'playwright-core', 'package.json'), JSON.stringify({ name: 'playwright-core', version: spec.version }));
  writeFileSync(join(opts.cwd, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/playwright-core': { version: spec.version, resolved: spec.resolved, integrity } } }));
}

test('内置浏览器：系统 Chromium 能无头启动则走 detect-system-binary，不下载 Playwright 浏览器，结果带 acquisition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'comp-sys-'));
  const home = mkdtempSync(join(tmpdir(), 'comp-sys-home-'));
  const browsers = mkdtempSync(join(tmpdir(), 'comp-sys-browsers-'));
  const bin = mkdtempSync(join(tmpdir(), 'comp-sys-bin-'));
  const chrome = join(bin, 'chromium');
  writeFileSync(chrome, '#!/bin/sh\n');
  chmodSync(chrome, 0o755);
  const INTEGRITY = `sha512-${'A'.repeat(44)}==`;
  const spec = browserSpec(INTEGRITY);
  const downloads: string[][] = [];
  const fake: ComponentInstallOptions = {
    root,
    node: process.execPath,
    npm: '/fake/npm-cli.js',
    env: { PATH: bin, HOME: home, PLAYWRIGHT_BROWSERS_PATH: browsers },
    acquire: { includeListedPaths: false },
    log: () => undefined,
    run: async (file, args, opts) => {
      if (file === chrome) return '<html></html>';
      if (args[0] === '-c') return '';
      if (args.includes('chromium') || args.includes('chromium-headless-shell') || args.includes('--only-shell')) {
        downloads.push([...args]);
        return '';
      }
      plantNpm(opts, spec, INTEGRITY);
      return '';
    }
  };
  const ok = await installComponent(fake, spec);
  assert.ok(ok.ok, ok.message);
  assert.equal(ok.result.acquisition?.strategy, 'system');
  assert.equal(ok.result.acquisition?.type, 'detect-system-binary');
  assert.equal(ok.result.acquisition?.path, chrome);
  assert.match(ok.message, /策略 system：/);
  assert.deepEqual(downloads, [], '有系统浏览器时不应 playwright install');
  const meta = JSON.parse(readFileSync(join(root, 'pi', 'chromium', readlinkSync(join(root, 'pi', 'chromium', 'current')), '.component.json'), 'utf8')) as { acquisition?: { strategy?: string; path?: string } };
  assert.equal(meta.acquisition?.strategy, 'system');
  assert.equal(meta.acquisition?.path, chrome);
});

test('内置浏览器缺系统库：用户空间与轻量退路都缺库 → 安装失败、不切换不钉住、报错点名要 root；修复后重装成功并带 acquisition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'comp-deps-'));
  const home = mkdtempSync(join(tmpdir(), 'comp-deps-home-'));
  const browsers = mkdtempSync(join(tmpdir(), 'comp-browsers-')); // 相当于 PLAYWRIGHT_BROWSERS_PATH，隔离的假目录，不碰真实 ~/.cache/ms-playwright
  const lines: string[] = [];
  const INTEGRITY = `sha512-${'A'.repeat(44)}==`;
  const spec = browserSpec(INTEGRITY);
  let depsFixed = false;
  const fake: ComponentInstallOptions = {
    root,
    node: process.execPath,
    npm: '/fake/npm-cli.js',
    env: { PATH: '', HOME: home, PLAYWRIGHT_BROWSERS_PATH: browsers },
    acquire: { includeListedPaths: false },
    log: (line) => lines.push(line),
    run: async (_file, args, opts) => {
      if (args[0] === '-c') return depsFixed ? '' : '  libnss3.so => not found\n\tlibnspr4.so => not found';
      if (args.includes('chromium-headless-shell') || args.includes('--only-shell')) {
        mkdirSync(join(browsers, 'chromium_headless_shell-9', 'chrome-headless-shell-linux64'), { recursive: true });
        writeFileSync(join(browsers, 'chromium_headless_shell-9', 'chrome-headless-shell-linux64', 'chrome-headless-shell'), '#!/bin/sh\n');
        return '';
      }
      if (args.includes('chromium')) {
        mkdirSync(join(browsers, 'chromium-1234', 'chrome-linux'), { recursive: true });
        writeFileSync(join(browsers, 'chromium-1234', 'chrome-linux', 'chrome'), '#!/bin/sh\n');
        return '';
      }
      plantNpm(opts, spec, INTEGRITY);
      return '';
    }
  };
  const failed = await installComponent(fake, spec);
  assert.equal(failed.ok, false);
  assert.equal(failed.refused, undefined, '缺库是失败不是拒绝（需要的是 root 装系统包，不是改策略）');
  assert.match(failed.message, /声明的获取策略都未能得到可用的可执行文件/);
  assert.match(failed.message, /libnspr4\.so、libnss3\.so/);
  assert.match(failed.message, /root/);
  assert.match(failed.message, /install-deps chromium/);
  assert.deepEqual(failed.result.missingDeps, ['libnspr4.so', 'libnss3.so']);
  assert.equal(failed.result.acquisition, undefined);
  assert.ok(lines.some((line) => line.includes('libnss3.so')), '日志里也要点名');
  assert.ok(!existsSync(join(root, 'pi', 'chromium', 'current')), '缺库不切换 current、不钉住');
  depsFixed = true;
  const ok = await installComponent(fake, spec);
  assert.ok(ok.ok, ok.message);
  assert.ok(existsSync(join(root, 'pi', 'chromium', 'current')));
  assert.equal(ok.result.missingDeps, undefined);
  assert.equal(ok.result.acquisition?.strategy, 'playwright');
  assert.equal(ok.result.acquisition?.type, 'user-space-install');
  assert.ok(ok.result.acquisition?.path?.endsWith(join('chromium-1234', 'chrome-linux', 'chrome')));
});
