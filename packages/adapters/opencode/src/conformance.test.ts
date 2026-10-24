import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endedFromStopReason, mapAcpUpdate } from './map-acp.ts';

const toolNames = new Map<string, string>();

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
      { kind: 'tool_result', name: 'tool', ok: false, durationMs: 0 },
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
