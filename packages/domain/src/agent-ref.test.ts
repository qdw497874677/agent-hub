import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_REF_MODEL_MAX,
  AGENT_REF_OPTIONS_MAX,
  AGENT_REF_OPTION_VALUE_MAX,
  mergeAgentRef,
  sessionRef,
  validateAgentRef,
  type AgentRef
} from './agent-ref.ts';
import type { RuntimeOption } from './option.ts';
import { asAgentId, asSessionId, asTaskId } from './ids.ts';

const SPECS: readonly RuntimeOption[] = [
  {
    id: 'effort',
    label: '思考强度',
    category: 'thought_level',
    kind: 'select',
    current: 'medium',
    choices: [
      { kind: 'value', value: { value: 'low', label: '低' } },
      { kind: 'value', value: { value: 'medium', label: '中' } },
      { kind: 'value', value: { value: 'high', label: '高' } }
    ]
  },
  { id: 'sandbox', label: '沙箱', category: 'custom', kind: 'boolean', current: false, choices: [] }
];

test('AgentRef：形状校验（runtime / model / 键名 / 值类型）', () => {
  const good = validateAgentRef({
    runtime: ' opencode ',
    model: ' my-codex/go-glm-5.3 ',
    options: { effort: 'high', 'model.max_tokens': '4096', thinking_level: true }
  });
  assert.ok(good.ok, good.ok ? '' : good.error.message);
  assert.equal(good.value.runtime, 'opencode', 'runtime 去掉首尾空格');
  assert.equal(good.value.model, 'my-codex/go-glm-5.3');
  assert.deepEqual(good.value.options, { effort: 'high', 'model.max_tokens': '4096', thinking_level: true });

  assert.ok(!validateAgentRef({ runtime: '   ' }).ok, 'runtime 不能为空');
  assert.ok(!validateAgentRef({ runtime: 'pi', options: { 'Thought Level': 'high' } }).ok, '键必须小写开头');
  assert.ok(!validateAgentRef({ runtime: 'pi', options: { Effort: 'high' } }).ok, '大写开头不行');
  assert.ok(!validateAgentRef({ runtime: 'pi', options: { 'effort ': 'high' } }).ok, '键里不能有空格');
  assert.ok(!validateAgentRef({ runtime: 'pi', model: 'm'.repeat(AGENT_REF_MODEL_MAX + 1) }).ok, '模型名太长');
  assert.ok(validateAgentRef({ runtime: 'pi', model: 'm'.repeat(AGENT_REF_MODEL_MAX) }).ok);
});

test('AgentRef：选项条数与值长度上限', () => {
  const many = Object.fromEntries(Array.from({ length: AGENT_REF_OPTIONS_MAX }, (_, i) => [`k${i}`, true]));
  assert.ok(validateAgentRef({ runtime: 'pi', options: many }).ok);
  const tooMany = { ...many, extra: true };
  const rejected = validateAgentRef({ runtime: 'pi', options: tooMany });
  assert.ok(!rejected.ok);
  assert.match(rejected.error.message, new RegExp(`最多 ${AGENT_REF_OPTIONS_MAX} 个`));

  const long = validateAgentRef({ runtime: 'pi', options: { effort: 'x'.repeat(AGENT_REF_OPTION_VALUE_MAX + 1) } });
  assert.ok(!long.ok);
  assert.match(long.error.message, new RegExp(`最多 ${AGENT_REF_OPTION_VALUE_MAX} 字`));
  assert.ok(validateAgentRef({ runtime: 'pi', options: { effort: 'x'.repeat(AGENT_REF_OPTION_VALUE_MAX) } }).ok);
});

test('AgentRef：给了 specs 时核键存在与候选值', () => {
  const unknown = validateAgentRef({ runtime: 'pi', options: { nope: 'x' } }, SPECS);
  assert.ok(!unknown.ok);
  assert.match(unknown.error.message, /没有可调项 nope/);

  const badValue = validateAgentRef({ runtime: 'pi', options: { effort: 'extreme' } }, SPECS);
  assert.ok(!badValue.ok);
  assert.match(badValue.error.message, /effort 只能是 low \/ medium \/ high/);

  const wrongKind = validateAgentRef({ runtime: 'pi', options: { sandbox: 'yes' } }, SPECS);
  assert.ok(!wrongKind.ok);
  assert.match(wrongKind.error.message, /sandbox 只能是开关/);

  const boolAsSelect = validateAgentRef({ runtime: 'pi', options: { effort: true } }, SPECS);
  assert.ok(!boolAsSelect.ok, 'select 项不能给开关');

  const good = validateAgentRef({ runtime: 'pi', options: { effort: 'high', sandbox: true } }, SPECS);
  assert.ok(good.ok, good.ok ? '' : good.error.message);

  // 空 specs（agent 还没上报过）只做形状校验
  assert.ok(validateAgentRef({ runtime: 'pi', options: { nope: 'x' } }, []).ok);
});

test('mergeAgentRef：override 赢，options 浅合并', () => {
  const base: AgentRef = { runtime: 'pi', model: 'm1', options: { effort: 'low', sandbox: true } };
  const merged = mergeAgentRef(base, { model: 'm2', options: { effort: 'high' } });
  assert.equal(merged.runtime, 'pi', '没给的字段沿用 base');
  assert.equal(merged.model, 'm2');
  assert.deepEqual(merged.options, { effort: 'high', sandbox: true }, '同名键覆盖，其余保留');

  const onlyOptions = mergeAgentRef(base, { options: { extra: 'x' } });
  assert.equal(onlyOptions.model, 'm1');
  assert.deepEqual(onlyOptions.options, { effort: 'low', sandbox: true, extra: 'x' });

  const empty: AgentRef = { runtime: 'pi', model: '', options: {} };
  assert.deepEqual(mergeAgentRef(base, {}), base, '空 override 等于 base');
  assert.equal(mergeAgentRef(empty, { model: '' }).model, '', '显式空模型能清掉 base 的值');
});

test('sessionRef：会话三件套原样转成 ref', () => {
  const session = {
    id: asSessionId('s1'),
    taskId: asTaskId('t1'),
    agentId: asAgentId('pi'),
    model: 'm1',
    options: { effort: 'high' }
  };
  assert.deepEqual(sessionRef(session), { runtime: 'pi', model: 'm1', options: { effort: 'high' } });
  assert.deepEqual(sessionRef({ agentId: asAgentId('x'), model: '', options: {} }), { runtime: 'x', model: '', options: {} });
});
