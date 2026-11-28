import { test } from 'node:test';
import assert from 'node:assert/strict';
import { developmentManualPort, developmentServiceLabels, orderDevelopmentWorkers } from './development-service-model.ts';

test('当前机器排序在前但不改变输入顺序', () => {
  const workers = [{ id: 'a', name: 'A', state: 'online' as const }, { id: 'b', name: 'B', state: 'offline' as const }, { id: 'c', name: 'C', state: 'online' as const }];
  assert.deepEqual(orderDevelopmentWorkers(workers, 'b').map((worker) => worker.id), ['b', 'a', 'c']);
  assert.deepEqual(workers.map((worker) => worker.id), ['a', 'b', 'c']);
  assert.deepEqual(orderDevelopmentWorkers(workers, null), workers);
});
test('没有身份的服务明确只读，不重复端口', () => {
  assert.deepEqual(developmentServiceLabels({ id: null, name: '端口 3000', port: 3000, openable: false }), { title: '端口 3000', subtitle: '仅查看' });
  assert.deepEqual(developmentServiceLabels({ id: null, name: 'web', port: 3000, openable: false }), { title: 'web', subtitle: '端口 3000 · 仅查看' });
  assert.deepEqual(developmentServiceLabels({ id: 'id', name: 'web', port: 3000, openable: false }), { title: 'web', subtitle: '端口 3000 · 暂不可打开' });
});
test('手动端口必须在 1024–65535 之间', () => {
  for (const value of ['', '1023', '65536', '-1', '3000.0', '1e4']) assert.equal(developmentManualPort(value), null);
  for (const value of ['1024', '3000', '65535']) assert.equal(developmentManualPort(value), Number(value));
});
