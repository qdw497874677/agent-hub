import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  botOptionRows,
  botOptionsProblem,
  botOptionsValue,
  botOptionsInput,
  flipBotOptionRow,
  newBotOptionRow,
  type BotOptionRow
} from './bot-options.ts';

const text = (key: string, value: string): BotOptionRow => ({ key, kind: 'text', text: value, on: false });
const toggle = (key: string, on: boolean): BotOptionRow => ({ key, kind: 'switch', text: '', on });

test('已保存的 options 还原成表单行：字符串是文本，布尔是开关', () => {
  assert.deepEqual(botOptionRows({ effort: 'high', thinking: true }), [
    text('effort', 'high'),
    toggle('thinking', true)
  ]);
  assert.deepEqual(botOptionRows(undefined), []);
});

test('键的形状不对会给中文提示，空键只在有值时报错', () => {
  assert.equal(botOptionsProblem([text('Thought_Level', 'high')]), '键只能用小写字母、数字、-、_ 和 .');
  assert.equal(botOptionsProblem([text('1mode', 'x')]), '键只能用小写字母、数字、-、_ 和 .');
  assert.equal(botOptionsProblem([text('', 'high')]), '键不能空');
  assert.equal(botOptionsProblem([newBotOptionRow()]), null);
  assert.equal(botOptionsProblem([text('a.b-c_d', 'x')]), null);
});

test('重复键算错，只报后出现的那一行', () => {
  const rows = [text('mode', 'plan'), text('mode', 'build')];
  assert.equal(botOptionsProblem(rows), '这个键重复了');
});

test('空字符串值是合法的，键不能被当成空', () => {
  const rows = [text('mode', '')];
  assert.equal(botOptionsProblem(rows), null);
  assert.deepEqual(botOptionsValue(rows), { mode: '' });
});

test('超过 16 个选项才报错', () => {
  const rows = Array.from({ length: 16 }, (_, i) => text(`opt${i}`, 'x'));
  assert.equal(botOptionsProblem(rows), null);
  assert.equal(botOptionsProblem([...rows, text('opt16', 'x')]), '最多 16 个选项');
});

test('收集时跳过空键、去掉键两边的空白，开关收成布尔', () => {
  const rows = [text(' mode ', 'build'), newBotOptionRow(), toggle('sandbox', false)];
  assert.deepEqual(botOptionsValue(rows), { mode: 'build', sandbox: false });
});

test('新建没选项就不传 options；编辑时清空传 {}', () => {
  assert.deepEqual(botOptionsInput([], false), {});
  assert.deepEqual(botOptionsInput([newBotOptionRow()], false), {});
  assert.deepEqual(botOptionsInput([], true), { options: {} });
  assert.deepEqual(botOptionsInput([text('mode', 'plan')], true), { options: { mode: 'plan' } });
});

test('文本 / 开关互换能带住当前值', () => {
  assert.deepEqual(flipBotOptionRow(text('sandbox', 'true')), toggle('sandbox', true));
  assert.deepEqual(flipBotOptionRow(text('sandbox', 'low')), toggle('sandbox', false));
  assert.deepEqual(flipBotOptionRow(toggle('sandbox', false)), text('sandbox', ''));
});
