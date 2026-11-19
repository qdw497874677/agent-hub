import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDiff, gutterWidth, lineNumbers, MAX_PAIR_LINES, pairLines, sliceTokens, wordSegments, type WordSegment } from './diff-words.ts';
import type { DiffLine } from './tool-format.ts';

const seg = (text: string, changed: boolean): WordSegment => ({ text, changed });
const join = (segments: readonly WordSegment[]) => segments.map((s) => s.text).join('');
const changedText = (segments: readonly WordSegment[]) =>
  segments
    .filter((s) => s.changed)
    .map((s) => s.text)
    .join('|');

test('词级比较：只改一个数字，变的是那个数字', () => {
  assert.deepEqual(wordSegments('const b = 2;', 'const b = 4;'), {
    removed: [seg('const b = ', false), seg('2', true), seg(';', false)],
    added: [seg('const b = ', false), seg('4', true), seg(';', false)]
  });
});

test('词级比较：插入紧贴公共尾巴时，删的那边不该多标一处', () => {
  // `2;` → `20;` 是插入一个 0，不是「删分号 + 加 0;」
  const { removed, added } = wordSegments('const a = 1;', 'const a = 10;');
  assert.equal(changedText(removed), '');
  assert.deepEqual(added, [seg('const a = 1', false), seg('0', true), seg(';', false)]);
});

test('词级比较：两边拼回去和原文一致', () => {
  for (const [before, after] of [
    ['a + b', 'a + b + c'],
    ['left();', 'right();'],
    ['今天天气不错', '今天天气很好'],
    ['', 'new();'],
    ['gone();', '']
  ]) {
    const { removed, added } = wordSegments(before!, after!);
    assert.equal(join(removed), before);
    assert.equal(join(added), after);
    assert.equal(removed.every((s) => s.text !== ''), true);
    assert.equal(added.every((s) => s.text !== ''), true);
  }
});

test('词级比较：两行一样就整行未变', () => {
  assert.deepEqual(wordSegments('same();', 'same();').removed, [seg('same();', false)]);
  assert.deepEqual(wordSegments('same();', 'same();').added, [seg('same();', false)]);
});

test('词级比较：中间那段太长就不再逐字比（整段算变）', () => {
  const before = 'x'.repeat(1200);
  const after = 'y'.repeat(1200);
  assert.deepEqual(wordSegments(before, after).added, [seg(after, true)]);
});

test('配对：相邻的 - 块与 + 块逐行配；多出来的行整行加深', () => {
  const lines: DiffLine[] = [
    { sign: '-', text: 'const a = 2;' },
    { sign: '-', text: 'const b = 2;' },
    { sign: '+', text: 'const a = 4;' },
    { sign: '+', text: 'const b = 2;' },
    { sign: '+', text: 'const c = 3;' }
  ];
  const highlights = pairLines(lines);
  assert.deepEqual(highlights[0], [seg('const a = ', false), seg('2', true), seg(';', false)]);
  assert.deepEqual(highlights[1], [seg('const b = 2;', false)]);
  assert.deepEqual(highlights[2], [seg('const a = ', false), seg('4', true), seg(';', false)]);
  assert.equal(highlights[4], 'whole');
});

test('配对：纯新增 / 纯删除的块不加深（整片新文件不能糊成一块绿）', () => {
  const lines: DiffLine[] = [
    { sign: ' ', text: 'keep' },
    { sign: '-', text: 'gone' },
    { sign: '@', text: '@@' },
    { sign: '+', text: 'fresh' },
    { sign: '+', text: 'more' }
  ];
  assert.deepEqual(pairLines(lines), [null, null, null, null, null]);
});

test('配对：行数超上限就整体退回整行底色（见文件头的原因）', () => {
  const lines: DiffLine[] = Array.from({ length: MAX_PAIR_LINES + 1 }, (_, i) => ({ sign: '-', text: `l${i}` }) as DiffLine);
  assert.equal(pairLines(lines).every((highlight) => highlight === null), true);
});

test('行号：按 hunk 头起点数，- 只占旧侧、+ 只占新侧', () => {
  const lines: DiffLine[] = [
    { sign: '@', text: '@@ -98,3 +98,4 @@ fn()' },
    { sign: ' ', text: 'same' },
    { sign: '-', text: 'old' },
    { sign: '+', text: 'new' },
    { sign: '+', text: 'extra' }
  ];
  assert.deepEqual(lineNumbers(lines), [
    { old: null, new: null },
    { old: 98, new: 98 },
    { old: 99, new: null },
    { old: null, new: 99 },
    { old: null, new: 100 }
  ]);
});

test('行号：识别不出的 @@（工具参数里的分隔线）不拨计数', () => {
  const lines: DiffLine[] = [
    { sign: '-', text: 'a' },
    { sign: '-', text: 'b' },
    { sign: '@', text: '@@' },
    { sign: '+', text: 'c' }
  ];
  assert.deepEqual(lineNumbers(lines), [
    { old: 1, new: null },
    { old: 2, new: null },
    { old: null, new: null },
    { old: null, new: 1 }
  ]);
});

test('行号列宽按最长行号算，至少 1ch', () => {
  assert.equal(gutterWidth(0), '1ch');
  assert.equal(gutterWidth(9), '1ch');
  assert.equal(gutterWidth(10), '2ch');
  assert.equal(gutterWidth(1200), '4ch');
});

test('analyzeDiff：行号、分段、宽度一次给全', () => {
  const lines: DiffLine[] = [
    { sign: '@', text: '@@ -118,2 +118,2 @@' },
    { sign: '-', text: 'const port = 80;' },
    { sign: '+', text: 'const port = 90;' }
  ];
  const { rows, gutter } = analyzeDiff(lines);
  assert.equal(gutter, '3ch');
  assert.deepEqual(rows[1], { old: 118, new: null, highlight: [seg('const port = ', false), seg('8', true), seg('0;', false)] });
  assert.deepEqual(rows[2], { old: null, new: 118, highlight: [seg('const port = ', false), seg('9', true), seg('0;', false)] });
});

test('切 token：按字符边界切开，颜色跟原 token 走', () => {
  const tokens = [
    { content: 'const ', color: '#1' },
    { content: 'port', color: '#2' },
    { content: ' = 80;', color: '#3' }
  ];
  const slices = sliceTokens(tokens, [seg('const port = ', false), seg('80', true), seg(';', false)]);
  assert.deepEqual(slices, [
    { content: 'const ', color: '#1', changed: false },
    { content: 'port', color: '#2', changed: false },
    { content: ' = ', color: '#3', changed: false },
    { content: '80', color: '#3', changed: true },
    { content: ';', color: '#3', changed: false }
  ]);
  // 一个字都不丢
  assert.equal(slices.map((s) => s.content).join(''), 'const port = 80;');
});

test('切 token：分段比 token 长也不吞字', () => {
  const slices = sliceTokens([{ content: 'ab' }], [seg('abcd', true)]);
  assert.equal(slices.map((s) => s.content).join(''), 'abcd');
  assert.equal(slices.every((s) => s.changed), true);
});
