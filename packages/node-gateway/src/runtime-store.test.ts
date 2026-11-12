import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { createRuntimeStore, type RuntimeStore } from './runtime-store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-store-'));
  dirs.push(dir);
  return dir;
};

/** 假的可执行文件：打印一行，用来分辨调度垫片选中了哪份。 */
const script = (file: string, text: string): string => {
  writeFileSync(file, `#!/bin/sh\necho "${text}"\n`);
  chmodSync(file, 0o755);
  return file;
};

/** 装一份「hub 版本」：暂存目录里放脚本，再 commit 转正。 */
const installHub = (store: RuntimeStore, version: string, text: string): void => {
  const staging = store.stage('fakeagent', `job-${version}`);
  script(join(staging, 'agent.sh'), text);
  store.commit('fakeagent', version, staging, { path: 'agent.sh', kind: 'binary' }, 'fakeagent');
};

/** 跑调度垫片（参数原样透传，脚本忽略）。 */
const run = (store: RuntimeStore): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(store.shimPath('fakeagent'), ['acp'], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe('运行时 store：调度垫片', () => {
  it('只有机器自带：用机器那份', () => {
    const store = createRuntimeStore({ root: tempRoot() });
    store.setMachine('fakeagent', script(join(store.root, 'machine-agent'), 'machine 2.0.0'));
    store.writeDispatch('fakeagent', 'fakeagent');
    const result = run(store);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /machine 2\.0\.0/);
  });

  it('只有 hub 版本：用 hub 的 current', () => {
    const store = createRuntimeStore({ root: tempRoot() });
    installHub(store, '1.2.3', 'hub 1.2.3');
    const result = run(store);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /hub 1\.2\.3/);
  });

  it('两份都有：默认 hub，选了 machine 就用机器，机器那份没了再落回 hub', () => {
    const store = createRuntimeStore({ root: tempRoot() });
    const machine = script(join(store.root, 'machine-agent'), 'machine 2.0.0');
    store.setMachine('fakeagent', machine);
    installHub(store, '1.2.3', 'hub 1.2.3');
    // 这是今天的行为：没选过且 hub 装了，报/用 hub
    assert.match(run(store).stdout, /hub 1\.2\.3/);

    store.setPreference('fakeagent', 'machine');
    assert.match(run(store).stdout, /machine 2\.0\.0/);

    // 机器那份被删了（换了机器 / 用户挪走）：回落到 hub，而不是直接报错
    rmSync(machine);
    assert.match(run(store).stdout, /hub 1\.2\.3/);
  });

  it('都不可用：stderr 说明并退出 127', () => {
    const store = createRuntimeStore({ root: tempRoot() });
    store.writeDispatch('fakeagent', 'fakeagent');
    const result = run(store);
    assert.equal(result.status, 127);
    assert.match(result.stderr, /没有可用的 fakeagent/);
    assert.match(result.stderr, /请在 hub 机器页安装或恢复机器自带的版本/);
  });

  it('垫片是调度垫片，不是写死的入口', () => {
    const store = createRuntimeStore({ root: tempRoot() });
    store.writeDispatch('fakeagent', 'fakeagent');
    const body = readFileSync(store.shimPath('fakeagent'), 'utf8');
    assert.match(body, /dispatch\.mjs/);
    assert.match(body, /'fakeagent'/);
    assert.match(body, /"\$@"/);
    assert.ok(existsSync(join(store.root, 'dispatch.mjs')));
  });
});

describe('运行时 store：machine / source', () => {
  it('setMachine / preference 往返，null 清掉', () => {
    const store = createRuntimeStore({ root: tempRoot() });
    assert.equal(store.machinePath('fakeagent'), null);
    assert.equal(store.preference('fakeagent'), null);
    store.setMachine('fakeagent', '/opt/fake/agent');
    store.setPreference('fakeagent', 'hub');
    assert.equal(store.machinePath('fakeagent'), '/opt/fake/agent');
    assert.equal(store.preference('fakeagent'), 'hub');
    store.setPreference('fakeagent', 'machine');
    assert.equal(store.preference('fakeagent'), 'machine');
    store.setPreference('fakeagent', null);
    store.setMachine('fakeagent', null);
    assert.equal(store.preference('fakeagent'), null);
    assert.equal(store.machinePath('fakeagent'), null);
  });

  it('remove 清掉 hub 版本和 hub 选择，保留机器自带路径和调度垫片', () => {
    const store = createRuntimeStore({ root: tempRoot() });
    const machine = script(join(store.root, 'machine-agent'), 'machine 2.0.0');
    store.setMachine('fakeagent', machine);
    installHub(store, '1.2.3', 'hub 1.2.3');
    store.setPreference('fakeagent', 'hub');

    store.remove('fakeagent', 'fakeagent');
    assert.equal(store.installed('fakeagent'), null);
    assert.equal(store.preference('fakeagent'), null);
    assert.equal(store.machinePath('fakeagent'), machine);
    // 垫片留着：卸掉 hub 的版本后还能回落到机器自带
    assert.ok(existsSync(store.shimPath('fakeagent')));
    assert.match(run(store).stdout, /machine 2\.0\.0/);

    // 选了机器自带的：卸 hub 版本不该把这个选择也清掉
    store.setPreference('fakeagent', 'machine');
    store.remove('fakeagent', 'fakeagent');
    assert.equal(store.preference('fakeagent'), 'machine');
  });
});
