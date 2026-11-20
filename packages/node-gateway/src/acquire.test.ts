import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_CHROMIUM, isPlaywrightMcp, withExecutableArg, withPlaywrightExecutable, type AcquisitionStrategy } from '@agent-hub/domain';
import {
  findLocatedBinary,
  listSystemBinaryCandidates,
  runAcquisitionStrategies,
  verifyBinary,
  type AcquireHooks,
  type CommandRunner
} from './acquire.ts';

const SYSTEM = BUILTIN_CHROMIUM.strategies.find((s) => s.type === 'detect-system-binary')!;
const PLAYWRIGHT = BUILTIN_CHROMIUM.strategies.find((s) => s.id === 'playwright')!;
const SHELL = BUILTIN_CHROMIUM.strategies.find((s) => s.id === 'headless-shell')!;

function isolated(): { home: string; browsers: string; bin: string; dispose: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'ah-acq-home-'));
  const browsers = mkdtempSync(join(tmpdir(), 'ah-acq-pw-'));
  const bin = mkdtempSync(join(tmpdir(), 'ah-acq-bin-'));
  return {
    home,
    browsers,
    bin,
    dispose: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(browsers, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  };
}

function stub(path: string): void {
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
}

test('系统候选：只扫注入路径和 PATH，不碰策略里的默认 /usr 或真实缓存', () => {
  const f = isolated();
  try {
    const chrome = join(f.bin, 'chromium');
    stub(chrome);
    stub(join(f.bin, 'not-a-browser'));
    const hooks: AcquireHooks = {
      env: { PATH: f.bin, HOME: f.home, PLAYWRIGHT_BROWSERS_PATH: f.browsers },
      run: async () => '',
      includeListedPaths: false
    };
    const found = listSystemBinaryCandidates(SYSTEM, hooks);
    assert.deepEqual(found, [chrome]);
    assert.ok(!found.some((path) => path.startsWith('/usr/')), '关掉 listed paths 后不应扫到 /usr');
  } finally {
    f.dispose();
  }
});

test('探测系统二进制：验证命令成功才采用；失败则试下一个', async () => {
  const f = isolated();
  try {
    const bad = join(f.bin, 'google-chrome');
    const good = join(f.bin, 'chromium');
    stub(bad);
    stub(good);
    const launched: string[] = [];
    const run: CommandRunner = async (file) => {
      launched.push(file);
      if (file === bad) throw new Error('exit 127');
      return '<html></html>';
    };
    const hooks: AcquireHooks = {
      env: { PATH: f.bin, HOME: f.home, PLAYWRIGHT_BROWSERS_PATH: f.browsers },
      run,
      includeListedPaths: false
    };
    const outcome = await runAcquisitionStrategies({
      hooks,
      strategies: [SYSTEM],
      componentId: 'chromium',
      capability: 'browser:chromium',
      cwd: f.home,
      install: async () => undefined
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.acquisition.strategy, 'system');
      assert.equal(outcome.acquisition.type, 'detect-system-binary');
      assert.equal(outcome.acquisition.path, good);
    }
    assert.deepEqual(launched, [bad, good]);
  } finally {
    f.dispose();
  }
});

test('验证使用独立 user-data-dir，不把 HOME 当用户配置', async () => {
  const f = isolated();
  try {
    const chrome = join(f.bin, 'chromium');
    stub(chrome);
    let userData = '';
    const hooks: AcquireHooks = {
      env: { PATH: f.bin, HOME: f.home },
      includeListedPaths: false,
      run: async (_file, args) => {
        userData = args.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length) ?? '';
        assert.ok(userData);
        assert.ok(!userData.startsWith(f.home), '不能用用户 HOME 当 Chrome 配置');
        return '';
      }
    };
    assert.equal(await verifyBinary(hooks, chrome, SYSTEM.verify?.args ?? []), true);
  } finally {
    f.dispose();
  }
});

test('定位：认 chromium 与 chrome-headless-shell，且互不误认', () => {
  const f = isolated();
  try {
    mkdirSync(join(f.browsers, 'chromium-1234', 'chrome-linux'), { recursive: true });
    writeFileSync(join(f.browsers, 'chromium-1234', 'chrome-linux', 'chrome'), 'x');
    mkdirSync(join(f.browsers, 'chromium_headless_shell-5678', 'chrome-headless-shell-linux64'), { recursive: true });
    writeFileSync(join(f.browsers, 'chromium_headless_shell-5678', 'chrome-headless-shell-linux64', 'chrome-headless-shell'), 'y');
    assert.equal(
      findLocatedBinary(f.browsers, PLAYWRIGHT.locate),
      join(f.browsers, 'chromium-1234', 'chrome-linux', 'chrome')
    );
    assert.equal(
      findLocatedBinary(f.browsers, SHELL.locate),
      join(f.browsers, 'chromium_headless_shell-5678', 'chrome-headless-shell-linux64', 'chrome-headless-shell')
    );
    assert.equal(findLocatedBinary(join(f.home, 'no-such'), PLAYWRIGHT.locate), null);
  } finally {
    f.dispose();
  }
});

