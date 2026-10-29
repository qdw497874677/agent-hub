import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endedFromStopReason, mapAcpUpdate } from './map-acp.ts';
import { acpDescriptor } from './config.ts';
import { mapAcpOptions } from './map-options.ts';

const toolNames = new Map<string, string>();

const FIXTURE: { readonly given: unknown; readonly expect: unknown[] }[] = [
  {
    given: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '先读文件' } },
    expect: [{ kind: 'text', delta: '先读文件' }]
  },
  {
    given: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一想' } },
    expect: [{ kind: 'thinking', delta: '想一想' }]
  },
  {
    given: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read src/a.ts', kind: 'read', rawInput: { path: 'src/a.ts' } },
    expect: [{ kind: 'tool_call', name: 'Read src/a.ts', input: '{"path":"src/a.ts"}' }]
  },
  {
    given: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' },
    expect: []
  },
  {
    given: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
    expect: [{ kind: 'tool_result', name: 'Read src/a.ts', ok: true, durationMs: 0 }]
  },
  {
    given: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      status: 'failed',
      rawOutput: { path: '/tmp/out.md' }
    },
    expect: [
      { kind: 'tool_result', name: 'tool', ok: false, durationMs: 0, output: '{"path":"/tmp/out.md"}' },
      { kind: 'artifact', path: '/tmp/out.md', bytes: 0 }
    ]
  }
];

for (const [index, step] of FIXTURE.entries()) {
  test(`OpenCode conformance #${index + 1}`, () => {
    assert.deepEqual(mapAcpUpdate(step.given, toolNames), step.expect);
  });
}

test('OpenCode 停止原因映射', () => {
  assert.deepEqual(endedFromStopReason('cancelled'), { kind: 'ended', outcome: 'stopped' });
  assert.deepEqual(endedFromStopReason('end_turn'), { kind: 'ended', outcome: 'done' });
});

// 可调项：ACP 的 ConfigOption → RuntimeOption，含分组与未认识的 category。
test('acp: 可调项照抄 ACP 的形状，不认识的 category 收进 custom', () => {
  const options = mapAcpOptions([
    {
      configId: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'a',
      options: [
        { value: 'a', name: 'Model A' },
        { groupId: 'g1', name: '来自 provider X', options: [{ value: 'b', name: 'Model B' }] }
      ]
    },
    { configId: 'brave_mode', name: 'Brave', type: 'boolean', currentValue: false },
    { configId: 'weird', name: 'Weird', category: '_custom', type: 'select', currentValue: 'x' }
  ]);

  assert.equal(options.length, 3);
  assert.deepEqual(options.map((option) => option.category), ['model', 'custom', 'custom']);
  assert.equal(options[0]?.choices.length, 2);
  assert.equal(options[0]?.choices[1]?.kind, 'group');
  assert.equal(options[1]?.kind, 'boolean');
  assert.equal(options[1]?.current, false);
});

test('acp: 模型清单从 model 选项投影出来，不是另写一份', () => {
  const descriptor = acpDescriptor(
    { id: 'opencode', label: 'OpenCode', command: 'opencode', args: ['acp'] },
    mapAcpOptions([
      {
        configId: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'b',
        options: [
          { value: 'a', name: 'A' },
          { value: 'b', name: 'B' }
        ]
      }
    ])
  );
  assert.deepEqual(descriptor.models, ['a', 'b']);
  assert.equal(descriptor.defaultModel, 'b');
});
