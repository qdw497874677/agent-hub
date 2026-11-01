import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipLines, parseUnifiedDiff, toolFamily, toolFileTarget, toolSummary, toolView } from './tool-format.ts';

test('bash：认出命令', () => {
  const view = toolView('bash', '{"command":"echo hi"}');
  assert.deepEqual(view, { kind: 'shell', command: 'echo hi' });
  assert.equal(toolFamily('bash', view), 'shell');
});

test('Pi edit：edits[] 变成 -/+ 行', () => {
  const view = toolView('edit', JSON.stringify({ path: 'a.ts', edits: [{ oldText: 'x\ny', newText: 'z' }] }));
  assert.deepEqual(view, {
    kind: 'edit',
    path: 'a.ts',
    diff: [
      { sign: '-', text: 'x' },
      { sign: '-', text: 'y' },
      { sign: '+', text: 'z' }
    ]
  });
  assert.equal(toolSummary(view), 'a.ts +1 -2');
  assert.equal(toolFamily('edit', view), 'edit');
});

test('OpenCode edit：oldString/newString；write 的 content 全是 +', () => {
  assert.equal(toolView('edit', '{"filePath":"b","oldString":"1","newString":"2"}').kind, 'edit');
  const write = toolView('write', '{"path":"n.md","content":"a\\nb\\n"}');
  assert.deepEqual(write, { kind: 'edit', path: 'n.md', diff: [{ sign: '+', text: 'a' }, { sign: '+', text: 'b' }] });
});

test('read：路径 + 其它参数；认不出的原样', () => {
  assert.deepEqual(toolView('read', '{"path":"x.ts","offset":3}'), { kind: 'file', path: 'x.ts', detail: 'offset: 3' });
  assert.deepEqual(toolView('weird', 'not json'), { kind: 'raw', text: 'not json' });
});

test('统一 diff 文本解析；不是 diff 返回 null', () => {
  assert.deepEqual(parseUnifiedDiff('--- a\n+++ a\n-old\n+new'), [
    { sign: '-', text: 'old' },
    { sign: '+', text: 'new' }
  ]);
  assert.equal(parseUnifiedDiff('hello\nworld'), null);
});

test('长输出截断，报告藏了几行', () => {
  const text = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  assert.deepEqual(clipLines(text, 3), { shown: 'l0\nl1\nl2', hidden: 17 });
  assert.deepEqual(clipLines('a\n', 3), { shown: 'a', hidden: 0 });
});

test('工具参数里的路径：工作空间内可点，外面不可点', () => {
  const root = '/home/u/proj';
  assert.deepEqual(toolFileTarget('{"path":"src/a.ts"}', root), { path: 'src/a.ts', line: null });
  assert.deepEqual(toolFileTarget('{"file_path":"/home/u/proj/src/a.ts","offset":12}', root), { path: 'src/a.ts', line: 12 });
  assert.deepEqual(toolFileTarget('{"filePath":"./x/../b.md","line":"3"}', null), { path: 'b.md', line: 3 });
  assert.equal(toolFileTarget('{"path":"/home/u/project2/a"}', root), null);
  assert.equal(toolFileTarget('{"path":"/etc/passwd"}', root), null);
  assert.equal(toolFileTarget('{"path":"/home/u/proj/../x"}', root), null);
  assert.equal(toolFileTarget('{"path":"../x"}', root), null);
  assert.equal(toolFileTarget('{"path":"/home/u/proj/a"}', null), null);
  assert.equal(toolFileTarget('{"path":"~/a"}', root), null);
  assert.equal(toolFileTarget('{"path":"https://x/a"}', root), null);
  assert.equal(toolFileTarget('{"path":"/home/u/proj"}', root), null);
  assert.equal(toolFileTarget('{"command":"cat a"}', root), null);
  assert.equal(toolFileTarget('not json', root), null);
  assert.deepEqual(toolFileTarget('{"path":"a","offset":0}', root), { path: 'a', line: null });
});
