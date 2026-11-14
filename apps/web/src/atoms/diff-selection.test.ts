import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendRef, inSelection, normalizeRefPath, parsePatchLines, selectionRange, selectionRef, toggleLine, type LineSelection } from './diff-selection.ts';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@ const keep = () => {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
  '\\ No newline at end of file',
  ''
].join('\n');

test('hunk 头：解析起点和函数名，行号从它开始数', () => {
  const rows = parsePatchLines(PATCH);
  const hunk = rows.find((row) => row.kind === 'hunk');
  assert.ok(hunk);
  assert.equal(hunk.text, '@@ -1,4 +1,5 @@ const keep = () => {');
  assert.equal(hunk.heading, 'const keep = () => {');
  assert.equal(hunk.oldLine, undefined);
  assert.equal(hunk.newLine, undefined);
});

test('文件头是 meta，不会被当成删除 / 新增行', () => {
  const rows = parsePatchLines(PATCH);
  assert.deepEqual(rows.slice(0, 4).map((row) => row.kind), ['meta', 'meta', 'meta', 'meta']);
  assert.equal(rows[2]?.text, '--- a/src/a.ts');
  assert.equal(rows[3]?.text, '+++ b/src/a.ts');
  // `\ No newline at end of file` 也不占行号
  assert.equal(rows.at(-1)?.kind, 'meta');
  assert.equal(rows.filter((row) => row.kind === 'removed').length, 1);
  assert.equal(rows.filter((row) => row.kind === 'added').length, 2);
});

test('added 只给新行号，removed 只给老行号，context 两边都有', () => {
  const rows = parsePatchLines(PATCH).filter((row) => row.kind !== 'meta' && row.kind !== 'hunk');
  assert.deepEqual(
    rows.map((row) => [row.kind, row.text, row.oldLine ?? null, row.newLine ?? null]),
    [
      ['context', 'const a = 1;', 1, 1],
      ['removed', 'const b = 2;', 2, null],
      ['added', 'const b = 3;', null, 2],
      ['added', 'const c = 4;', null, 3],
      ['context', 'const d = 5;', 3, 4]
    ]
  );
});

test('多个 hunk / 多个文件：行号各按自己的起点数', () => {
  const patch = [
    'diff --git a/x.ts b/x.ts',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -10,2 +10,2 @@',
    '-old',
    '+new',
    ' tail',
    'diff --git a/y.ts b/y.ts',
    '--- a/y.ts',
    '+++ b/y.ts',
    '@@ -100 +200 @@',
    '-gone',
    '+here'
  ].join('\n');
  const rows = parsePatchLines(patch).filter((row) => row.kind === 'removed' || row.kind === 'added' || row.kind === 'context');
  assert.deepEqual(
    rows.map((row) => [row.kind, row.oldLine ?? null, row.newLine ?? null]),
    [
      ['removed', 10, null],
      ['added', null, 10],
      ['context', 11, 11],
      ['removed', 100, null],
      ['added', null, 200]
    ]
  );
  // hunk 之外的 `---` 仍是文件头
  assert.equal(parsePatchLines(patch).filter((row) => row.kind === 'meta').length, 6);
});

test('hunk 里删掉一整行 `-- x`（原文是 `--- x`）仍算删除行', () => {
  const patch = ['@@ -1,1 +0,0 @@', '--- x', 'diff --git a/z b/z'].join('\n');
  const rows = parsePatchLines(patch);
  assert.equal(rows[1]?.kind, 'removed');
  assert.equal(rows[1]?.text, '-- x');
  assert.equal(rows[1]?.oldLine, 1);
  assert.equal(rows[2]?.kind, 'meta');
});

test('没有补丁 / 只有文件头：不产生可点的行', () => {
  assert.deepEqual(parsePatchLines(''), []);
  assert.deepEqual(parsePatchLines('\n'), []);
  const rows = parsePatchLines('diff --git a/a b/a\nBinary files a/a and b/a differ\n');
  assert.deepEqual(rows.map((row) => row.kind), ['meta', 'meta']);
});

