import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_MODEL_DEFAULT_ITEM, BOT_MODEL_DEFAULT_LABEL, botModelChoices, offListModel } from './bot-models.ts';

const NATIVE = ['my-codex/zp-glm-5.3-flash', 'cliproxy/kimi-k2'];
const HUB = ['hub-team-1/glm-5', 'hub-team-1/kimi-k2'];
const MIXED = [...NATIVE, ...HUB];

test('留空是显式的一项，且不属于任何提供方分组', () => {
  assert.equal(BOT_MODEL_DEFAULT_ITEM.value, '');
  assert.equal(BOT_MODEL_DEFAULT_ITEM.label, BOT_MODEL_DEFAULT_LABEL);
  assert.match(BOT_MODEL_DEFAULT_LABEL, /留空/);
  assert.equal(BOT_MODEL_DEFAULT_ITEM.group, '默认');
});

test('还没定模型（当前值为空）：两类模型都留着，不做范围收口', () => {
  const choices = botModelChoices(MIXED, '');
  assert.deepEqual(choices.items.map((item) => item.value), MIXED);
  assert.equal(choices.hidden, 0);
  assert.equal(choices.note, undefined);
});

test('当前是原生模型：hub 提供商的模型收起来，并说清为什么要新开会话', () => {
  const choices = botModelChoices(MIXED, 'cliproxy/kimi-k2');
  assert.deepEqual(choices.items.map((item) => item.value), NATIVE);
  assert.equal(choices.hidden, HUB.length);
  assert.match(choices.note ?? '', /hub 提供商的模型需要新开会话/);
});

test('当前是 hub 模型：只留同一提供商的，其余提供商和原生都收起', () => {
  const choices = botModelChoices(MIXED, 'hub-team-1/glm-5');
  assert.deepEqual(choices.items.map((item) => item.value), HUB);
  assert.equal(choices.hidden, NATIVE.length);
  assert.match(choices.note ?? '', /其他提供商的模型需要新开会话/);
});

test('清单里只有一个模型，且正是当前值：一条也不少、没有说明', () => {
  const choices = botModelChoices(['local'], 'local');
  assert.deepEqual(choices.items.map((item) => item.value), ['local']);
  assert.equal(choices.hidden, 0);
  assert.equal(choices.note, undefined);
});

test('清单外的手填值认得出来：原生下拉要补一条，否则会被当成「默认」', () => {
  assert.equal(offListModel(NATIVE, 'm-writer'), 'm-writer');
  assert.equal(offListModel(NATIVE, 'cliproxy/kimi-k2'), null);
  assert.equal(offListModel([], 'm-writer'), 'm-writer');
});

test('留空永远不算「清单外」：它就是默认', () => {
  assert.equal(offListModel(NATIVE, ''), null);
  assert.equal(offListModel([], ''), null);
});
