import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crumbs, decodeText, filesErrorText, filesRefetch, humanSize, languageOf, parentOf, touches, watchPaths } from './files-core.ts';

test('只有写明不在线的 503 才收成 Worker 离线', () => {
  assert.equal(filesErrorText(503, 'Worker「e2e」不在线'), 'Worker 离线');
  assert.equal(filesErrorText(503, '请求太频繁，稍后再试'), '请求太频繁，稍后再试');
  assert.equal(filesErrorText(503, 'Worker「e2e」没有及时回复改动列表'), 'Worker「e2e」没有及时回复改动列表');
  assert.equal(filesErrorText(503, 'worker 通道尚未就绪'), 'worker 通道尚未就绪');
  assert.equal(filesErrorText(503, '目录不存在：/tmp/x'), '目录不存在：/tmp/x');
  assert.equal(filesErrorText(503, undefined), '');
  assert.equal(filesErrorText(400, '路径不合法'), '路径不合法');
});

test('目录列表的刷新会取消进行中的旧请求，diff 不会', () => {
  assert.equal(filesRefetch('list').cancelRefetch, true);
  assert.equal(filesRefetch('diff').cancelRefetch, false);
  assert.equal(filesRefetch('changes').cancelRefetch, false);
  assert.equal(filesRefetch('read').cancelRefetch, false);
});

test('面包屑 / 父目录', () => {
  assert.deepEqual(crumbs('a/b').map((c) => c.path), ['', 'a', 'a/b']);
  assert.deepEqual(crumbs(''), [{ name: '根目录', path: '' }]);
  assert.equal(parentOf('a/b/c.ts'), 'a/b');
  assert.equal(parentOf('c.ts'), '');
});

test('语言 / 大小 / 解码', () => {
  assert.equal(languageOf('src/a.tsx'), 'tsx');
  assert.equal(languageOf('Dockerfile'), 'dockerfile');
  assert.equal(languageOf('LICENSE'), null);
  assert.equal(humanSize(2048), '2.0 KB');
  assert.equal(decodeText(Buffer.from('你好').toString('base64')), '你好');
});

test('订阅点：去重、含打开的文件、封顶 200；变化命中目录', () => {
  assert.deepEqual(watchPaths(['', 'src', 'src'], 'src/a.ts'), ['', 'src', 'src/a.ts']);
  assert.equal(watchPaths(Array.from({ length: 300 }, (_, i) => `d${i}`), null).length, 200);
  assert.ok(touches('src', ['src/a.ts']));
  assert.ok(!touches('src', ['src/x/a.ts']));
  assert.ok(touches('', ['a.ts']));
});

test('缓存只在没出错时给出（离线不冒充当前）', async () => {
  const { shown, FILES_QUERY } = await import('./files-core.ts');
  assert.deepEqual(shown({ data: [1], error: null }), [1]);
  assert.equal(shown({ data: [1], error: new Error('503') }), undefined);
  assert.equal(shown({ data: undefined, error: null }), undefined);
  assert.equal(FILES_QUERY.staleTime, 0);
  assert.ok(FILES_QUERY.gcTime > 0);
});
