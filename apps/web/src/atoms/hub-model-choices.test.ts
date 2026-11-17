import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUB_SWITCH_NOTE, hubSwitchNote, mergeHubModelChoices, type HubModelProviderSpec } from './hub-model-choices.ts';

const value = (value: string, label = value) => ({ kind: 'value' as const, value: { value, label } });

const option = (choices: ReturnType<typeof value>[], current = 'my-codex/glm-5') => ({
  id: 'model',
  label: '模型',
  kind: 'select' as const,
  current,
  choices
});

const hub: HubModelProviderSpec[] = [
  {
    slug: 'team-1',
    name: '团队一号',
    protocol: 'openai-chat',
    models: [
      { id: 'hub-team-1/glm-5', label: 'GLM 5' },
      { id: 'hub-team-1/kimi', label: 'Kimi' }
    ]
  },
  {
    slug: 'mine',
    name: '我的',
    protocol: 'anthropic',
    models: [{ id: 'hub-mine/claude', label: 'Claude' }]
  }
];

type TestChoice =
  | { kind: 'value'; value: { value: string; label: string } }
  | { kind: 'group'; label: string; values: { value: string; label: string }[] };

const choicesOf = (merged: readonly { choices: readonly TestChoice[] }[], at = 0) => merged[at]?.choices ?? [];

test('合并：协议匹配的 hub 模型追加到末尾，顺序不变', () => {
  const spec = [option([value('my-codex/glm-5'), value('my-codex/kimi')])];
  const merged = mergeHubModelChoices(spec, hub, ['openai-chat']);
  const choices = choicesOf(merged);
  assert.equal(choices.length, 4);
  assert.deepEqual(
    choices.map((choice) => (choice.kind === 'value' ? choice.value.value : 'group')),
    ['my-codex/glm-5', 'my-codex/kimi', 'hub-team-1/glm-5', 'hub-team-1/kimi']
  );
  assert.deepEqual(merged[0]?.choices[2], { kind: 'value', value: { value: 'hub-team-1/glm-5', label: 'GLM 5' } });
  // 原对象不动
  assert.equal(spec[0]?.choices.length, 2);
});

test('合并：去重（原生清单里已有的 hub id 不重复追加，hub 内部也去重）', () => {
  const spec = [option([value('hub-team-1/glm-5'), value('my-codex/glm-5')])];
  const duplicated: HubModelProviderSpec[] = [
    hub[0] as HubModelProviderSpec,
    { ...(hub[0] as HubModelProviderSpec), models: [...(hub[0] as HubModelProviderSpec).models] }
  ];
  const choices = choicesOf(mergeHubModelChoices(spec, duplicated, ['openai-chat']));
  assert.deepEqual(
    choices.map((choice) => (choice.kind === 'value' ? choice.value.value : 'group')),
    ['hub-team-1/glm-5', 'my-codex/glm-5', 'hub-team-1/kimi']
  );
});

test('合并：拿不到协议信息（null / undefined）时不过滤，宁可多列', () => {
  const spec = [option([value('my-codex/glm-5')])];
  for (const protocols of [null, undefined]) {
    const choices = choicesOf(mergeHubModelChoices(spec, hub, protocols));
    assert.deepEqual(
      choices.map((choice) => (choice.kind === 'value' ? choice.value.value : 'group')),
      ['my-codex/glm-5', 'hub-team-1/glm-5', 'hub-team-1/kimi', 'hub-mine/claude']
    );
  }
});

test('合并：空协议数组 = agent 明说不支持 hub 提供商，一个都不加', () => {
  const spec = [option([value('my-codex/glm-5')])];
  assert.deepEqual(choicesOf(mergeHubModelChoices(spec, hub, [])).length, 1);
});

test('合并：当前值不在清单里时补在最前面', () => {
  const spec = [option([value('my-codex/kimi')], 'hub-old/gone')];
  const choices = choicesOf(mergeHubModelChoices(spec, [], null));
  assert.equal(choices.length, 2);
  assert.deepEqual(choices[0], { kind: 'value', value: { value: 'hub-old/gone', label: 'hub-old/gone' } });
});

test('合并：当前值已在清单里时不重复、不搬家', () => {
  const spec = [option([value('my-codex/kimi'), value('my-codex/glm-5')], 'my-codex/glm-5')];
  const choices = choicesOf(mergeHubModelChoices(spec, [], null));
  assert.equal(choices.length, 2);
  assert.deepEqual(choices[1], { kind: 'value', value: { value: 'my-codex/glm-5', label: 'my-codex/glm-5' } });
});

test('合并：分组的原生清单也能追加，分组原样保留', () => {
  const grouped = {
    id: 'model',
    label: '模型',
    kind: 'select' as const,
    current: 'my-codex/glm-5',
    choices: [
      { kind: 'group' as const, label: '本机', values: [{ value: 'my-codex/glm-5', label: 'GLM 5' }] }
    ]
  };
  const choices = choicesOf(mergeHubModelChoices([grouped], hub, ['anthropic']));
  assert.equal(choices[0]?.kind, 'group');
  assert.deepEqual(choices[1], { kind: 'value', value: { value: 'hub-mine/claude', label: 'Claude' } });
});

test('合并：没有 model 选项（或它是开关）时原样返回', () => {
  const spec = [
    { id: 'thought_level', label: '思考强度', kind: 'select' as const, current: 'high', choices: [value('high')] },
    { id: 'model', label: '模型', kind: 'boolean' as const, current: true, choices: [] }
  ];
  const merged = mergeHubModelChoices(spec, hub, null);
  assert.deepEqual(merged, spec);
  assert.notEqual(merged, spec);
});

test('提醒：hub 与原生模型并存时才出现', () => {
  const mixed = mergeHubModelChoices([option([value('my-codex/glm-5')])], hub, ['openai-chat']);
  assert.equal(hubSwitchNote(mixed), HUB_SWITCH_NOTE);
  assert.match(String(hubSwitchNote(mixed)), /重启/);

  const nativeOnly = [option([value('my-codex/glm-5'), value('my-codex/kimi')])];
  assert.equal(hubSwitchNote(nativeOnly), undefined);

  const hubOnly = [option([value('hub-team-1/glm-5'), value('hub-team-1/kimi')], 'hub-team-1/glm-5')];
  assert.equal(hubSwitchNote(hubOnly), undefined);
});

test('提醒：没有 model 选项 / 空清单不给提示', () => {
  assert.equal(hubSwitchNote([]), undefined);
  assert.equal(hubSwitchNote([{ id: 'thought_level', label: '思考强度', kind: 'select' as const, current: 'high', choices: [value('high')] }]), undefined);
});
