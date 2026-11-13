import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directoryScope, filesInvalidationKeys, filesKeys, gitKeys, projectKeys, taskKeys, workspaceKeys } from './query-keys.ts';

test('目录归属：有工作空间用 workspaceId，老会话回退 sessionId', () => {
  assert.equal(directoryScope('wsp-1', 'ses-1'), 'wsp-1');
  assert.equal(directoryScope(null, 'ses-1'), 'ses-1');
  assert.equal(directoryScope(undefined, 'ses-1'), 'ses-1');

  assert.deepEqual(gitKeys.state('wsp-1', 'ses-1'), ['git', 'wsp-1', 'state']);
  assert.deepEqual(gitKeys.state(null, 'ses-1'), ['git', 'ses-1', 'state']);
  assert.deepEqual(gitKeys.all('wsp-1', 'ses-1'), ['git', 'wsp-1']);
});

test('文件树 / 内容 / 搜索 / context 跟着目录走', () => {
  const shared = filesKeys('wsp-1', 'ses-1');
  assert.deepEqual(shared.list('src'), ['files', 'wsp-1', 'list', 'src']);
  assert.deepEqual(shared.read('src/a.ts', true), ['files', 'wsp-1', 'read', 'src/a.ts', true]);
  assert.deepEqual(shared.find('a.ts'), ['files', 'wsp-1', 'find', 'a.ts']);
  assert.deepEqual(shared.context(), ['files', 'wsp-1', 'context']);
  assert.deepEqual(shared.dir, ['files', 'wsp-1']);

  // 没有工作空间：目录维度就是 sessionId
  const solo = filesKeys(null, 'ses-1');
  assert.deepEqual(solo.list('src'), ['files', 'ses-1', 'list', 'src']);
  assert.deepEqual(solo.read('src/a.ts', false), ['files', 'ses-1', 'read', 'src/a.ts', false]);
  assert.deepEqual(solo.find('a.ts'), ['files', 'ses-1', 'find', 'a.ts']);
  assert.deepEqual(solo.context(), ['files', 'ses-1', 'context']);
  assert.deepEqual(solo.dir, ['files', 'ses-1']);
});

test('基准决定归属：HEAD 是目录的，会话 / 某一轮是会话自有的', () => {
  const keys = filesKeys('wsp-1', 'ses-1');
  assert.deepEqual(keys.changes('head'), ['files', 'wsp-1', 'changes', 'head']);
  assert.deepEqual(keys.diff('src/a.ts', 'head'), ['files', 'wsp-1', 'diff', 'src/a.ts', 'head']);

  for (const base of ['session', 'turn', 'turn:3']) {
    assert.deepEqual(keys.changes(base), ['files', 'ses-1', 'changes', base]);
    assert.deepEqual(keys.diff('src/a.ts', base), ['files', 'ses-1', 'diff', 'src/a.ts', base]);
  }
  // turns（每轮检查点）永远是会话自己的
  assert.deepEqual(keys.turns(), ['files', 'ses-1', 'turns']);
});

test('失效前缀：共享目录时两条，没有工作空间时只有一条', () => {
  const shared = filesInvalidationKeys(filesKeys('wsp-1', 'ses-1'));
  assert.deepEqual(shared, [['files', 'wsp-1'], ['files', 'ses-1']]);

  const solo = filesInvalidationKeys(filesKeys(null, 'ses-1'));
  assert.deepEqual(solo, [['files', 'ses-1']]);
});

test('其余同源 key 的小函数', () => {
  assert.deepEqual(taskKeys.pullRequests('tsk-1'), ['task-prs', 'tsk-1']);
  assert.deepEqual(workspaceKeys.changes('wsp-1'), ['workspace-changes', 'wsp-1']);
  assert.deepEqual(projectKeys.canvas('prj-1'), ['canvas', 'prj-1']);
});
