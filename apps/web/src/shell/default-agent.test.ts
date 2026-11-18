import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentDraft,
  defaultAgentSummary,
  draftAgent,
  hasDefaultAgent,
  modelChoices,
  optionChoices,
  runtimeChoices,
  sameDefaultAgent,
  sameDraft,
  thinkingOption,
  type DefaultAgentRef,
  type RuntimeOptionLike
} from './default-agent.ts';

const opt = (id: string, choices: Record<string, string>, extra: Partial<RuntimeOptionLike> = {}): RuntimeOptionLike => ({
  id,
  choices: Object.entries(choices).map(([value, label]) => ({ kind: 'value' as const, value: { value, label } })),
  ...extra
});

test('运行时候选：agentIds 去重保序，离线机器也算，没有在线机器认领的标离线', () => {
  const choices = runtimeChoices([
    { state: 'online', agentIds: ['opencode', 'codex'], agentModels: [{ agentId: 'opencode', models: ['m'] }] },
    { state: 'offline', agentIds: ['grok'] },
    // 老 Worker 只报 agentModels，没有 agentIds
    { state: 'online', agentModels: [{ agentId: 'pi', models: [] }, { agentId: 'opencode', models: [] }] }
  ]);
  assert.deepEqual(choices, [
    { runtimeId: 'opencode', offline: false },
    { runtimeId: 'codex', offline: false },
    { runtimeId: 'grok', offline: true },
    { runtimeId: 'pi', offline: false }
  ]);
});

test('运行时候选：正在用的运行时不在任何机器上（机器下线/删了）时补一条并标离线，空白忽略', () => {
  const choices = runtimeChoices([{ state: 'online', agentIds: ['  ', 'codex '] }], ['hermes', 'codex']);
  assert.deepEqual(choices, [
    { runtimeId: 'codex', offline: false },
    { runtimeId: 'hermes', offline: true }
  ]);
});

test('模型候选：在线机器的 agentModels → 画布目录 → hub，离线机器不算，去重保序', () => {
  const models = modelChoices(
    [
      { state: 'online', agentModels: [{ agentId: 'opencode', models: ['a', 'b'] }] },
      { state: 'offline', agentModels: [{ agentId: 'opencode', models: ['离线才有'] }] },
      { state: 'online', agentModels: [{ agentId: 'codex', models: ['别家的'] }] }
    ],
    'opencode',
    [{ id: 'opencode', models: ['b', 'c'] }],
    [{ models: [{ id: 'hub-team/d' }, { id: 'a' }] }]
  );
  assert.deepEqual(models, ['a', 'b', 'c', 'hub-team/d']);
});

test('模型候选：没选运行时就是空，界面纯手填', () => {
  assert.deepEqual(modelChoices([{ state: 'online', agentIds: ['opencode'] }], '', [], []), []);
});

test('思考强度：优先按 category 认，其次按 id 兜底，boolean 开关不算', () => {
  const byCategory = [opt('reasoning', { low: '低', high: '高' }, { category: 'thought_level' }), opt('effort', { x: 'X' })];
  assert.equal(thinkingOption(byCategory)?.id, 'reasoning');
  const byId = [opt('mode', { fast: '快' }), opt('thinking', { on: '开' }), opt('sandbox', { off: '关' }, { kind: 'boolean' })];
  assert.equal(thinkingOption(byId)?.id, 'thinking');
  // 只有 boolean 的 thought_level 不当作档位下拉
  const flagOnly = [opt('effort', { a: 'A' }, { kind: 'boolean' })];
  assert.equal(thinkingOption(flagOnly), null);
  assert.equal(thinkingOption(undefined), null);
});

test('档位候选：group 拆平、空值丢弃、标签保留', () => {
  const option: RuntimeOptionLike = {
    id: 'effort',
    choices: [
      { kind: 'value', value: { value: 'low', label: '低' } },
      { kind: 'group', label: '更多', values: [{ value: 'high', label: '高' }, { value: 'low', label: '低' }, { value: '', label: '空' }] }
    ]
  };
  assert.deepEqual(optionChoices(option), [
    { value: 'low', label: '低' },
    { value: 'high', label: '高' }
  ]);
});