test('单行引用：path:line，不需要范围', () => {
  assert.equal(selectionRef('src/a.ts', { side: 'new', anchor: 12 }), 'src/a.ts:12');
  assert.equal(selectionRef('src/a.ts', { side: 'old', anchor: 12, end: 12 }), 'src/a.ts:12');
  assert.equal(selectionRef('src/a.ts', null), null);
  assert.equal(selectionRef('', { side: 'new', anchor: 3 }), null);
});

test('反向选也生成排好序的范围', () => {
  assert.equal(selectionRef('src/a.ts', { side: 'new', anchor: 9, end: 3 }), 'src/a.ts:3-9');
  assert.equal(selectionRef('src/a.ts', { side: 'old', anchor: 3, end: 9 }), 'src/a.ts:3-9');
  assert.deepEqual(selectionRange({ side: 'new', anchor: 9, end: 3 }), { start: 3, end: 9 });
  assert.deepEqual(selectionRange({ side: 'new', anchor: 9 }), { start: 9, end: 9 });
});

test('路径规范化：去掉前导 ./，反斜杠和重复斜杠都收成一个', () => {
  assert.equal(normalizeRefPath('./src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRefPath('././src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRefPath('src//sub///a.ts'), 'src/sub/a.ts');
  assert.equal(normalizeRefPath('src\\sub\\a.ts'), 'src/sub/a.ts');
  assert.equal(normalizeRefPath('  src/a.ts  '), 'src/a.ts');
  assert.equal(selectionRef('./src/a.ts', { side: 'new', anchor: 4, end: 6 }), 'src/a.ts:4-6');
});

test('点击成段：起始 → 结束 → 第三次重新开始', () => {
  const first = toggleLine(null, 'new', 4);
  assert.deepEqual(first, { side: 'new', anchor: 4 });
  const second = toggleLine(first, 'new', 8);
  assert.deepEqual(second, { side: 'new', anchor: 4, end: 8 });
  const third = toggleLine(second, 'new', 12);
  assert.deepEqual(third, { side: 'new', anchor: 12 });
  // 反向选
  assert.deepEqual(toggleLine({ side: 'old', anchor: 9 }, 'old', 2), { side: 'old', anchor: 9, end: 2 });
  assert.equal(selectionRef('a.ts', toggleLine({ side: 'old', anchor: 9 }, 'old', 2)), 'a.ts:2-9');
});

test('跨侧点击被拒绝：选择原样不动', () => {
  const selection: LineSelection = { side: 'new', anchor: 4 };
  assert.equal(toggleLine(selection, 'old', 7), selection);
  const ranged: LineSelection = { side: 'new', anchor: 4, end: 8 };
  assert.equal(toggleLine(ranged, 'old', 2), ranged);
});

test('无效行号不动选择', () => {
  const selection: LineSelection = { side: 'new', anchor: 4 };
  assert.equal(toggleLine(selection, 'new', 0), selection);
  assert.equal(toggleLine(selection, 'new', Number.NaN), selection);
  assert.equal(toggleLine(selection, 'new', 1.5), selection);
  assert.deepEqual(toggleLine(null, 'new', 0), null);
});

test('高亮只覆盖同一侧的选中段', () => {
  const selection: LineSelection = { side: 'new', anchor: 4, end: 6 };
  assert.ok(inSelection(selection, 'new', 4));
  assert.ok(inSelection(selection, 'new', 5));
  assert.ok(inSelection(selection, 'new', 6));
  assert.ok(!inSelection(selection, 'new', 7));
  assert.ok(!inSelection(selection, 'new', 3));
  assert.ok(!inSelection(selection, 'old', 4));
  assert.ok(!inSelection(null, 'new', 4));
});

test('引用接到草稿末尾：原有文字不动，补齐空格', () => {
  assert.equal(appendRef('', 'src/a.ts:3-9'), '@src/a.ts:3-9 ');
  assert.equal(appendRef('帮我看下', 'src/a.ts:3-9'), '帮我看下 @src/a.ts:3-9 ');
  assert.equal(appendRef('帮我看下  ', 'src/a.ts:3-9'), '帮我看下 @src/a.ts:3-9 ');
  // 已经是 @ 开头的就不会变成 @@
  assert.equal(appendRef('', '@src/a.ts:3'), '@src/a.ts:3 ');
});
