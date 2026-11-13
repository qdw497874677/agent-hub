import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStoredTab, sessionTabLabel, stepTab, storeTab } from './session-tabs.ts';

test('会话标签文字', () => {
  assert.equal(sessionTabLabel('chat'), '会话');
  assert.equal(sessionTabLabel('files', 3), '文件');
  assert.equal(sessionTabLabel('changes'), '改动');
  assert.equal(sessionTabLabel('changes', 0), '改动 0');
  assert.equal(sessionTabLabel('terminal'), '终端');
});

test('左右切换首尾循环', () => {
  assert.equal(stepTab('chat', 1), 'files');
  assert.equal(stepTab('changes', 1), 'terminal');
  assert.equal(stepTab('terminal', 1), 'chat');
  assert.equal(stepTab('chat', -1), 'terminal');
  assert.equal(stepTab('terminal', -1), 'changes');
});

const memory = (): { getItem(key: string): string | null; setItem(key: string, value: string): void } => {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
};

test('刷新后回到上次那一页', () => {
  const storage = memory();
  assert.equal(readStoredTab('s1', storage), null);
  storeTab('s1', 'terminal', storage);
  assert.equal(readStoredTab('s1', storage), 'terminal');
  assert.equal(readStoredTab('s2', storage), null, '按会话分开记');
  storeTab('s1', 'chat', storage);
  assert.equal(readStoredTab('s1', storage), 'chat');
});

test('存储里有脏值或者存储本身不可用时退回默认', () => {
  const storage = memory();
  storage.setItem('hub:session-tab:s1', 'nope');
  assert.equal(readStoredTab('s1', storage), null);
  assert.equal(readStoredTab('s1', null), null);
  storeTab('s1', 'files', null);
});
