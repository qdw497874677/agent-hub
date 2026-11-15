import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countHits, findInText, findMatches, isTypingTarget, stepMatch } from './find-in-text.ts';

test('切段：命中和非命中交替，原文大小写不动', () => {
  const result = findInText('Hello world hello', 'hello');
  assert.equal(result.count, 2);
  assert.deepEqual(result.segments, [
    { text: 'Hello', hit: true },
    { text: ' world ', hit: false },
    { text: 'hello', hit: true }
  ]);
});

test('大小写不敏感：查询和正文都按小写比', () => {
  assert.deepEqual(findMatches('Hello World', 'WORLD'), [{ start: 6, end: 11 }]);
  assert.equal(findInText('中文 ABC 中文', 'abc').count, 1);
});

test('空查询没有任何命中，也不切段', () => {
  const result = findInText('随便一段话', '');
  assert.equal(result.count, 0);
  assert.deepEqual(result.segments, [{ text: '随便一段话', hit: false }]);
  assert.deepEqual(findInText('', '').segments, []);
});

test('没有命中时整段原样返回', () => {
  const result = findInText('一段中文', 'english');
  assert.equal(result.count, 0);
  assert.deepEqual(result.segments, [{ text: '一段中文', hit: false }]);
});

test('命中在开头或结尾时不会切出空片段', () => {
  assert.deepEqual(findInText('abcXYZ', 'abc').segments, [
    { text: 'abc', hit: true },
    { text: 'XYZ', hit: false }
  ]);
  assert.deepEqual(findInText('XYZabc', 'abc').segments, [
    { text: 'XYZ', hit: false },
    { text: 'abc', hit: true }
  ]);
});

test('不重叠地数：aaaa 里有两个 aa', () => {
  assert.equal(findInText('aaaa', 'aa').count, 2);
  assert.deepEqual(
    findInText('aaaa', 'aa').segments.map((segment) => `${segment.hit ? '+' : '-'}${segment.text}`),
    ['+aa', '+aa']
  );
});

test('多段文本累计命中数', () => {
  assert.equal(countHits(['foo bar', 'FOO', 'baz'], 'foo'), 2);
  assert.equal(countHits(['foo', 'bar'], ''), 0);
  assert.equal(countHits([], 'foo'), 0);
});

test('stepMatch：前后绕回两端，空结果保持 -1', () => {
  assert.equal(stepMatch(0, 3, 1), 1);
  assert.equal(stepMatch(2, 3, 1), 0);
  assert.equal(stepMatch(0, 3, -1), 2);
  assert.equal(stepMatch(-1, 3, 1), 0);
  assert.equal(stepMatch(-1, 3, -1), 2);
  assert.equal(stepMatch(0, 0, 1), -1);
  assert.equal(stepMatch(4, 4, 1), 1);
});

test('isTypingTarget：输入框里按 ⌘F 不拦截', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'textarea' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ isContentEditable: true, tagName: 'DIV' }), true);
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget('input'), false);
});
