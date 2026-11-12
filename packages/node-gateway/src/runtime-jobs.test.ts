import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import type { HarnessInstaller } from '@agent-hub/domain';
import { createRuntimeManager, installEnv, type RuntimeJobReport } from './runtime-jobs.ts';
import { createRuntimeStore } from './runtime-store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-jobs-'));
  dirs.push(dir);
  return dir;
};

/** 假安装器：写一个会打印版本的 sh 脚本，期间往日志里吐几行。 */
const fake = (options: { blocker?: string; fail?: boolean; printed?: string } = {}): HarnessInstaller => ({
  agentId: 'fakeagent',
  command: 'fakeagent',
  recommendedVersion: '1.0.0',
  blocker: async () => options.blocker ?? null,
  async install(version, run) {
    await run.run('/bin/sh', ['-c', 'echo downloading; echo "secret=${HUB_TOKEN:-none}"']);
    if (options.fail) throw new Error('网络不通');
    const file = join(run.dir, 'fake.sh');
    writeFileSync(file, `#!/bin/sh\necho "fakeagent ${options.printed ?? version}"\n`);
    chmodSync(file, 0o755);
    return { path: 'fake.sh', kind: 'binary' };
  }
});

async function job(
  manager: Awaited<ReturnType<typeof createRuntimeManager>>,
  action: 'install' | 'uninstall' | 'switch',
  version: string | null = null,
  source?: 'machine' | 'hub'
) {
  const reports: RuntimeJobReport[] = [];
  await manager.run({ jobId: `j${Math.random().toString(36).slice(2)}`, agentId: 'fakeagent', action, version, ...(source ? { source } : {}) }, (status) => reports.push(status));
  return reports;
}

