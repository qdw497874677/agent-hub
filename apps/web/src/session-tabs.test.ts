import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionTabLabel, stepTab } from './session-tabs.ts';

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
