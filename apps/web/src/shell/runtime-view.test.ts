import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeView, versionError } from './runtime-view.ts';

test('只有机器自带：显示版本号，给「安装 hub 版本」，没有可切换的（hub 那份还没装）', () => {
  const view = runtimeView({ source: 'machine', version: '1.8.0', recommended: '2.2.2' });
  assert.equal(view.activeLabel, '机器自带 v1.8.0');
  assert.equal(view.both, false);
  assert.equal(view.other, null);
  assert.equal(view.hub, null);
  assert.deepEqual(view.install, { label: '安装 hub 版本', preset: '2.2.2' });
  assert.equal(view.notice, null);
});

test('只有机器自带、探测不到版本：只写「机器自带」，推荐版本进占位', () => {
  const view = runtimeView({ source: 'machine', recommended: '2.2.2' });
  assert.equal(view.activeLabel, '机器自带');
  assert.deepEqual(view.install, { label: '安装 hub 版本', preset: '2.2.2' });
});

test('只有机器自带、没有推荐版本（这个 agent 不能在线装）：不给安装按钮', () => {
  const view = runtimeView({ source: 'machine', version: '1.8.0' });
  assert.equal(view.activeLabel, '机器自带 v1.8.0');
  assert.equal(view.install, null);
});

test('只有 hub：显示安装版本；recommended 更新时给升级', () => {
  const view = runtimeView({ source: 'hub', version: '2.2.2', recommended: '2.3.0' });
  assert.equal(view.activeLabel, 'hub 安装 v2.2.2');
  assert.equal(view.both, false);
  assert.deepEqual(view.other, null);
  assert.deepEqual(view.hub, { version: '2.2.2', upgradeTo: '2.3.0' });
  // 已经装了 hub 那份，就没有安装入口了
  assert.equal(view.install, null);
});

test('只有 hub 且已是最新：不给升级', () => {
  assert.deepEqual(runtimeView({ source: 'hub', version: '2.2.2', recommended: '2.2.2' }).hub, { version: '2.2.2', upgradeTo: null });
});

test('两份都有、hub 生效：hub 加「生效中」，机器自带是可选项', () => {
  const view = runtimeView({ source: 'hub', hubVersion: '2.2.2', machineVersion: '1.8.0', recommended: '2.2.2' });
  assert.equal(view.activeLabel, 'hub v2.2.2');
  assert.equal(view.both, true);
  assert.deepEqual(view.other, { side: 'machine', label: '机器自带 v1.8.0', button: '改用机器自带' });
  assert.deepEqual(view.hub, { version: '2.2.2', upgradeTo: null });
  assert.equal(view.install, null);
});

test('两份都有、机器自带生效：反过来显示，切换目标变成 hub', () => {
  const view = runtimeView({ source: 'machine', version: '1.8.0', hubVersion: '2.2.2', recommended: '2.2.2' });
  assert.equal(view.activeLabel, '机器自带 v1.8.0');
  assert.deepEqual(view.other, { side: 'hub', label: 'hub v2.2.2', button: '改用 hub v2.2.2' });
  // hub 那份装着，升级 / 卸载照样给
  assert.deepEqual(view.hub, { version: '2.2.2', upgradeTo: null });
  assert.equal(view.install, null);
});

test('都没有：未安装 + 安装入口（沿用原来的只有推荐版本才给装）', () => {
  const view = runtimeView({ source: 'missing', recommended: '2.2.2' });
  assert.equal(view.activeLabel, '未安装');
  assert.deepEqual(view.install, { label: '安装', preset: '2.2.2' });
  assert.equal(view.hub, null);
  assert.equal(runtimeView({ source: 'missing' }).install, null);
});

test('装不了的时候：blocker 说明原因，不给安装按钮', () => {
  const view = runtimeView({ source: 'machine', version: '1.8.0', recommended: '2.2.2', blocker: '没有 npm' });
  assert.equal(view.install, null);
  assert.equal(view.blocker, '没有 npm');
  assert.equal(view.notice, null);
});

test('偏好 hub 但机器上还没装：提示先装一份，机器自带的仍然生效', () => {
  const view = runtimeView({ source: 'machine', version: '1.8.0', recommended: '2.2.2', preference: 'hub' });
  assert.equal(view.activeLabel, '机器自带 v1.8.0');
  assert.equal(view.notice, '已选 hub 版本，但机器上还没装，先装一份');
  assert.deepEqual(view.install, { label: '安装 hub 版本', preset: '2.2.2' });
});

test('偏好机器自带但 hub 还在生效：照 source 显示，并说明下次会话才换', () => {
  const view = runtimeView({ source: 'hub', hubVersion: '2.2.2', machineVersion: '1.8.0', preference: 'machine' });
  assert.equal(view.active, 'hub');
  assert.equal(view.activeLabel, 'hub v2.2.2');
  assert.deepEqual(view.other, { side: 'machine', label: '机器自带 v1.8.0', button: '改用机器自带' });
  assert.equal(view.notice, '已选机器自带，下次新建的会话才换');
});

test('偏好机器自带、机器上却探测不到了：不硬说「已选机器自带」', () => {
  const view = runtimeView({ source: 'hub', hubVersion: '2.2.2', preference: 'machine' });
  assert.equal(view.other, null);
  assert.equal(view.notice, null);
});

test('偏好与生效来源一致：不多说一句', () => {
  assert.equal(runtimeView({ source: 'hub', version: '2.2.2', preference: 'hub' }).notice, null);
  assert.equal(runtimeView({ source: 'machine', version: '1.8.0', preference: 'machine' }).notice, null);
});

test('版本输入：空着用推荐版本，x.y.z 之外就地报错', () => {
  assert.equal(versionError('', '2.2.2'), null);
  assert.equal(versionError(' 2.2.2 ', '2.2.2'), null);
  assert.equal(versionError('1.4.0', null), null);
  assert.equal(versionError('', null), '版本号要写成 2.2.2 这样');
  assert.equal(versionError('2.2', '2.2.2'), '版本号要写成 2.2.2 这样');
  assert.equal(versionError('v2.2.2', '2.2.2'), '版本号要写成 2.2.2 这样');
  assert.equal(versionError('2.2.2; rm -rf /', '2.2.2'), '版本号要写成 2.2.2 这样');
});