describe('运行时任务', () => {
  it('装好：提交版本、生成 shim、日志不漏 HUB_TOKEN；再卸掉', async () => {
    const root = tempRoot();
    const store = createRuntimeStore({ root });
    let changed = 0;
    const manager = await createRuntimeManager({
      store,
      installers: [fake()],
      machineProvided: new Map([['fakeagent', false]]),
      env: { PATH: '/usr/bin:/bin', HOME: root, HUB_TOKEN: 'top-secret' },
      onChange: () => void changed++
    });
    assert.deepEqual(manager.provisions().get('fakeagent'), { source: 'missing', recommended: '1.0.0' });
    const reports = await job(manager, 'install', '1.2.3');
    const last = reports.at(-1);
    assert.equal(last?.state, 'succeeded', JSON.stringify(reports));
    assert.equal(last?.version, '1.2.3');
    const log = reports.flatMap((report) => report.lines).join('\n');
    assert.match(log, /downloading/);
    assert.match(log, /secret=none/);
    assert.doesNotMatch(log, /top-secret/);
    assert.equal(store.installed('fakeagent'), '1.2.3');
    assert.ok(existsSync(store.shimPath('fakeagent')));
    assert.match(readFileSync(store.shimPath('fakeagent'), 'utf8'), /dispatch\.mjs/);
    assert.match(spawnSync(store.shimPath('fakeagent'), [], { encoding: 'utf8' }).stdout, /fakeagent 1\.2\.3/);
    assert.equal(manager.provisions().get('fakeagent')?.source, 'hub');
    assert.equal(changed, 1);

    const removed = await job(manager, 'uninstall');
    assert.equal(removed.at(-1)?.state, 'succeeded');
    assert.equal(store.installed('fakeagent'), null);
    // 调度垫片留着：hub 版本没了，机器上也没有，运行时报「没有可用的 agent」而不是文件不存在
    assert.ok(existsSync(store.shimPath('fakeagent')));
    const empty = spawnSync(store.shimPath('fakeagent'), [], { encoding: 'utf8' });
    assert.equal(empty.status, 127);
    assert.match(empty.stderr, /没有可用的 fakeagent/);
  });

  it('装失败或版本对不上：丢掉暂存，什么都不留', async () => {
    const root = tempRoot();
    const store = createRuntimeStore({ root });
    for (const installer of [fake({ fail: true }), fake({ printed: '9.9.9' })]) {
      const manager = await createRuntimeManager({ store, installers: [installer], machineProvided: new Map([['fakeagent', false]]), env: { PATH: '/usr/bin:/bin' } });
      const reports = await job(manager, 'install', '1.0.0');
      assert.equal(reports.at(-1)?.state, 'failed');
      assert.equal(store.installed('fakeagent'), null);
    }
  });

  it('机器自带的也能装（并存）；装不了的原因原样给出', async () => {
    const store = createRuntimeStore({ root: tempRoot() });
    const machine = await createRuntimeManager({ store, installers: [fake()], machineProvided: new Map([['fakeagent', true]]) });
    assert.equal(machine.provisions().get('fakeagent')?.source, 'machine');
    // 机器自带不再阻止安装：装一份 hub 的，默认生效 hub
    const reports = await job(machine, 'install');
    assert.equal(reports.at(-1)?.state, 'succeeded');
    assert.equal(machine.provisions().get('fakeagent')?.source, 'hub');
    const blocked = await createRuntimeManager({ store: createRuntimeStore({ root: tempRoot() }), installers: [fake({ blocker: '没有 npm' })], machineProvided: new Map([['fakeagent', false]]) });
    assert.equal(blocked.provisions().get('fakeagent')?.blocker, '没有 npm');
    const refused = await job(blocked, 'install');
    assert.equal(refused.at(-1)?.state, 'refused');
    assert.equal(refused.at(-1)?.message, '没有 npm');
  });

  it('机器自带 + hub 版本并存：显示版本、默认 hub、switch 两向都通', async () => {
    const root = tempRoot();
    const store = createRuntimeStore({ root });
    const machine = join(root, 'machine-fake.sh');
    writeFileSync(machine, '#!/bin/sh\necho "fakeagent machine"\n');
    chmodSync(machine, 0o755);
    store.setMachine('fakeagent', machine);
    const manager = await createRuntimeManager({
      store,
      installers: [fake()],
      machineProvided: new Map([['fakeagent', true]]),
      machineVersions: new Map([['fakeagent', '2.0.0']]),
      env: { PATH: '/usr/bin:/bin' }
    });
    assert.deepEqual(manager.provisions().get('fakeagent'), {
      source: 'machine',
      version: '2.0.0',
      machineVersion: '2.0.0',
      recommended: '1.0.0'
    });
    // 没装 hub 的版本：switch hub 被拒
    const refused = await job(manager, 'switch', null, 'hub');
    assert.equal(refused.at(-1)?.state, 'refused');
    assert.equal(refused.at(-1)?.message, 'hub 还没装这个 agent 的版本');

    assert.equal((await job(manager, 'install', '1.2.3')).at(-1)?.state, 'succeeded');
    const both = manager.provisions().get('fakeagent');
    assert.equal(both?.source, 'hub');
    assert.equal(both?.version, '1.2.3');
    assert.equal(both?.hubVersion, '1.2.3');
    assert.equal(both?.machineVersion, '2.0.0');
    assert.equal(both?.preference, undefined);
    assert.match(spawnSync(store.shimPath('fakeagent'), [], { encoding: 'utf8' }).stdout, /fakeagent 1\.2\.3/);

    const toMachine = await job(manager, 'switch', null, 'machine');
    assert.equal(toMachine.at(-1)?.state, 'succeeded');
    assert.match(toMachine.at(-1)?.message ?? '', /机器自带/);
    assert.equal(manager.provisions().get('fakeagent')?.source, 'machine');
    assert.equal(manager.provisions().get('fakeagent')?.preference, 'machine');
    assert.equal(manager.provisions().get('fakeagent')?.version, '2.0.0');
    assert.match(spawnSync(store.shimPath('fakeagent'), [], { encoding: 'utf8' }).stdout, /fakeagent machine/);

    const toHub = await job(manager, 'switch', null, 'hub');
    assert.equal(toHub.at(-1)?.state, 'succeeded');
    assert.match(toHub.at(-1)?.message ?? '', /已切换到 hub 安装的 v1\.2\.3/);
    assert.equal(manager.provisions().get('fakeagent')?.source, 'hub');
    assert.equal(manager.provisions().get('fakeagent')?.preference, 'hub');
  });

  it('没有机器自带时 switch machine 被拒', async () => {
    const store = createRuntimeStore({ root: tempRoot() });
    const manager = await createRuntimeManager({ store, installers: [fake()], machineProvided: new Map([['fakeagent', false]]) });
    const reports = await job(manager, 'switch', null, 'machine');
    assert.equal(reports.at(-1)?.state, 'refused');
    assert.equal(reports.at(-1)?.message, '这台机器上没有自带的版本');
  });

  it('安装环境只留白名单', () => {
    const env = installEnv({ PATH: '/usr/bin', HOME: '/h', HUB_TOKEN: 'x', HUB_WORKER_CREDENTIAL: 'y', HTTPS_PROXY: 'p' }, '/opt/node/bin/node');
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'HTTPS_PROXY', 'PATH', 'SHELL']);
    assert.equal(env['PATH'], '/opt/node/bin:/usr/bin');
  });
});
