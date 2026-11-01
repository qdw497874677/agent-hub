import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionTabLabel, stepTab } from './session-tabs.ts';

test('会话标签文字', () => {
  assert.equal(sessionTabLabel('chat'), '对话');
  assert.equal(sessionTabLabel('files', 3), '文件');
  assert.equal(sessionTabLabel('changes'), '改动');
  assert.equal(sessionTabLabel('changes', 0), '改动 0');
});

test('左右切换首尾循环', () => {
  assert.equal(stepTab('chat', 1), 'files');
  assert.equal(stepTab('changes', 1), 'chat');
  assert.equal(stepTab('chat', -1), 'changes');
});
