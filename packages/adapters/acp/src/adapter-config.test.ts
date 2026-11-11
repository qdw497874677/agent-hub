import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACP_AGENT_DEFAULTS, acpDescriptor } from './config.ts';
import { acpAgents } from './adapter.ts';

test('ACP_AGENTS：自定义运行时别名保留 command/env/models/defaultModel/optionOverrides', () => {
  const raw = JSON.stringify([
    {
      id: 'claude-work',
      label: 'Claude (work)',
      command: 'claude-code-acp',
      args: ['--profile', 'work'],
      env: { ANTHROPIC_API_KEY: 'sk-test', EMPTY: 1 },
      models: ['claude-sonnet-4-5', 'claude-opus-4-1'],
      defaultModel: 'claude-sonnet-4-5',
      optionOverrides: { mode: { category: 'agent', label: 'Agent' } }
    }
  ]);
  const agents = acpAgents(raw);
  assert.equal(agents.length, 1);
  const alias = agents[0]!;
  assert.equal(alias.id, 'claude-work');
  assert.equal(alias.label, 'Claude (work)');
  assert.deepEqual(alias.args, ['--profile', 'work']);
  assert.deepEqual(alias.env, { ANTHROPIC_API_KEY: 'sk-test' });
  assert.deepEqual(alias.models, ['claude-sonnet-4-5', 'claude-opus-4-1']);
  assert.equal(alias.defaultModel, 'claude-sonnet-4-5');
  assert.deepEqual(alias.optionOverrides, { mode: { category: 'agent', label: 'Agent' } });
});

test('ACP_AGENTS：非法 JSON 回退默认，缺 command 的条目跳过', () => {
  assert.deepEqual(acpAgents('{'), ACP_AGENT_DEFAULTS);
  assert.deepEqual(acpAgents(JSON.stringify([{ id: 'no-command' }])), ACP_AGENT_DEFAULTS);
});

test('acpDescriptor：别名声明 defaultModel 时优先用它', () => {
  const descriptor = acpDescriptor(
    { ...ACP_AGENT_DEFAULTS[0]!, id: 'alias', defaultModel: 'alias/default' },
    [],
    ['alias/other']
  );
  assert.equal(descriptor.defaultModel, 'alias/default');
  assert.deepEqual(descriptor.models, ['alias/other']);
});
