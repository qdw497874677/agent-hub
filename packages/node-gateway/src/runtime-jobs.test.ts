import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function job(manager: Awaited<ReturnType<typeof createRuntimeManager>>, action: 'install' | 'uninstall', version: string | null = null) {
  const reports: RuntimeJobReport[] = [];
  await manager.run({ jobId: `j${Math.random().toString(36).slice(2)}`, agentId: 'fakeagent', action, version }, (status) => reports.push(status));
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
    assert.match(readFileSync(store.shimPath('fakeagent'), 'utf8'), /fake\.sh/);
    assert.equal(manager.provisions().get('fakeagent')?.source, 'hub');
    assert.equal(changed, 1);

    const removed = await job(manager, 'uninstall');
    assert.equal(removed.at(-1)?.state, 'succeeded');
    assert.equal(store.installed('fakeagent'), null);
    assert.ok(!existsSync(store.shimPath('fakeagent')));
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

  it('机器自带的、装不了的：拒绝', async () => {
    const store = createRuntimeStore({ root: tempRoot() });
    const machine = await createRuntimeManager({ store, installers: [fake()], machineProvided: new Map([['fakeagent', true]]) });
    assert.equal(machine.provisions().get('fakeagent')?.source, 'machine');
    assert.equal((await job(machine, 'install')).at(-1)?.state, 'refused');
    const blocked = await createRuntimeManager({ store, installers: [fake({ blocker: '没有 npm' })], machineProvided: new Map([['fakeagent', false]]) });
    assert.equal(blocked.provisions().get('fakeagent')?.blocker, '没有 npm');
    const reports = await job(blocked, 'install');
    assert.equal(reports.at(-1)?.state, 'refused');
    assert.equal(reports.at(-1)?.message, '没有 npm');
  });

  it('安装环境只留白名单', () => {
    const env = installEnv({ PATH: '/usr/bin', HOME: '/h', HUB_TOKEN: 'x', HUB_WORKER_CREDENTIAL: 'y', HTTPS_PROXY: 'p' }, '/opt/node/bin/node');
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'HTTPS_PROXY', 'PATH', 'SHELL']);
    assert.equal(env['PATH'], '/opt/node/bin:/usr/bin');
  });
});
