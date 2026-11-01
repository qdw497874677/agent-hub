import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crumbs, decodeText, humanSize, languageOf, parentOf, touches, watchPaths } from './files-core.ts';

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
