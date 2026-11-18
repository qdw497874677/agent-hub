import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterActions, type PaletteAction } from './palette.ts';

const noop = () => undefined;
const actions: PaletteAction[] = [
  { id: 'a', group: '操作', label: '新建任务', keywords: 'new task', run: noop },
  { id: 'b', group: '主题', label: '主题：浅色', keywords: 'theme light', run: noop },
  { id: 'c', group: '前往', label: '记忆', keywords: 'memory', run: noop }
];

test('空查询给全部操作，原顺序', () => {
  assert.deepEqual(filterActions(actions, '  ').map((a) => a.id), ['a', 'b', 'c']);
});

test('按名字、分组、关键词过滤，不分大小写', () => {
  assert.deepEqual(filterActions(actions, '新建').map((a) => a.id), ['a']);
  assert.deepEqual(filterActions(actions, '主题').map((a) => a.id), ['b']);
  assert.deepEqual(filterActions(actions, 'MEM').map((a) => a.id), ['c']);
  assert.deepEqual(filterActions(actions, 'zzz'), []);
});
