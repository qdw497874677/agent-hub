import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionListLabel } from './session-label.ts';

test('列表行：第一句话还在，即使预览里已经只剩后面的内容', () => {
  assert.equal(sessionListLabel({
    title: null,
    previewText: '',
    opening: '第一条会话：看看日志',
    index: 0
  }), '第一条会话：看看日志');
  assert.equal(sessionListLabel({
    title: null,
    previewText: '后面那句',
    opening: '第一条会话：看看日志',
    index: 0
  }), '第一条会话：看看日志');
});

test('列表行：起过名就用名字；什么都没有才是会话 N', () => {
  assert.equal(sessionListLabel({ title: '查登录 bug', previewText: '别的', opening: '第一条', index: 0 }), '查登录 bug');
  assert.equal(sessionListLabel({ title: null, previewText: '', opening: undefined, index: 0 }), '会话 1');
  assert.equal(sessionListLabel({ title: null, previewText: '  你好\n世界  ', opening: undefined, index: 1 }), '你好 世界');
});