test('草稿 ↔ 请求体：空运行时 = null；模型去首尾空白；同运行时保留其它 options', () => {
  const stored: DefaultAgentRef = {
    runtime: 'opencode',
    model: 'gpt-5.5',
    options: { effort: 'high', preset: 'fast', sandbox: true }
  };
  const draft = agentDraft(stored, 'effort');
  assert.deepEqual(draft, { runtime: 'opencode', model: 'gpt-5.5', effort: 'high', effortKey: 'effort' });
  assert.deepEqual(draftAgent(stored, { ...draft, model: '  a  ', effort: 'low' }), {
    runtime: 'opencode',
    model: 'a',
    options: { effort: 'low', preset: 'fast', sandbox: true }
  });
  // 换了运行时：不带旧运行时的 options
  assert.deepEqual(draftAgent(stored, { ...draft, runtime: 'codex', effort: 'x' }), {
    runtime: 'codex',
    model: 'gpt-5.5',
    options: { effort: 'x' }
  });
  // 不支持思考强度：不写 options，原有 options 原样带回去
  assert.deepEqual(draftAgent(stored, { ...draft, effortKey: '', effort: '' }), stored);
  assert.equal(draftAgent(null, { ...draft, runtime: '  ' }), null);
});

test('草稿：没有 category 的老数据按 options 里的思考键读回，其它键不算', () => {
  assert.deepEqual(agentDraft({ runtime: 'codex', model: '', options: { thinking: 'low', follow: 'x' } }), {
    runtime: 'codex',
    model: '',
    effort: 'low',
    effortKey: 'thinking'
  });
  assert.deepEqual(agentDraft(null), { runtime: '', model: '', effort: '', effortKey: '' });
  assert.deepEqual(agentDraft({ runtime: 'codex', model: '', options: {} }), {
    runtime: 'codex',
    model: '',
    effort: '',
    effortKey: ''
  });
});

test('比较：草稿只看三件套；服务端值忽略 undefined 与空运行时', () => {
  const draft = { runtime: 'pi', model: 'm', effort: 'x', effortKey: 'effort' };
  assert.equal(sameDraft(draft, { ...draft, effortKey: 'other' }), true);
  assert.equal(sameDraft(draft, { ...draft, effort: 'y' }), false);
  assert.equal(hasDefaultAgent({ runtime: '  ', model: '', options: {} }), false);
  assert.equal(hasDefaultAgent(undefined), false);
  assert.equal(sameDefaultAgent(undefined, null), true);
  assert.equal(
    sameDefaultAgent({ runtime: 'pi', model: '', options: { a: '1' } }, { runtime: 'pi', model: '', options: { a: '1' } }),
    true
  );
  assert.equal(
    sameDefaultAgent({ runtime: 'pi', model: '', options: { a: '1' } }, { runtime: 'pi', model: '', options: { a: '2' } }),
    false
  );
});

test('任务详情摘要：没配 = 跟随项目；配了 = 运行时 · 模型 · 思考强度（档位有标签就用标签）', () => {
  const options = [opt('effort', { high: '高', low: '低' }, { category: 'thought_level' })];
  assert.equal(defaultAgentSummary(null), '跟随项目');
  assert.equal(defaultAgentSummary({ runtime: 'opencode', model: '', options: {} }), 'OpenCode · 运行时默认模型');
  assert.equal(
    defaultAgentSummary({ runtime: 'opencode', model: 'gpt-5.5', options: { effort: 'high' } }, options),
    'OpenCode · gpt-5.5 · 思考：高'
  );
  assert.equal(defaultAgentSummary({ runtime: 'pi', model: 'm', options: { effort: 'odd' } }), 'Pi · m · 思考：odd');
});
