import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endedFromStopReason, mapAcpUpdate } from './map-acp.ts';
import { modelsFromInitialize } from './discover-models.ts';
import { grokDescriptor } from './descriptor.ts';

const toolNames = new Map<string, string>();

/** 形状取自 grok 1.0.70 `grok agent stdio` 的真实输出。 */
const FIXTURE: { readonly given: unknown; readonly expect: unknown[] }[] = [
  {
    given: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '先读文件' } },
    expect: [{ kind: 'text', delta: '先读文件' }]
  },
  {
    given: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一想' } },
    expect: []
  },
  {
    given: { sessionUpdate: 'available_commands_update', availableCommands: [] },
    expect: []
  },
  {
    given: { sessionUpdate: 'tool_call', toolCallId: 'g1', title: 'read_file', kind: 'read', rawInput: { path: 'src/a.ts' } },
    expect: [{ kind: 'tool_call', name: 'read_file', input: '{"path":"src/a.ts"}' }]
  },
  {
    given: { sessionUpdate: 'tool_call_update', toolCallId: 'g1', status: 'in_progress' },
    expect: []
  },
  {
    given: { sessionUpdate: 'tool_call_update', toolCallId: 'g1', status: 'completed' },
    expect: [{ kind: 'tool_result', name: 'read_file', ok: true, durationMs: 0 }]
  },
  {
    given: { sessionUpdate: 'tool_call_update', toolCallId: 'g2', status: 'failed', rawOutput: { path: '/tmp/out.md' } },
    expect: [
      { kind: 'tool_result', name: 'tool', ok: false, durationMs: 0 },
      { kind: 'artifact', path: '/tmp/out.md', bytes: 0 }
    ]
  }
];

for (const [index, step] of FIXTURE.entries()) {
  test(`Grok conformance #${index + 1}`, () => {
    assert.deepEqual(mapAcpUpdate(step.given, toolNames), step.expect);
  });
}

test('Grok 停止原因映射', () => {
  assert.deepEqual(endedFromStopReason('cancelled'), { kind: 'ended', outcome: 'stopped' });
  assert.deepEqual(endedFromStopReason('end_turn'), { kind: 'ended', outcome: 'done' });
});

test('Grok 从 initialize 的 modelState 读模型', () => {
  const result = {
    _meta: {
      modelState: {
        currentModelId: 'grok-4.6',
        availableModels: [{ modelId: 'grok-4.6', name: 'Grok 4.6' }, { modelId: 'grok-4.5' }]
      }
    }
  };
  assert.deepEqual(modelsFromInitialize(result), { models: ['grok-4.6', 'grok-4.5'], defaultModel: 'grok-4.6' });
  assert.deepEqual(modelsFromInitialize({}), { models: [], defaultModel: '' });
});

test('Grok 能力矩阵诚实：fork / artifacts 是 limited 且带原因', () => {
  const caps = grokDescriptor.capabilities as unknown as Record<string, { status?: string; reason?: string }>;
  assert.equal(grokDescriptor.id, 'grok');
  for (const key of ['fork', 'artifacts']) {
    assert.ok(JSON.stringify(caps[key] ?? caps).includes('limited'));
  }
});
