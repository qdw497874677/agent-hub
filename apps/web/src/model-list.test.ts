import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupModels, providerOf, pushRecent, RECENT_HEADING } from './model-list.ts';

const items = [
  { value: 'cliproxy/kimi-k2.8-code', label: 'cliproxy/kimi-k2.8-code' },
  { value: 'openai/gpt-5', label: 'openai/gpt-5' },
  { value: 'cliproxy/glm-5', label: 'cliproxy/glm-5' },
  { value: 'local', label: 'local' }
];

test('提供方：agent 给的分组优先，否则取斜杠前缀，没有就是「其它」', () => {
  assert.equal(providerOf({ value: 'a/b', label: 'b', group: 'Anthropic' }), 'Anthropic');
  assert.equal(providerOf(items[1]!), 'openai');
  assert.equal(providerOf(items[3]!), '其它');
});

test('不筛：最近用过置顶（只留还在清单里的），其余按提供方分组、保持原顺序', () => {
  const groups = groupModels(items, '', ['openai/gpt-5', 'gone/model']);
  assert.deepEqual(
    groups.map((g) => [g.heading, g.items.map((i) => i.value)]),
    [
      [RECENT_HEADING, ['openai/gpt-5']],
      ['cliproxy', ['cliproxy/kimi-k2.8-code', 'cliproxy/glm-5']],
      ['openai', ['openai/gpt-5']],
      ['其它', ['local']]
    ]
  );
});

test('筛选：模糊匹配模型名或提供方，不再单列最近', () => {
  assert.deepEqual(
    groupModels(items, 'glm', ['openai/gpt-5']).map((g) => [g.heading, g.items.map((i) => i.value)]),
    [['cliproxy', ['cliproxy/glm-5']]]
  );
  assert.deepEqual(groupModels(items, 'openai').flatMap((g) => g.items.map((i) => i.value)), ['openai/gpt-5']);
  assert.deepEqual(groupModels(items, 'zzz'), []);
});

test('最近用过：放最前、去重、限长', () => {
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'b', 3), ['b', 'a', 'c']);
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b']);
});