test('策略顺序：系统二进制可用则不下载；否则用户空间安装；再否则轻量退路；都缺库才失败并点名要 root', async () => {
  const f = isolated();
  try {
    const chrome = join(f.bin, 'chromium');
    stub(chrome);
    const installs: string[][] = [];
    const hooksFor = (systemOk: boolean, missing: Record<string, string>): AcquireHooks => ({
      env: { PATH: systemOk ? f.bin : '', HOME: f.home, PLAYWRIGHT_BROWSERS_PATH: f.browsers },
      includeListedPaths: false,
      run: async (file, args) => {
        if (file === chrome) {
          if (!systemOk) throw new Error('should not launch system chrome');
          return '';
        }
        if (args[0] === '-c') {
          const bin = args.slice(3)[0] ?? '';
          return missing[bin] ?? missing['*'] ?? '';
        }
        return '';
      }
    });
    const plant = (kind: 'playwright' | 'headless-shell') => {
      if (kind === 'playwright') {
        mkdirSync(join(f.browsers, 'chromium-1', 'chrome-linux'), { recursive: true });
        writeFileSync(join(f.browsers, 'chromium-1', 'chrome-linux', 'chrome'), 'x');
      } else {
        mkdirSync(join(f.browsers, 'chromium_headless_shell-1', 'chrome-headless-shell-linux64'), { recursive: true });
        writeFileSync(join(f.browsers, 'chromium_headless_shell-1', 'chrome-headless-shell-linux64', 'chrome-headless-shell'), 'y');
      }
    };
    const install = async (args: readonly string[]) => {
      installs.push([...args]);
      if (args.includes('chromium-headless-shell') || args.includes('--only-shell')) plant('headless-shell');
      else if (args.includes('chromium')) plant('playwright');
    };
    const run = (hooks: AcquireHooks) =>
      runAcquisitionStrategies({
        hooks,
        strategies: BUILTIN_CHROMIUM.strategies as unknown as AcquisitionStrategy[],
        componentId: 'chromium',
        capability: 'browser:chromium',
        cwd: f.home,
        install
      });

    const system = await run(hooksFor(true, {}));
    assert.equal(system.ok, true);
    if (system.ok) {
      assert.equal(system.acquisition.strategy, 'system');
      assert.equal(system.acquisition.path, chrome);
    }
    assert.equal(installs.length, 0, '系统二进制成功时不应下载');

    rmSync(f.browsers, { recursive: true, force: true });
    mkdirSync(f.browsers);
    installs.length = 0;
    const pw = await run(hooksFor(false, {}));
    assert.equal(pw.ok, true);
    if (pw.ok) {
      assert.equal(pw.acquisition.strategy, 'playwright');
      assert.equal(pw.acquisition.type, 'user-space-install');
      assert.ok(pw.acquisition.path?.endsWith(join('chromium-1', 'chrome-linux', 'chrome')));
    }
    assert.deepEqual([...installs], [['install', 'chromium']]);

    rmSync(f.browsers, { recursive: true, force: true });
    mkdirSync(f.browsers);
    installs.length = 0;
    const pwChrome = join(f.browsers, 'chromium-1', 'chrome-linux', 'chrome');
    const shell = await run(hooksFor(false, { [pwChrome]: '  libnss3.so => not found\n' }));
    assert.equal(shell.ok, true);
    if (shell.ok) {
      assert.equal(shell.acquisition.strategy, 'headless-shell');
      assert.equal(shell.acquisition.type, 'lighter-variant');
      assert.match(shell.message, /headless-shell/);
    }
    assert.ok(installs.some((args) => args.includes('chromium-headless-shell') || args.includes('--only-shell')));

    rmSync(f.browsers, { recursive: true, force: true });
    mkdirSync(f.browsers);
    installs.length = 0;
    const failed = await run(hooksFor(false, { '*': '  libnss3.so => not found\n\tlibnspr4.so => not found' }));
    assert.equal(failed.ok, false);
    if (!failed.ok) {
      assert.deepEqual(failed.missingDeps, ['libnspr4.so', 'libnss3.so']);
      assert.match(failed.message, /root/);
      assert.match(failed.message, /install-deps chromium/);
      assert.match(failed.message, /libnss3\.so/);
    }
  } finally {
    f.dispose();
  }
});

test('MCP 可执行路径改写：按 binding 的 executableArg 去掉旧值再追加', () => {
  assert.equal(isPlaywrightMcp({ name: 'playwright', args: ['-y', '@playwright/mcp@0.0.85'] }), true);
  assert.equal(isPlaywrightMcp({ name: 'docs', args: ['-y', '@upstash/context7-mcp@4.6.0'] }), false);
  const args = withPlaywrightExecutable(['-y', '@playwright/mcp@0.0.85', '--headless', '--executable-path', '/old', '--isolated'], '/usr/bin/chromium');
  assert.deepEqual(args, ['-y', '@playwright/mcp@0.0.85', '--headless', '--isolated', '--executable-path', '/usr/bin/chromium']);
  assert.deepEqual(
    withExecutableArg(['--foo', 'x'], '--executable-path', '/opt/chrome'),
    ['--foo', 'x', '--executable-path', '/opt/chrome']
  );
  assert.ok(!args.includes('/old'));
});
