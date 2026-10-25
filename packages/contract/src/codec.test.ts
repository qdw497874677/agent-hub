import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITY_NAMES, asAgentId, available, capabilityMatrix, limited, type AgentDescriptor } from '@agent-hub/domain';
import { agentFromDto, agentToDto } from './codec.ts';
import { agentSchema } from './wire.ts';

const descriptor: AgentDescriptor = {
  id: asAgentId('grok'),
  label: 'Grok',
  capabilities: capabilityMatrix({
    ...Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, available])),
    fork: limited('只能从头分叉')
  } as Parameters<typeof capabilityMatrix>[0]),
  models: ['grok-4', 'grok-4-fast'],
  defaultModel: 'grok-4',
  options: [
    {
      id: 'model',
      label: '模型',
      category: 'model',
      kind: 'select',
      current: 'grok-4',
      choices: [
        { kind: 'value', value: { value: 'grok-4', label: 'Grok 4' } },
        { kind: 'group', label: '快速', values: [{ value: 'grok-4-fast', label: 'Grok 4 Fast', description: '便宜' }] }
      ]
    },
    { id: 'yolo', label: '免确认', category: 'custom', kind: 'boolean', current: true, choices: [] }
  ]
};

test('AgentDescriptor → 线上 JSON → AgentDescriptor 往返无损', () => {
  const wire = JSON.parse(JSON.stringify(agentToDto(descriptor)));
  const parsed = agentSchema.parse(wire);
  assert.deepEqual(agentFromDto(parsed), descriptor);
});

test('还原时走 domain 的能力构造器：limited 缺原因会被拒', () => {
  const dto = agentToDto(descriptor);
  const broken = { ...dto, capabilities: { ...dto.capabilities, fork: { state: 'limited' as const } } };
  assert.throws(() => agentFromDto(broken));
});
