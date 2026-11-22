import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerInfoDto } from '@agent-hub/contract';
import { machineActions, machineUpdateView, machineVersion, type MachineActions } from './machine-actions.ts';

const DENY: MachineActions = {
  update: false,
  updateLogs: false,
  disconnect: false,
  rotateCredential: false,
  revokeCredential: false,
  installRuntime: false,
  installComponent: false,
  configureResources: false
};
const OWNER: MachineActions = { ...DENY, update: true, updateLogs: true, disconnect: true };

const machine = (patch: Record<string, unknown> = {}): WorkerInfoDto =>
  ({
    workerId: 'w1',
    label: '一台机器',
    origin: 'remote',
    state: 'online',
    capabilities: ['sessions', 'update'],
    versionStatus: 'current',
    ...patch
  }) as unknown as WorkerInfoDto;

test('actions 缺字段、值不是 true 都不算数：老 hub 上一个按钮都不出', () => {
  assert.deepEqual(machineActions(machine()), DENY);
  assert.deepEqual(machineActions(machine({ actions: { update: 'yes', disconnect: 1 } })), DENY);
  const partial = machineActions(machine({ actions: { update: true } }));
  assert.equal(partial.update, true);
  assert.equal(partial.disconnect, false);
});

test('versionStatus 只认 current / outdated，其余一律 unknown', () => {
  assert.equal(machineVersion(machine()), 'current');
  assert.equal(machineVersion(machine({ versionStatus: 'outdated' })), 'outdated');
  assert.equal(machineVersion(machine({ versionStatus: 'unknown' })), 'unknown');
  assert.equal(machineVersion(machine({ versionStatus: undefined })), 'unknown');
  assert.equal(machineVersion(null), 'unknown');
});

test('本机：和 hub 同源，没有更新动作', () => {
  assert.deepEqual(machineUpdateView(machine({ origin: 'local' }), OWNER), {
    status: '和 hub 同源，不用单独更新',
    action: 'none'
  });
});

test('不接受远程更新的机器：说清楚，不给按钮', () => {
  assert.deepEqual(machineUpdateView(machine({ capabilities: ['sessions'] }), OWNER), {
    status: '这台机器不接受远程更新',
    action: 'none'
  });
});

test('落后：主人能更新，别人只看到「等 hub 主人」', () => {
  const stale = machine({ versionStatus: 'outdated' });
  assert.deepEqual(machineUpdateView(stale, OWNER), { status: '落后于 hub 的版本', action: 'update' });
  assert.deepEqual(machineUpdateView(stale, DENY), { status: '落后于 hub 的版本', action: 'blocked-owner' });
});

test('已是最新：主人只能做一次演练，别人没有动作', () => {
  assert.deepEqual(machineUpdateView(machine(), OWNER), { status: '已是最新', action: 'trial' });
  assert.deepEqual(machineUpdateView(machine(), DENY), { status: '已是最新', action: 'none' });
});

test('版本没报上来：不写成「已是最新」，也不给按钮', () => {
  const unknown = machine({ versionStatus: 'unknown' });
  assert.deepEqual(machineUpdateView(unknown, OWNER), { status: '还没报上来版本', action: 'blocked-version' });
  assert.deepEqual(machineUpdateView(unknown, DENY), { status: '还没报上来版本', action: 'blocked-version' });
});

test('离线：先回来再核对版本，不管版本知不知道', () => {
  const offline = machine({ state: 'offline', versionStatus: 'unknown' });
  assert.deepEqual(machineUpdateView(offline, OWNER), { status: '离线，回来之后再核对版本', action: 'blocked-online' });
});

test('正在更新 / 试运行：说的是「跑着呢」，不是「等主人」', () => {
  for (const state of ['updating', 'trial']) {
    const busy = machine({ versionStatus: 'outdated', update: { state } });
    assert.deepEqual(machineUpdateView(busy, OWNER), { status: '正在更新，等它跑完', action: 'busy' });
    assert.deepEqual(machineUpdateView(busy, DENY), { status: '正在更新，等它跑完', action: 'busy' });
  }
});

test('更新失败 / 已回退：只给一个「重试」，没有再并排一个「更新」', () => {
  for (const state of ['failed', 'rolled_back']) {
    const broken = machine({ versionStatus: 'outdated', update: { state } });
    assert.deepEqual(machineUpdateView(broken, OWNER), { status: '上次更新没成功', action: 'retry' });
    assert.deepEqual(machineUpdateView(broken, DENY), { status: '上次更新没成功', action: 'none' });
  }
});
